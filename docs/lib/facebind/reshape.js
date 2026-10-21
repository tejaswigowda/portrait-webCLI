// Reshape a VRoid-style VRM toward measurements taken from a photo, by editing base POSITION data in the
// file's binary chunk:
//   · face: eyes, mouth, jaw and the nose / lips / chin profile (FaceRefine.js)
//   · hair: volume, height, length and fringe of the existing hairstyle (hairShape.js)
//
// What is touched: the POSITION of the face and hair vertices, and the NORMAL (and TANGENT, if present) of exactly
// those same vertices, plus those accessors' min/max. The body vertices that share an accessor with the back hair
// are left alone. What is not: indices, UVs, other vertices' attributes, the 100+ morph targets (deltas, so every
// existing blendshape keeps working on the new base, and their normal deltas are relative), skeleton, skin weights,
// textures, body.
//
// Normals are not recomputed from the triangles (that would flatten the artist's hard edges and seams, which are
// split vertices). Each warped vertex's own normal is carried through the warp with the inverse transpose of the
// warp's Jacobian, the correct transform for a normal, so seams stay and shading follows the new surface.
// bindVRM() audits that, byte for byte, before it writes anything.

import { measureFace, planFaceRefine, warpPoint } from '../face/FaceRefine.js';
import { measureHair, planHair, warpHairPoint, summarizePlan } from './hairShape.js';
import { buildSkull, thicknessAt, hugScalp, hugWeight } from './scalp.js';
import { cardsOf, relayCards, widenCards, carryNormal, TEXTURES } from './hairStyle.js';
import { GLBError } from './glb.js';

const FACE_MATERIAL = /_(FaceMouth|EyeIris|EyeHighlight|EyeWhite|FaceBrow|FaceEyelash|FaceEyeline|Face)_\d+_(FACE|EYE|SKIN)/;
const HAIR_MATERIAL = /_HAIR$/;
const NECK_PIN = 0.3, NECK_FADE = 0.45; // eye-to-chin heights above the rim of the face mesh: not moved, then faded in
const INNER_HAIR = /_HairBack_/; // the layer of hair under the strands: lifted less than the strands, so it shows at the hairline
const PARTS = [ [ 'iris', /_EyeIris_/ ], [ 'white', /_EyeWhite_/ ], [ 'mouth', /_FaceMouth_/ ], [ 'skin', /_Face_\d+_SKIN/ ] ];
const BIN = 0x004e4942;

function viewOf( json, accessorIndex ) {

	const a = json.accessors[ accessorIndex ];
	const bv = json.bufferViews[ a.bufferView ];
	return { a, bv, start: ( bv.byteOffset || 0 ) + ( a.byteOffset || 0 ) };

}

function readIndices( json, bin, accessorIndex ) {

	const { a, start } = viewOf( json, accessorIndex );
	const size = { 5121: 1, 5123: 2, 5125: 4 }[ a.componentType ];
	if ( ! size ) throw new GLBError( 'UNSUPPORTED', 'unsupported index type' );
	const dv = new DataView( bin.data.buffer, bin.data.byteOffset + start, a.count * size );
	const out = new Uint32Array( a.count );
	for ( let i = 0; i < a.count; i ++ ) out[ i ] = size === 2 ? dv.getUint16( i * 2, true ) : size === 4 ? dv.getUint32( i * 4, true ) : dv.getUint8( i );
	return out;

}

function readPositions( json, bin, accessorIndex ) {

	const { a, bv, start } = viewOf( json, accessorIndex );
	if ( a.componentType !== 5126 || a.type !== 'VEC3' ) throw new GLBError( 'UNSUPPORTED', 'POSITION is not float32 vec3' );
	if ( bv.byteStride && bv.byteStride !== 12 ) throw new GLBError( 'UNSUPPORTED', 'interleaved POSITION data is not supported' );
	const dv = new DataView( bin.data.buffer, bin.data.byteOffset );
	const out = new Float32Array( a.count * 3 );
	for ( let i = 0; i < out.length; i ++ ) out[ i ] = dv.getFloat32( start + i * 4, true );
	return out;

}

