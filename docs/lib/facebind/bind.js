// Bind a face-blendshape GLB's morphs to a base VRM's expression blendshapes.
//
//   bindVRM( vrmBytes, faceBytes, opts? ) -> { bytes, bind, report }
//
// Rig-safe: the VRM's skeleton, skin weights, morph deltas, textures and body are never touched, and no byte of
// the binary chunk changes except (optionally) the POSITION, NORMAL and TANGENT of the face's and hair's own vertices. The only things written are
//   · an `extensions.STRATA_face_bind` block (a weight map: face morph -> the VRM's own morph targets),
//   · optionally, a reshape of the face's and the hair's base positions toward the photo's measurements, and
//   · optionally, tints on the skin / hair / iris / brow materials toward colors read from the photo.
// A face morph with no matching VRM target is skipped and listed; nothing is synthesised. The face GLB's mesh
// is never copied into the VRM, and the hairstyle is only scaled, not replaced. The reshape and tints are
// approximate: this is expression binding with a photo-informed look, not a likeness guarantee. The hair
// reshape scales and shifts the VRM's existing hairstyle (volume, height, length, fringe); it cannot change the cut.
//
// Pure and deterministic (no clock, no randomness, no network): same inputs + options -> same bytes.

import { parseGLB, writeGLB, GLBError } from './glb.js';
import { readFaceSource } from './faceSource.js';
import { MIN_HAIR_COVERAGE } from './hair.js';
import { CUTS, TEXTURES } from './hairStyle.js';
import { reshapeVRM, assertBinOnlyChanged } from './reshape.js';
import { FACE_REFERENCE } from '../face/faceReference.js';
import { retintSkin, linearToSrgb, srgbToLinear } from '../face/FaceRefine.js';

export const BIND_EXTENSION = 'STRATA_face_bind';
export const SCOPE = 'expression-bound; optional photo-informed face proportions and colors are approximate; not a likeness guarantee';

