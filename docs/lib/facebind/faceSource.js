// Reads the *metadata* of a face-blendshape GLB (autorigger output: a standalone face mesh with N
// morph targets, no skeleton). Only the JSON chunk is used: morph count, morph names, a skin-tone
// hint and, when made from a photo, hair / iris / brow color hints and the measured face proportions. The face mesh's vertices, morph deltas and texture are never read, and nothing
// here touches the network: this module has no fetch / XHR / WebSocket.

import { parseGLB, GLBError } from './glb.js';

// The autorigger names its morphs by bare index at the mesh level (the semantic names are on the primitive). If a
// file of the autorigger's own structure (see matchesAutorigger42) has only the index names, this order (the shared
// sample's) is assumed. It is a convention, not a guarantee, so the bind is flagged `convention` and the caller is
// warned. Any other index-only file is `unresolved`.
export const CONVENTION_42 = [
	'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
	'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeSquintLeft', 'eyeSquintRight',
	'eyeWideLeft', 'eyeWideRight', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
	'jawOpen', 'jawForward', 'jawLeft', 'jawRight', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
	'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
	'mouthLowerDownLeft', 'mouthLowerDownRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
	'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

export const CONVENTION_WARNING = 'The morphs are named by index only. They were mapped with the autorigger\'s standard 42-morph order because the file has that tool\'s structure. If this file was made by anything else the expressions will be wrong: check them, or pass explicit names.';

/**
 * The structural signature of the face-to-blendshape-3d autorigger's output: a 478-vertex face mesh node named
 * `faceMesh` with its `faceWidth` / `faceHeight` / `aspectRatio` extras, 42 morphs whose mesh-level names are exactly
 * '0'..'41', exported by three.js. Anything else with index-only morphs is not assumed to share its order.
 */
export function matchesAutorigger42( json, best ) {

	const names = best.mesh.extras && best.mesh.extras.targetNames;
	const indexOnly = Array.isArray( names ) && names.length === 42 && names.every( ( n, i ) => String( n ) === String( i ) );
	const node = ( json.nodes || [] ).find( n => n.mesh === best.mi );
	const ex = node && node.extras;
	const verts = json.accessors && best.prim.attributes && json.accessors[ best.prim.attributes.POSITION ] && json.accessors[ best.prim.attributes.POSITION ].count;
	return !! ( indexOnly && node && node.name === 'faceMesh' && ex && typeof ex.faceWidth === 'number' && typeof ex.faceHeight === 'number' && typeof ex.aspectRatio === 'number' && verts === 478
		&& /three/i.test( ( json.asset && json.asset.generator ) || '' ) );

}

const isIndexName = ( s, i ) => typeof s !== 'string' || s.trim() === '' || /^\d+$/.test( s.trim() ) || s === `morph_${ i }`;

/**
 * @param {ArrayBuffer|Uint8Array} input local bytes of the face GLB
 * @param {{ names?: string[] }} [opts] explicit names (override the file's)
 * @returns {{ count:number, names:(string|null)[], resolution:string, warnings:string[], skinColor:{r:number,g:number,b:number}|null, hair:{color:{r:number,g:number,b:number}, coverage:number|null}|null }}
 */
export function readFaceSource( input, opts = {} ) {

	const { json } = parseGLB( input );
	const warnings = [];

	// the face mesh is the one with the most morph targets
	let best = null;
	( json.meshes || [] ).forEach( ( mesh, mi ) => mesh.primitives.forEach( ( prim, pi ) => {

		const n = ( prim.targets || [] ).length;
		if ( n && ( ! best || n > best.count ) ) best = { mesh, prim, count: n, mi, pi };

	} ) );
	if ( ! best ) throw new GLBError( 'NO_MORPHS', 'the face GLB has no morph targets' );

	const { count } = best;
	const lists = [
		[ 'explicit names', opts.names ],
		[ 'primitive.extras.targetNames', best.prim.extras && best.prim.extras.targetNames ],
		[ 'mesh.extras.targetNames', best.mesh.extras && best.mesh.extras.targetNames ],
	];

	let names = null, resolution = null;
	for ( const [ label, list ] of lists ) {

		if ( Array.isArray( list ) && list.length === count && ! list.every( ( s, i ) => isIndexName( s, i ) ) ) { names = list.map( ( s, i ) => isIndexName( s, i ) ? null : s ); resolution = label; break; }

	}

	// The assumed order is applied ONLY to the autorigger's own output (its structural signature), never to any other
	// index-only file with 42 morphs: a different tool's order would map to plausible but wrong expressions.
	if ( ! names && count === CONVENTION_42.length && matchesAutorigger42( json, best ) ) {

		names = CONVENTION_42.slice();
		resolution = 'convention';
		warnings.push( CONVENTION_WARNING );

	}
	if ( ! names ) {

		names = new Array( count ).fill( null );
		resolution = 'unresolved';
		warnings.push( count === CONVENTION_42.length
			? 'The 42 morphs are named by index only and the file is not recognized as the autorigger\'s output, so their order is unknown and none were mapped. Pass explicit names to bind them.'
			: `The ${ count } morphs are named by index only and match no known order, so none can be mapped. Pass explicit names to bind them.` );

	}

	const color = c => c && [ c.r, c.g, c.b ].every( v => typeof v === 'number' ) ? { r: c.r, g: c.g, b: c.b } : null;
	let skinColor = null, hair = null, irisColor = null, browColor = null, proportions = null, hairShape = null, hairTexture = null;
	for ( const node of json.nodes || [] ) {

		const ex = node.extras;
		if ( ! ex ) continue;
		if ( ! skinColor ) skinColor = color( ex.skinColor );
		if ( ! irisColor ) irisColor = color( ex.irisColor );
		if ( ! browColor ) browColor = color( ex.browColor );
		if ( ! hairShape && ex.hairShape && typeof ex.hairShape === 'object' ) hairShape = ex.hairShape;
		if ( ! hairTexture && ex.hairTexture && typeof ex.hairTexture.kind === 'string' ) hairTexture = ex.hairTexture;
		if ( ! proportions && ex.faceProportions && typeof ex.faceProportions.eyeSeparationW === 'number' ) proportions = ex.faceProportions;
		if ( ! hair && color( ex.hairColor ) ) hair = { color: color( ex.hairColor ), coverage: typeof ex.hairCoverage === 'number' ? ex.hairCoverage : null };

	}

	return { count, names, resolution, warnings, skinColor, hair, irisColor, browColor, proportions, hairShape, hairTexture };

}