// merge consecutive vertex indices into byte ranges
function rangesOf( start, ids, stride = 12, size = 12 ) {

	const sorted = [ ...ids ].sort( ( p, q ) => p - q ), out = [];
	for ( const i of sorted ) {

		const s = start + i * stride, last = out[ out.length - 1 ];
		if ( last && last.end === s ) last.end = s + size; else out.push( { start: s, end: s + size } );

	}
	return out;

}

// Jacobian of p -> p + d(p), by central differences (h = 0.2 mm)
function jacobian( warp, x, y, z ) {

	const h = 2e-4, J = [ [ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ] ];
	const axes = [ [ h, 0, 0 ], [ 0, h, 0 ], [ 0, 0, h ] ];
	for ( let c = 0; c < 3; c ++ ) {

		const a = warp( x + axes[ c ][ 0 ], y + axes[ c ][ 1 ], z + axes[ c ][ 2 ] ), b = warp( x - axes[ c ][ 0 ], y - axes[ c ][ 1 ], z - axes[ c ][ 2 ] );
		for ( let r = 0; r < 3; r ++ ) J[ r ][ c ] += ( a[ r ] - b[ r ] ) / ( 2 * h );

	}
	return J;

}

const det3 = J => J[ 0 ][ 0 ] * ( J[ 1 ][ 1 ] * J[ 2 ][ 2 ] - J[ 1 ][ 2 ] * J[ 2 ][ 1 ] ) - J[ 0 ][ 1 ] * ( J[ 1 ][ 0 ] * J[ 2 ][ 2 ] - J[ 1 ][ 2 ] * J[ 2 ][ 0 ] ) + J[ 0 ][ 2 ] * ( J[ 1 ][ 0 ] * J[ 2 ][ 1 ] - J[ 1 ][ 1 ] * J[ 2 ][ 0 ] );

// cofactor matrix: det(J) * inverse-transpose(J), so n' ~ cof(J) n for a surface normal under the map J (for det > 0)
function cofactor( J ) {

	const c = ( r0, c0, r1, c1 ) => J[ r0 ][ c0 ] * J[ r1 ][ c1 ] - J[ r0 ][ c1 ] * J[ r1 ][ c0 ];
	return [
		[ c( 1, 1, 2, 2 ), - c( 1, 0, 2, 2 ), c( 1, 0, 2, 1 ) ],
		[ - c( 0, 1, 2, 2 ), c( 0, 0, 2, 2 ), - c( 0, 0, 2, 1 ) ],
		[ c( 0, 1, 1, 2 ), - c( 0, 0, 1, 2 ), c( 0, 0, 1, 1 ) ],
	];

}

const mulv = ( M, v ) => [ M[ 0 ][ 0 ] * v[ 0 ] + M[ 0 ][ 1 ] * v[ 1 ] + M[ 0 ][ 2 ] * v[ 2 ], M[ 1 ][ 0 ] * v[ 0 ] + M[ 1 ][ 1 ] * v[ 1 ] + M[ 1 ][ 2 ] * v[ 2 ], M[ 2 ][ 0 ] * v[ 0 ] + M[ 2 ][ 1 ] * v[ 1 ] + M[ 2 ][ 2 ] * v[ 2 ] ];
const unit = v => { const l = Math.hypot( ...v ); return l > 1e-12 ? v.map( c => c / l ) : null; };

/**
 * Carry the NORMAL (and TANGENT) of the moved vertices through the warp. Returns the byte ranges written and how many
 * vertices changed. Only vertices whose attribute actually changes are written.
 */