export const ARKIT_52 = [
	'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
	'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
	'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
	'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft',
	'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower',
	'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
	'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];
const ARKIT_BY_LOWER = new Map( ARKIT_52.map( n => [ n.toLowerCase(), n ] ) );

export class BindError extends GLBError {}

const isVRM = json => !! ( json.extensions && ( json.extensions.VRM || json.extensions.VRMC_vrm ) );

// every morph target of the VRM, by name: name -> [{ mesh, morph, name }]
function vrmMorphIndex( json ) {

	const byName = new Map();
	( json.meshes || [] ).forEach( ( mesh, mi ) => {

		const prim = ( mesh.primitives || [] ).find( p => p.targets && p.targets.length );
		if ( ! prim ) return;
		const names = ( mesh.extras && mesh.extras.targetNames ) || ( prim.extras && prim.extras.targetNames );
		if ( ! Array.isArray( names ) ) return;
		names.forEach( ( name, morph ) => {

			if ( morph >= prim.targets.length ) return;
			if ( ! byName.has( name ) ) byName.set( name, [] );
			byName.get( name ).push( { mesh: mi, morph, name } );

		} );

	} );
	return byName;

}

/** Build the weight map. Exported for tests and for tools that only want the map. */
export function buildBinding( source, vrmJson ) {

	if ( ! isVRM( vrmJson ) ) throw new BindError( 'NOT_VRM', 'the base is not a VRM (no VRM / VRMC_vrm extension)' );
	const byName = vrmMorphIndex( vrmJson );
	if ( ! byName.size ) throw new BindError( 'VRM_NO_MORPHS', 'the base VRM has no named morph targets to bind to' );
	const byLower = new Map( [ ...byName.keys() ].map( n => [ n.toLowerCase(), n ] ) );

	const map = [], unmapped = [];
	source.names.forEach( ( raw, source_ ) => {

		if ( raw === null ) { unmapped.push( { source: source_, name: null, reason: 'unnamed morph (index only)' } ); return; }
		const semantic = ARKIT_BY_LOWER.get( raw.toLowerCase() ) || raw;
		const vrmName = byName.has( semantic ) ? semantic : byLower.get( semantic.toLowerCase() );
		if ( ! vrmName ) { unmapped.push( { source: source_, name: semantic, reason: 'the VRM has no morph target with this name' } ); return; }
		map.push( { source: source_, name: semantic, targets: byName.get( vrmName ).map( ( { mesh, morph, name } ) => ( { mesh, morph, name } ) ), weight: 1 } );

	} );

	const driven = new Set( map.flatMap( m => m.targets.map( t => t.name ) ) );
	const undriven = ARKIT_52.filter( n => byName.has( n ) && ! driven.has( n ) );

	return {
		version: 1,
		scope: SCOPE,
		source: { morphCount: source.count, nameResolution: source.resolution, names: source.names },
		// how the names were resolved, if that was not certain: consumers (facerig, mocap, the preview) must show these
		warnings: source.resolution === 'primitive.extras.targetNames' || source.resolution === 'mesh.extras.targetNames' || source.resolution === 'explicit names' ? [] : source.warnings.slice(),
		map,
		unmapped,
		undriven,
	};

}

// ── optional look transfer (rig-safe material tints) ────────────────────────

const FACE_SKIN = /_Face_\d+_SKIN$/;
const ROLES = { skin: /_SKIN$/, hair: /_HAIR$/, iris: /_EyeIris_/, brow: /_FaceBrow_/ };

function materialIndices( json, role ) {

	return ( json.materials || [] ).map( ( m, i ) => [ m, i ] ).filter( ( [ m ] ) => ROLES[ role ].test( m.name || '' ) && m.pbrMetallicRoughness ).map( ( [ , i ] ) => i );

}

/**
 * The base-color texture of every skin / hair material, so a caller can decode them (on device) and pass each
 * one's mean color back as opts.look.textureMeans[materialIndex].
 * @returns {{ index:number, name:string, role:string, bytes:Uint8Array, mime:string }[]}
 */
export function lookTexturesOf( input ) {

	const { json, chunks } = parseGLB( input );
	const bin = chunks.find( c => c.type === 0x004e4942 );
	const out = [];
	for ( const role of Object.keys( ROLES ) ) for ( const mi of materialIndices( json, role ) ) {

		const tex = json.materials[ mi ].pbrMetallicRoughness.baseColorTexture;
		const img = tex && json.images && json.images[ ( json.textures[ tex.index ] || {} ).source ];
		if ( ! img || img.bufferView === undefined || ! bin ) continue;
		const bv = json.bufferViews[ img.bufferView ];
		out.push( { index: mi, name: json.materials[ mi ].name, role, bytes: bin.data.subarray( bv.byteOffset || 0, ( bv.byteOffset || 0 ) + bv.byteLength ), mime: img.mimeType } );

	}
	return out;

}

const lin = srgbToLinear;

// New color for a material so that texture × color renders `strength` of the way to `target` (sRGB 0–255).
// Returns the linear multiplier, and whether the target was out of reach (a multiplier can only darken).
function retint( textureMean, current, target, strength ) {

	const next = retintSkin( textureMean, current, target, strength ).map( v => +v.toFixed( 5 ) );
	const goal = textureMean.map( ( t, c ) => linearToSrgb( lin( t ) * current[ c ] ) + ( target[ c ] - linearToSrgb( lin( t ) * current[ c ] ) ) * strength );
	const reached = next.every( ( v, c ) => Math.abs( linearToSrgb( lin( textureMean[ c ] ) * v ) - goal[ c ] ) < 6 );
	return { next, reached };

}

function setMaterialColor( json, mi, next, report ) {

	const pbr = json.materials[ mi ].pbrMetallicRoughness;
	const old = pbr.baseColorFactor || [ 1, 1, 1, 1 ];
	const a = old[ 3 ] === undefined ? 1 : old[ 3 ];
	pbr.baseColorFactor = [ next[ 0 ], next[ 1 ], next[ 2 ], a ];

	// MToon's shaded side is its own color, not multiplied by the base color: scale it by the same ratio
	// so the shadow side follows the tint instead of staying the old color.
	const ratio = next.map( ( v, c ) => old[ c ] > 1e-4 ? v / old[ c ] : 1 );
	const vrm0 = json.extensions.VRM && json.extensions.VRM.materialProperties && json.extensions.VRM.materialProperties[ mi ];
	if ( vrm0 && vrm0.vectorProperties ) {

		const v = vrm0.vectorProperties; // VRM 0.x keeps these in sRGB
		if ( v._Color ) v._Color = [ ...next.map( x => +( linearToSrgb( x ) / 255 ).toFixed( 5 ) ), v._Color[ 3 ] === undefined ? 1 : v._Color[ 3 ] ];
		if ( v._ShadeColor ) v._ShadeColor = [ ...v._ShadeColor.slice( 0, 3 ).map( ( x, c ) => +( linearToSrgb( Math.min( 1, lin( x * 255 ) * ratio[ c ] ) ) / 255 ).toFixed( 5 ) ), v._ShadeColor[ 3 ] === undefined ? 1 : v._ShadeColor[ 3 ] ];

	}
	const mtoon = json.materials[ mi ].extensions && json.materials[ mi ].extensions.VRMC_materials_mtoon;
	if ( mtoon && mtoon.shadeColorFactor ) mtoon.shadeColorFactor = mtoon.shadeColorFactor.map( ( x, c ) => +Math.min( 1, x * ratio[ c ] ).toFixed( 5 ) );

}

function applyLook( json, source, look, report ) {

	const strength = look.strength === undefined ? 0.7 : look.strength;
	const means = look.textureMeans || {};
	const applied = [];
	const jobs = [];

	if ( look.skin ) {

		if ( source.skinColor ) jobs.push( [ 'skin', [ source.skinColor.r, source.skinColor.g, source.skinColor.b ].map( v => v * 255 ) ] );
		else report.warnings.push( 'Skin tint skipped: the face GLB has no skin-color hint.' );

	}
	if ( look.hair ) {

		if ( ! source.hair ) report.warnings.push( 'Hair color skipped: the face GLB has no hair-color hint (it was not made from a photo, or no hair model was available).' );
		else if ( source.hair.coverage !== null && source.hair.coverage < MIN_HAIR_COVERAGE ) report.warnings.push( 'Hair color skipped: little or no hair was detected in the photo. The VRM hair is unchanged.' );
		else jobs.push( [ 'hair', [ source.hair.color.r, source.hair.color.g, source.hair.color.b ].map( v => v * 255 ) ] );

	}
	for ( const [ role, color, label ] of [ [ 'iris', source.irisColor, 'Eye color' ], [ 'brow', source.browColor, 'Brow color' ] ] ) {

		if ( ! look[ role ] ) continue;
		if ( color ) jobs.push( [ role, [ color.r, color.g, color.b ].map( v => v * 255 ) ] );
		else report.warnings.push( `${ label } skipped: the face GLB has no ${ role } color hint (it was not made from a photo).` );

	}

	// The body takes the face's skin tone: the face is tinted toward the photo (at `strength`), then every other skin material (the body, the hands,
	// the neck) is tinted so that it renders the same color as the face does now, whatever its own texture is. A tint can only darken, so a body
	// texture that is darker than the face cannot be made lighter (reported as not reached).
	let faceRendered = null;
	for ( const [ role, target ] of jobs ) {

		const mats = materialIndices( json, role );
		if ( role === 'skin' ) mats.sort( ( a, b ) => FACE_SKIN.test( json.materials[ b ].name || '' ) - FACE_SKIN.test( json.materials[ a ].name || '' ) ); // the face first
		for ( const mi of mats ) {

			const mean = means[ mi ];
			if ( ! mean ) { report.warnings.push( `${ role } color skipped for ${ json.materials[ mi ].name }: its texture mean was not supplied.` ); continue; }
			const old = ( json.materials[ mi ].pbrMetallicRoughness.baseColorFactor || [ 1, 1, 1, 1 ] ).slice( 0, 3 );
			const isFace = role === 'skin' && FACE_SKIN.test( json.materials[ mi ].name || '' );
			const matchFace = role === 'skin' && ! isFace && faceRendered;
			const { next, reached } = retint( mean, old, matchFace ? faceRendered : target, matchFace ? 1 : strength );
			setMaterialColor( json, mi, next, report );
			if ( isFace ) faceRendered = mean.map( ( t, c ) => linearToSrgb( lin( t ) * next[ c ] ) );
			applied.push( { material: json.materials[ mi ].name, role, target: ( matchFace ? faceRendered : target ).map( Math.round ), reached, ...( matchFace ? { matchedToFace: true } : {} ) } );

		}

	}
	report.look = applied.length ? { approximate: true, strength, applied } : null;
	if ( applied.some( a => ! a.reached ) ) report.warnings.push( 'Some colors could not be fully reached: a tint can only darken the texture, so a lighter color than the texture is as close as it gets.' );

}

// ── optional texture edits (the painted facial hair, a hair texture fix) ───────

const PNG_SIGNATURE = [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ];

/**
 * Swaps the image behind a material's base-color texture for new PNG bytes. The new bytes are appended to the end of the binary
 * chunk and the image points at them, so no existing byte moves (the old image stays, unused). Nothing but images[i].bufferView,
 * a new bufferView entry and the buffer length changes, which the rig audit allows for exactly these images.
 * @param {{ materialIndex:number, png:Uint8Array, label?:string }[]} textures
 * @returns {{ images:number[], firstNewBufferView:number }}
 */
function replaceImages( vrm, textures, report ) {

	const json = vrm.json, bin = vrm.chunks.find( c => c.type === 0x004e4942 );
	if ( ! bin ) throw new BindError( 'NO_BIN', 'the VRM has no binary chunk to put a texture in' );
	const firstNewBufferView = json.bufferViews.length, images = [], parts = [];
	let offset = Math.ceil( bin.data.length / 4 ) * 4;
	const start = offset;
	for ( const t of textures ) {

		const mat = json.materials && json.materials[ t.materialIndex ];
		if ( mat && /_CLOTH$/.test( mat.name || '' ) ) throw new BindError( 'OUTFIT_UNTOUCHED', `refusing to edit the texture of ${ mat.name }: facebind never changes the outfit` );
		const tex = mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture;
		const src = tex && json.textures && ( json.textures[ tex.index ] || {} ).source;
		if ( src === undefined || ! json.images[ src ] ) { report.warnings.push( `Texture edit skipped for material ${ t.materialIndex }: it has no base-color image.` ); continue; }
		if ( ! ( t.png instanceof Uint8Array ) || PNG_SIGNATURE.some( ( v, i ) => t.png[ i ] !== v ) ) throw new BindError( 'BAD_TEXTURE', 'a texture edit must be PNG bytes' );
		if ( images.includes( src ) ) continue;
		json.bufferViews.push( { buffer: 0, byteOffset: offset, byteLength: t.png.length } );
		json.images[ src ].bufferView = json.bufferViews.length - 1;
		json.images[ src ].mimeType = 'image/png';
		parts.push( [ offset, t.png ] );
		images.push( src );
		offset += Math.ceil( t.png.length / 4 ) * 4;

	}
	if ( ! parts.length ) return { images, firstNewBufferView };
	const grown = new Uint8Array( offset );
	grown.set( bin.data );
	for ( const [ at, bytes ] of parts ) grown.set( bytes, at );
	bin.data = grown;
	if ( json.buffers && json.buffers[ 0 ] ) json.buffers[ 0 ].byteLength = offset;
	return { images, firstNewBufferView, appendedFrom: start };

}

// ── optional: no hair (bald) ──────────────────────────────────────────────────

const isHairPrim = ( json, p ) => p.material !== undefined && /_HAIR$/.test( ( json.materials[ p.material ] || {} ).name || '' );

/**
 * Takes the hair out of the VRM: nodes whose mesh is all hair lose their mesh (and skin), and a hair primitive that shares a mesh with other parts (the
 * VRoid back hair sits on the body mesh) is dropped from that mesh's primitive list. No byte of the binary chunk and no bone changes, so the rig, the spring bones and the
 * body are untouched; the skin of the head under the hair is already there (the VRoid face mesh is the whole head).
 * @returns {{ nodes:number[], meshes:number[], primitives:number }} what was changed, for the audit
 */
function removeHair( json, report ) {

	const nodes = [], meshes = [];
	let primitives = 0;
	( json.nodes || [] ).forEach( ( n, i ) => {

		if ( n.mesh === undefined ) return;
		const prims = json.meshes[ n.mesh ].primitives;
		if ( prims.length && prims.every( p => isHairPrim( json, p ) ) ) { primitives += prims.length; delete n.mesh; delete n.skin; delete n.weights; nodes.push( i ); }

	} );
	( json.meshes || [] ).forEach( ( m, i ) => {

		if ( ! m.primitives.some( p => isHairPrim( json, p ) ) || m.primitives.every( p => isHairPrim( json, p ) ) ) return;
		const kept = m.primitives.filter( p => ! isHairPrim( json, p ) );
		primitives += m.primitives.length - kept.length;
		m.primitives = kept; meshes.push( i );

	} );
	if ( ! primitives ) report.warnings.push( 'No hair meshes were found to remove.' );
	report.hairRemoved = { removed: true, primitives };
	return { nodes, meshes, primitives };

}

// ── rig-safety audit ────────────────────────────────────────────────────────

function diffPaths( a, b, path = '', out = [] ) {

	if ( a === b ) return out;
	if ( a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray( a ) !== Array.isArray( b ) ) { out.push( path ); return out; }
	for ( const k of new Set( [ ...Object.keys( a ), ...Object.keys( b ) ] ) ) diffPaths( a[ k ], b[ k ], `${ path }/${ k }`, out );
	return out;

}

const ALLOWED_CHANGE = [
	/^\/extensions\/STRATA_face_bind($|\/)/,
	/^\/extensionsUsed($|\/)/,
	/^\/materials\/\d+\/pbrMetallicRoughness\/baseColorFactor($|\/)/,
	/^\/materials\/\d+\/extensions\/VRMC_materials_mtoon\/shadeColorFactor($|\/)/,
	/^\/extensions\/VRM\/materialProperties\/\d+\/vectorProperties\/(_Color|_ShadeColor)($|\/)/,
];

/**
 * Throws unless the only differences are the bind block, extensionsUsed, look-transfer material colors and
 * (when the face was reshaped) the bounds of the face POSITION accessors.
 * @param {{ accessors?: number[], textures?: { images: number[], firstNewBufferView: number } }} [shape] position accessors that a reshape rewrote, and the images a texture edit replaced
 */
export function assertRigSafe( before, after, shape = {} ) {

	const allowed = [ ...ALLOWED_CHANGE, ...( shape.accessors || [] ).map( i => new RegExp( `^/accessors/${ i }/(min|max)($|/)` ) ) ];
	// bald: hair-only nodes lose their mesh and skin, mixed meshes lose their hair primitives
	if ( shape.bald ) {

		for ( const i of shape.bald.nodes ) allowed.push( new RegExp( `^/nodes/${ i }/(mesh|skin|weights)$` ) );
		for ( const i of shape.bald.meshes ) allowed.push( new RegExp( `^/meshes/${ i }/primitives($|/)` ) );

	}
	// a texture edit: the edited images point at new bufferViews appended after the old ones, and the buffer grew
	const tex = shape.textures;
	if ( tex && tex.images.length ) {

		for ( const i of tex.images ) allowed.push( new RegExp( `^/images/${ i }/(bufferView|mimeType)$` ) );
		for ( let k = tex.firstNewBufferView; k < tex.firstNewBufferView + tex.images.length; k ++ ) allowed.push( new RegExp( `^/bufferViews/${ k }($|/)` ) );
		allowed.push( /^\/buffers\/0\/byteLength$/ );

	}
	const bad = diffPaths( before, after ).filter( p => ! allowed.some( re => re.test( p ) ) );
	if ( bad.length ) throw new BindError( 'RIG_UNSAFE', `refusing to write: the bind would change ${ bad.slice( 0, 5 ).join( ', ' ) }` );

}

/**
 * @param {ArrayBuffer|Uint8Array} vrmInput base VRM bytes
 * @param {ArrayBuffer|Uint8Array} faceInput LOCAL face-blendshape GLB bytes (never a URL)
 * @param {{ names?: string[], shape?: { strength?: number, reference?: object }, hairShape?: { strength?: number, hug?: number, reference?: object }, bald?: boolean, hairStyle?: { cut?: 'photo'|'keep'|'crop'|'bob'|'long'|'afro', texture?: 'auto'|'straight'|'wavy'|'curly'|'coily' }, textures?: { materialIndex: number, png: Uint8Array, label?: string }[], look?: { skin?: boolean, hair?: boolean, strength?: number, textureMeans?: Object<number, number[]> } }} [opts]
 *   look = optional, approximate material tints (skin / hair color). textureMeans[materialIndex] = the mean sRGB color (0–255)
 *   of that material's base texture, from lookTexturesOf().
 */
export function bindVRM( vrmInput, faceInput, opts = {} ) {

	const vrm = parseGLB( vrmInput );
	const before = JSON.parse( JSON.stringify( vrm.json ) );
	const source = readFaceSource( faceInput, { names: opts.names } );

	const bind = buildBinding( source, vrm.json );
	const report = {
		scope: SCOPE,
		sourceMorphs: source.count,
		nameResolution: source.resolution,
		mapped: bind.map.length,
		unmapped: bind.unmapped,
		undriven: bind.undriven,
		warnings: [ ...source.warnings ],
		look: null,
		shape: null,
		hairShape: null,
		hairStyle: null,
		textures: null,
		hairRemoved: null,
		normals: null,
		egress: 'none: the face GLB was read from local bytes only; nothing derived from it left this process',
	};

	const origBin = ( vrm.chunks.find( c => c.type === 0x004e4942 ) || {} ).data;
	let reshaped = null;
	if ( opts.bald && ( opts.hairShape || opts.hairStyle ) ) report.warnings.push( 'Hair shape and style skipped: the hair is removed.' );
	if ( opts.shape || ( ! opts.bald && ( opts.hairShape || opts.hairStyle ) ) ) {

		const what = {};
		if ( opts.shape ) {

			const strength = opts.shape.strength === undefined ? 0.7 : opts.shape.strength;
			const p = source.proportions;
			const reference = opts.shape.reference || ( p ? { ...FACE_REFERENCE, ...p, depth: p.depth || null } : null );
			if ( ! reference ) report.warnings.push( 'Face shape skipped: the face GLB carries no measured proportions (it was not made from a photo).' );
			else {

				if ( p && ! p.depth ) report.warnings.push( 'Profile depth (nose, lips, chin) skipped: the head in the photo is turned too far to read it.' );
				what.face = { reference, strength };

			}

		}
		const style = opts.hairStyle || {};
		const cutName = style.cut || 'photo';
		if ( cutName !== 'photo' && cutName !== 'keep' && ! CUTS[ cutName ] ) throw new GLBError( 'BAD_HAIR_STYLE', `unknown hair cut "${ cutName }"` );
		if ( style.texture && style.texture !== 'auto' && ! ( style.texture in TEXTURES ) ) throw new GLBError( 'BAD_HAIR_STYLE', `unknown hair texture "${ style.texture }"` );
		const preset = CUTS[ cutName ] || null;

		// texture: explicit, else what the photo shows (an estimate), else straight; an afro cut implies coily
		let texture = style.texture && style.texture !== 'auto' ? style.texture : null, textureSource = texture ? 'chosen' : null;
		if ( ! texture && preset && preset.texture ) { texture = preset.texture; textureSource = 'cut'; }
		// on short hair (it ends above the ear line) the texture estimate mostly reads the cut hairs and the scalp, so it is not trusted
		const shortHair = source.hairShape && typeof source.hairShape.lengthV === 'number' && source.hairShape.lengthV > 0;
		if ( ! texture && source.hairTexture && source.hairTexture.kind in TEXTURES && ! shortHair ) { texture = source.hairTexture.kind; textureSource = 'photo'; }
		texture = texture || 'straight';
		const wantStyle = texture !== 'straight' || !! preset;
		if ( textureSource === 'photo' && texture !== 'straight' ) report.warnings.push( `Hair texture "${ texture }" was estimated from the photo (approximate, not calibrated). Pick a texture by hand if it is wrong.` );

		if ( opts.hairStyle && ! opts.bald ) report.hairStyle = { approximate: true, cut: cutName, texture, textureSource: textureSource || 'default', detected: source.hairTexture || null, cards: null };
		if ( ! opts.bald && ( opts.hairShape || wantStyle ) ) {

			const strength = opts.hairShape && opts.hairShape.strength !== undefined ? opts.hairShape.strength : 0.7;
			let ref = null, limits = null;
			if ( preset ) { ref = preset.ref; limits = preset.limits; }
			else if ( cutName === 'photo' && opts.hairShape ) {

				ref = opts.hairShape.reference || source.hairShape;
				if ( ! ref ) report.warnings.push( 'Hair shape skipped: the face GLB carries no hair measurements (it was not made from a photo, or no hair was found).' );
				else if ( [ ref.topV, ref.widthW, ref.lengthV, ref.hairlineV ].every( v => v === null || v === undefined ) && ! ( ref.profile && Object.values( ref.profile ).some( a => a.some( v => v !== null ) ) ) ) {

					report.warnings.push( 'Hair shape skipped: the photo crops the hair on every side, so its size cannot be measured. Use a photo that shows the whole head.' );
					ref = null;

				} else {

					const cut = ref.cropped ? Object.entries( ref.cropped ).filter( ( [ , v ] ) => v ).map( ( [ k ] ) => k ) : [];
					if ( cut.length ) report.warnings.push( `Part of the hair shape was skipped because the photo crops the hair (${ cut.join( ', ' ) }).` );

				}

			}
			if ( ref || wantStyle ) what.hair = { reference: ref, strength: preset ? Math.max( strength, 0.9 ) : strength, texture, limits, hug: opts.hairShape ? opts.hairShape.hug : undefined };

		}
		if ( what.face || what.hair ) {

			reshaped = reshapeVRM( vrm, what );
			if ( reshaped.face ) report.shape = { approximate: true, strength: what.face.strength, maxMoveMm: +( reshaped.face.maxMove * 1000 ).toFixed( 1 ), vrmBefore: reshaped.face.measured, photo: what.face.reference };
			report.normals = reshaped.normals;
			if ( reshaped.hair && report.hairStyle ) report.hairStyle.cards = reshaped.hair.style.cards;
			if ( reshaped.hair && what.hair.reference && cutName === 'photo' ) report.hairShape = { approximate: true, strength: what.hair.strength, maxMoveMm: +( reshaped.hair.maxMove * 1000 ).toFixed( 1 ), vrmBefore: reshaped.hair.measured, photo: what.hair.reference, applied: reshaped.hair.plan };

		}

	}

	vrm.json.extensions[ BIND_EXTENSION ] = bind;
	vrm.json.extensionsUsed = [ ...new Set( [ ...( vrm.json.extensionsUsed || [] ), BIND_EXTENSION ] ) ];
	if ( opts.look ) applyLook( vrm.json, source, opts.bald ? { ...opts.look, hair: false } : opts.look, report );
	const bald = opts.bald ? removeHair( vrm.json, report ) : null;

	let textures = null;
	if ( opts.textures && opts.textures.length ) {

		textures = replaceImages( vrm, opts.textures, report );
		report.textures = opts.textures.filter( t => t.label ).map( t => t.label );

	}
	assertRigSafe( before, vrm.json, { ...( reshaped || {} ), textures, bald } );
	if ( reshaped || textures ) assertBinOnlyChanged( origBin, vrm.chunks.find( c => c.type === 0x004e4942 ).data, reshaped ? reshaped.ranges : [] );
	return { bytes: writeGLB( vrm ), bind, report };

}