function transformAttributes( json, bin, prims, job ) {

	const { accessor, ids, warp, positions, pre, minCos = 0.35 } = job;
	const out = new DataView( bin.data.buffer, bin.data.byteOffset );
	const ranges = [], touched = [];
	let changed = 0, maxAngle = 0;

	const attrs = new Map(); // attribute accessor -> 'NORMAL' | 'TANGENT'
	for ( const { p } of prims ) {

		if ( p.attributes.POSITION !== accessor ) continue;
		for ( const k of [ 'NORMAL', 'TANGENT' ] ) if ( p.attributes[ k ] !== undefined ) attrs.set( p.attributes[ k ], k );

	}

	for ( const [ idx, kind ] of attrs ) {

		const { a, bv, start } = viewOf( json, idx );
		const comps = kind === 'NORMAL' ? 3 : 4, stride = bv.byteStride || comps * 4;
		if ( a.componentType !== 5126 || a.count !== json.accessors[ accessor ].count || stride !== comps * 4 ) continue; // not the float, tight layout this handles: left as it is
		const writtenIds = [];
		for ( const i of ids ) {

			const x = positions[ i * 3 ], y = positions[ i * 3 + 1 ], z = positions[ i * 3 + 2 ];
			const J = jacobian( job.warpFor ? ( a, b, c ) => job.warpFor( i, a, b, c ) : warp, x, y, z );
			const det = det3( J );
			if ( ! ( det > 0.1 ) ) continue; // a vertex the warp folds flat: keep its normal
			const o = start + i * stride;
			let v = [ out.getFloat32( o, true ), out.getFloat32( o + 4, true ), out.getFloat32( o + 8, true ) ];
			const v0 = v;
			if ( pre && kind === 'NORMAL' ) v = pre( i, v ); // the hair style's own rotation of the normal, before the warp's
			const t = unit( kind === 'NORMAL' ? mulv( cofactor( J ), v ) : mulv( J, v ) );
			if ( ! t ) continue;
			const before = unit( v0 );
			const cos = before ? before[ 0 ] * t[ 0 ] + before[ 1 ] * t[ 1 ] + before[ 2 ] * t[ 2 ] : 1;
			if ( cos < minCos ) continue; // too big a change to be believable: keep the original
			if ( Math.abs( t[ 0 ] - v0[ 0 ] ) + Math.abs( t[ 1 ] - v0[ 1 ] ) + Math.abs( t[ 2 ] - v0[ 2 ] ) < 1e-3 ) continue; // under ~0.06 degrees: not worth a write
			out.setFloat32( o, t[ 0 ], true ); out.setFloat32( o + 4, t[ 1 ], true ); out.setFloat32( o + 8, t[ 2 ], true );
			maxAngle = Math.max( maxAngle, Math.acos( Math.min( 1, cos ) ) * 180 / Math.PI );
			writtenIds.push( i ); changed ++;

		}
		if ( writtenIds.length ) {

			if ( a.min || a.max ) { // keep any declared bounds true
				const mn = [ Infinity, Infinity, Infinity ], mx = [ - Infinity, - Infinity, - Infinity ];
				for ( let i = 0; i < a.count; i ++ ) for ( let c = 0; c < 3; c ++ ) { const v = out.getFloat32( start + i * stride + c * 4, true ); mn[ c ] = Math.min( mn[ c ], v ); mx[ c ] = Math.max( mx[ c ], v ); }
				if ( a.min ) a.min = a.min.length === 3 ? mn : [ ...mn, a.min[ 3 ] ]; if ( a.max ) a.max = a.max.length === 3 ? mx : [ ...mx, a.max[ 3 ] ];
			}
			for ( const r of rangesOf( start, writtenIds, stride, comps * 4 ) ) ranges.push( r );
			touched.push( idx );

		}

	}
	return { ranges, touched, changed, maxAngle };

}

/**
 * @param {{ json: object, chunks: {type:number,data:Uint8Array}[] }} vrm parsed VRM; its BIN chunk is replaced by an edited copy
 * @param {{ face?: { reference: object, strength: number }, hair?: { reference: object, strength: number } }} what
 * @returns {{ ranges: {start:number,end:number}[], accessors: number[], face: object|null, hair: object|null }}
 */
export function reshapeVRM( vrm, { face = null, hair = null } ) {

	const { json } = vrm;
	const binIndex = vrm.chunks.findIndex( c => c.type === BIN );
	if ( binIndex < 0 ) throw new GLBError( 'UNSUPPORTED', 'the VRM has no binary chunk' );
	const bin = { type: BIN, data: vrm.chunks[ binIndex ].data.slice() }; // never edit the caller's bytes

	const prims = [];
	( json.meshes || [] ).forEach( mesh => mesh.primitives.forEach( p => {

		const name = p.material !== undefined && json.materials[ p.material ] ? json.materials[ p.material ].name || '' : '';
		if ( p.attributes && p.attributes.POSITION !== undefined && p.indices !== undefined ) prims.push( { p, name } );

	} ) );
	const facePrims = prims.filter( q => FACE_MATERIAL.test( q.name ) );
	if ( ! facePrims.length ) throw new GLBError( 'NO_FACE_MESH', 'no VRoid-style face meshes found in the VRM' );

	// ── face measurement (also the frame the hair is measured in) ──
	const faceAccessors = [ ...new Set( facePrims.map( q => q.p.attributes.POSITION ) ) ];
	const main = faceAccessors.reduce( ( best, i ) => json.accessors[ i ].count > json.accessors[ best ].count ? i : best, faceAccessors[ 0 ] );
	const facePositions = readPositions( json, bin, main );
	const sets = { skin: [], iris: [], white: [], mouth: [] };
	for ( const { p, name } of facePrims.filter( q => q.p.attributes.POSITION === main ) ) {

		const part = PARTS.find( ( [ , re ] ) => re.test( name ) );
		if ( ! part ) continue;
		const verts = [ ...new Set( readIndices( json, bin, p.indices ) ) ];
		if ( part[ 0 ] === 'skin' ) { if ( verts.length > sets.skin.length ) sets.skin = verts; } else sets[ part[ 0 ] ].push( ...verts );

	}
	const m = measureFace( facePositions, sets );

	let skullPositions = facePositions; // the head as it is after the face reshape, for the hair to sit on
	const modified = new Map(); // accessor -> { positions, ids }
	const jobs = []; // vertices whose NORMAL / TANGENT must follow their position
	const result = { face: null, hair: null };

	// ── face ──
	if ( face ) {

		const plan = planFaceRefine( m, face.reference, face.strength );
		let maxMove = 0;
		// The neck. The bottom of the face mesh is an open tube that sits on the neck of the body mesh, which does not move. If the jaw, the chin or the
		// mouth corners moved there, the tube would pull away from the neck and open a gap into the head. So the lowest part of the face does not move at all
		// (the bottom NECK_PIN of the eye-to-chin height above the rim of the mesh) and the warp comes in smoothly over the next NECK_FADE. The chin
		// tip and the jaw angle sit above that, so they still move, a little less near their bottom edge.
		let rimY = Infinity;
		for ( let i = 1; i < facePositions.length; i += 3 ) if ( facePositions[ i ] < rimY ) rimY = facePositions[ i ];
		const seam = ( x, y, z ) => { const t = Math.min( 1, Math.max( 0, ( y - rimY - NECK_PIN * m.E ) / ( NECK_FADE * m.E ) ) ); return t * t * ( 3 - 2 * t ); };
		const warpFace = ( x, y, z ) => { const w = seam( x, y, z ), d = warpPoint( plan, x, y, z ); return [ d[ 0 ] * w, d[ 1 ] * w, d[ 2 ] * w ]; };
		const moved = new Float32Array( facePositions.length );
		for ( let i = 0; i < facePositions.length; i += 3 ) {

			const [ dx, dy, dz ] = warpFace( facePositions[ i ], facePositions[ i + 1 ], facePositions[ i + 2 ] );
			moved[ i ] = facePositions[ i ] + dx; moved[ i + 1 ] = facePositions[ i + 1 ] + dy; moved[ i + 2 ] = facePositions[ i + 2 ] + dz;
			maxMove = Math.max( maxMove, Math.hypot( dx, dy, dz ) );

		}
		skullPositions = moved;
		const count = json.accessors[ main ].count;
		for ( const idx of faceAccessors ) if ( json.accessors[ idx ].count === count ) {

			const ids = Array.from( { length: count }, ( _, i ) => i );
			modified.set( idx, { positions: moved, ids } );
			jobs.push( { accessor: idx, ids, positions: facePositions, warp: warpFace } );

		}
		result.face = {
			maxMove,
			measured: {
				eyeSeparationW: m.eyeSeparationW, eyeWidthW: m.eyeWidthW, eyeOpenness: m.eyeOpenness, mouthWidthW: m.mouth.widthW,
				jawWidthW: face.reference.jawWidthW ? m.widthAt( m.chinY + ( face.reference.jawT || 0.25 ) * m.E ) / m.W : null,
			},
		};

	}

	// ── hair ──
	if ( hair ) {

		const byAccessor = new Map(), triLists = new Map(), innerOf = new Map();
		for ( const { p, name } of prims.filter( q => HAIR_MATERIAL.test( q.name ) ) ) {

			const a = p.attributes.POSITION;
			if ( ! byAccessor.has( a ) ) { byAccessor.set( a, new Set() ); triLists.set( a, [] ); innerOf.set( a, new Set() ); }
			const idx = readIndices( json, bin, p.indices );
			if ( INNER_HAIR.test( name ) ) for ( const i of idx ) innerOf.get( a ).add( i ); // the back-hair layer under the strands
			for ( const i of idx ) byAccessor.get( a ).add( i );
			triLists.get( a ).push( idx );

		}
		if ( ! byAccessor.size ) throw new GLBError( 'NO_HAIR_MESH', 'no hair meshes found in the VRM' );

		// 1. the style: re-lay the locks (wavy / curly / coily). The silhouette is then measured on the re-laid hair.
		const store = new Map(), tangents = new Map();
		let cardCount = 0;
		for ( const [ a, ids ] of byAccessor ) {

			const src = readPositions( json, bin, a );
			const cards = cardsOf( triLists.get( a ) );
			const styled = hair.texture && hair.texture !== 'straight';
			const wide = styled ? widenCards( src, cards, TEXTURES[ hair.texture ].widen ) : src;
			const relaid = styled ? relayCards( wide, cards, m, hair.texture ) : null;
			store.set( a, relaid ? relaid.positions : src );
			if ( relaid ) { tangents.set( a, relaid.tangents ); cardCount += cards.filter( c => c.length >= 12 ).length; }

		}
		const flat = [];
		for ( const [ a, ids ] of byAccessor ) for ( const i of ids ) flat.push( store.get( a )[ i * 3 ], store.get( a )[ i * 3 + 1 ], store.get( a )[ i * 3 + 2 ] );
		const hp = Float32Array.from( flat );
		const cur = measureHair( hp, Array.from( { length: hp.length / 3 }, ( _, i ) => i ), m );

		// 2. the silhouette (volume, height, length, fringe) toward the photo or a cut preset
		const plan = planHair( cur, hair.reference || {}, m, hair.strength, hair.limits || {} );
		// 3. hug the scalp: hair the lift has taken away from the skull is pulled back toward it (see scalp.js)
		const around = [];
		for ( const [ a, ids ] of byAccessor ) for ( const i of ids ) around.push( store.get( a )[ i * 3 ], store.get( a )[ i * 3 + 1 ], store.get( a )[ i * 3 + 2 ] );
		const head = new Float32Array( skullPositions.length + around.length );
		head.set( skullPositions ); head.set( around, skullPositions.length );
		const skull = buildSkull( head, [ 0, m.eyeY + 0.35 * m.E, m.zc ] );
		const hug = hair.hug === undefined ? 0.8 : Math.min( 1, Math.max( 0, hair.hug ) );
		const thickness = new Map();
		for ( const [ a, ids ] of byAccessor ) {

			const mid = store.get( a ), t = new Float32Array( json.accessors[ a ].count );
			for ( const i of ids ) t[ i ] = thicknessAt( skull, mid[ i * 3 ], mid[ i * 3 + 1 ], mid[ i * 3 + 2 ] );
			thickness.set( a, t );

		}
		const warpFor = ( a, inner ) => ( i, x, y, z ) => {

			const w = warpHairPoint( plan, x, y, z, inner.has( i ) );
			const q = [ x + w[ 0 ], y + w[ 1 ], z + w[ 2 ] ];
			const h = hugScalp( skull, q[ 0 ], q[ 1 ], q[ 2 ], thickness.get( a )[ i ] * ( inner.has( i ) ? 0.8 : 1 ), hugWeight( ( q[ 1 ] - m.eyeY ) / m.E ), hug );
			return [ h[ 0 ] - x, h[ 1 ] - y, h[ 2 ] - z ];

		};
		let maxMove = 0;
		for ( const [ a, ids ] of byAccessor ) {

			const mid = store.get( a ), original = readPositions( json, bin, a ), dst = Float32Array.from( mid ), inner = innerOf.get( a ), wf = warpFor( a, inner );
			for ( const i of ids ) {

				const [ dx, dy, dz ] = wf( i, mid[ i * 3 ], mid[ i * 3 + 1 ], mid[ i * 3 + 2 ] );
				dst[ i * 3 ] += dx; dst[ i * 3 + 1 ] += dy; dst[ i * 3 + 2 ] += dz;
				maxMove = Math.max( maxMove, Math.hypot( dst[ i * 3 ] - original[ i * 3 ], dst[ i * 3 + 1 ] - original[ i * 3 + 1 ], dst[ i * 3 + 2 ] - original[ i * 3 + 2 ] ) );

			}
			modified.set( a, { positions: dst, ids: [ ...ids ] } );
			const tg = tangents.get( a );
			jobs.push( {
				accessor: a, ids: [ ...ids ], positions: mid, warp: ( x, y, z ) => warpHairPoint( plan, x, y, z ), warpFor: wf,
				pre: tg ? ( i, n ) => { const t = tg.get( i ); return t ? carryNormal( n, t.from, t.to ) : n; } : null,
				minCos: tg ? - 0.3 : 0.35,
			} );

		}
		result.hair = { maxMove, measured: cur, plan: summarizePlan( plan ), style: { texture: hair.texture || 'straight', cards: cardCount } };

	}

	// ── write back, update bounds ──
	const ranges = [];
	const out = new DataView( bin.data.buffer, bin.data.byteOffset );
	for ( const [ idx, { positions, ids } ] of modified ) {

		const { a, start } = viewOf( json, idx );
		const mn = [ Infinity, Infinity, Infinity ], mx = [ - Infinity, - Infinity, - Infinity ];
		for ( let i = 0; i < positions.length; i ++ ) {

			out.setFloat32( start + i * 4, positions[ i ], true );
			const v = out.getFloat32( start + i * 4, true ), c = i % 3;
			mn[ c ] = Math.min( mn[ c ], v ); mx[ c ] = Math.max( mx[ c ], v );

		}
		a.min = mn; a.max = mx;
		ranges.push( ...rangesOf( start, ids ) );

	}

	// normals / tangents of the same vertices, carried through the same warp
	const normals = { updated: 0, maxAngleDeg: 0 };
	const accessors = [ ...modified.keys() ];
	for ( const job of jobs ) {

		const r = transformAttributes( json, bin, prims, job );
		ranges.push( ...r.ranges ); accessors.push( ...r.touched );
		normals.updated += r.changed; normals.maxAngleDeg = Math.max( normals.maxAngleDeg, r.maxAngle );

	}
	normals.maxAngleDeg = +normals.maxAngleDeg.toFixed( 1 );

	vrm.chunks[ binIndex ] = bin;
	return { ranges, accessors: [ ...new Set( accessors ) ], normals, ...result };

}

/** Throws unless every byte of the binary chunk outside `ranges` is identical. */
export function assertBinOnlyChanged( before, after, ranges ) {

	// the chunk may only grow at the end (an appended texture); nothing before its old end may change except the face and hair vertex data
	if ( after.length < before.length ) throw new GLBError( 'RIG_UNSAFE', 'refusing to write: the binary chunk got smaller' );
	const allowed = new Uint8Array( before.length );
	for ( const r of ranges ) allowed.fill( 1, r.start, r.end );
	for ( let i = 0; i < before.length; i ++ ) if ( before[ i ] !== after[ i ] && ! allowed[ i ] ) throw new GLBError( 'RIG_UNSAFE', `refusing to write: byte ${ i } outside the face / hair vertex data changed` );

}
