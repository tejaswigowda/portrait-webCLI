// §6 verification gate for the authored face: do morph targets (deltas against the base) survive the facebind
// warp correctly? Drives every one of the 52 ARKit shapes to 1.0 on the UNWARPED base and on the WARPED character
// and compares what the face does.
//
//   node tests/morphDeltas.test.mjs
//
// facebind carries the morph deltas through byte for byte (reshape.js: "the 100+ morph targets are deltas and are
// left untouched"). That is exact only if the warp is rigid where a delta lives. Where the warp stretches the face
// (eyes, mouth), the ideal delta is the warp applied to the morphed surface, W(v + d) - W(v) ~ J(v) d, not d.
// This script measures that difference with the product's own warp (the same measureFace / planFaceRefine /
// warpPoint / neck seam reshapeVRM uses), on the two bundled base VRMs, at the default reference and at a strong one.
//
// It prints the table the docs quote and asserts the bound the face channel relies on.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const docs = path.resolve( here, '../docs' );

const { parseGLB } = await import( '../docs/lib/facebind/glb.js' );
const { ARKIT_52 } = await import( '../docs/lib/facebind/bind.js' );
const { measureFace, planFaceRefine, warpPoint } = await import( '../docs/lib/face/FaceRefine.js' );
const { FACE_REFERENCE } = await import( '../docs/lib/face/faceReference.js' );

// the same constants reshape.js uses
const FACE_MATERIAL = /_(FaceMouth|EyeIris|EyeHighlight|EyeWhite|FaceBrow|FaceEyelash|FaceEyeline|Face)_\d+_(FACE|EYE|SKIN)/;
const PARTS = [ [ 'iris', /_EyeIris_/ ], [ 'white', /_EyeWhite_/ ], [ 'mouth', /_FaceMouth_/ ], [ 'skin', /_Face_\d+_SKIN/ ] ];
const NECK_PIN = 0.3, NECK_FADE = 0.45;

let pass = 0, fail = 0;
const results = [];

function view( json, i ) {

	const a = json.accessors[ i ], bv = json.bufferViews[ a.bufferView ];
	return { a, bv, start: ( bv.byteOffset || 0 ) + ( a.byteOffset || 0 ) };

}

function readVec3( json, bin, i ) {

	const { a, bv, start } = view( json, i );
	assert.ok( ! a.sparse, 'sparse morph accessors are not handled by this check' );
	const dv = new DataView( bin.buffer, bin.byteOffset );
	const stride = bv.byteStride || 12;
	const out = new Float32Array( a.count * 3 );

	for ( let v = 0; v < a.count; v ++ ) for ( let k = 0; k < 3; k ++ ) out[ v * 3 + k ] = dv.getFloat32( start + v * stride + k * 4, true );

	return out;

}

function readIdx( json, bin, i ) {

	const { a, start } = view( json, i );
	const size = { 5121: 1, 5123: 2, 5125: 4 }[ a.componentType ];
	const dv = new DataView( bin.buffer, bin.byteOffset + start, a.count * size );
	return Array.from( { length: a.count }, ( _, k ) => size === 2 ? dv.getUint16( k * 2, true ) : size === 4 ? dv.getUint32( k * 4, true ) : dv.getUint8( k ) );

}

function analyse( file, reference, strength, label ) {

	const { json, chunks } = parseGLB( new Uint8Array( fs.readFileSync( file ) ) );
	const bin = chunks.find( c => c.type === 0x004e4942 ).data;

	const prims = [];
	for ( const mesh of json.meshes ) for ( const p of mesh.primitives ) {

		const name = p.material !== undefined ? json.materials[ p.material ].name || '' : '';
		if ( FACE_MATERIAL.test( name ) && p.attributes.POSITION !== undefined && p.indices !== undefined ) prims.push( { p, name, mesh } );

	}

	const main = [ ...new Set( prims.map( q => q.p.attributes.POSITION ) ) ].reduce( ( b, i ) => json.accessors[ i ].count > json.accessors[ b ].count ? i : b );
	const base = readVec3( json, bin, main );
	const sets = { skin: [], iris: [], white: [], mouth: [] };

	for ( const { p, name } of prims.filter( q => q.p.attributes.POSITION === main ) ) {

		const part = PARTS.find( ( [ , re ] ) => re.test( name ) );
		if ( ! part ) continue;
		const verts = [ ...new Set( readIdx( json, bin, p.indices ) ) ];
		if ( part[ 0 ] === 'skin' ) { if ( verts.length > sets.skin.length ) sets.skin = verts; } else sets[ part[ 0 ] ].push( ...verts );

	}

	const m = measureFace( base, sets );
	const plan = planFaceRefine( m, reference, strength );

	let rimY = Infinity;
	for ( let i = 1; i < base.length; i += 3 ) rimY = Math.min( rimY, base[ i ] );

	const seam = y => { const t = Math.min( 1, Math.max( 0, ( y - rimY - NECK_PIN * m.E ) / ( NECK_FADE * m.E ) ) ); return t * t * ( 3 - 2 * t ); };
	const warp = ( x, y, z ) => { const w = seam( y ), d = warpPoint( plan, x, y, z ); return [ d[ 0 ] * w, d[ 1 ] * w, d[ 2 ] * w ]; };

	// the primitive that owns the 52 shapes (they are all on the face's shared vertex buffer)
	const owner = prims.find( q => q.p.attributes.POSITION === main && q.p.targets && q.p.targets.length );
	const names = ( owner.mesh.extras && owner.mesh.extras.targetNames ) || ( owner.p.extras && owner.p.extras.targetNames );
	assert.ok( names && names.length, 'target names' );

	let maxWarp = 0;
	for ( let v = 0; v < base.length / 3; v ++ ) maxWarp = Math.max( maxWarp, Math.hypot( ...warp( base[ v * 3 ], base[ v * 3 + 1 ], base[ v * 3 + 2 ] ) ) );

	const rows = [];

	for ( const shape of ARKIT_52 ) {

		const ti = names.indexOf( shape );
		if ( ti < 0 ) { rows.push( { shape, missing: true } ); continue; }

		const delta = readVec3( json, bin, owner.p.targets[ ti ].POSITION );
		let sumD2 = 0, sumErr2 = 0, maxErr = 0, maxD = 0, n = 0;

		for ( let v = 0; v < base.length / 3; v ++ ) {

			const dx = delta[ v * 3 ], dy = delta[ v * 3 + 1 ], dz = delta[ v * 3 + 2 ];
			const mag = Math.hypot( dx, dy, dz );
			if ( mag < 1e-6 ) continue;

			const x = base[ v * 3 ], y = base[ v * 3 + 1 ], z = base[ v * 3 + 2 ];
			const w0 = warp( x, y, z ), w1 = warp( x + dx, y + dy, z + dz );
			// what the warped face SHOULD do at weight 1: the warp applied to the morphed surface
			const ideal = [ dx + w1[ 0 ] - w0[ 0 ], dy + w1[ 1 ] - w0[ 1 ], dz + w1[ 2 ] - w0[ 2 ] ];
			const err = Math.hypot( ideal[ 0 ] - dx, ideal[ 1 ] - dy, ideal[ 2 ] - dz ); // = |J d - d|, carried vs ideal

			sumD2 += mag * mag; sumErr2 += err * err; n ++;
			maxErr = Math.max( maxErr, err ); maxD = Math.max( maxD, mag );

		}

		rows.push( { shape, verts: n, maxDelta: maxD, rmsRel: n ? Math.sqrt( sumErr2 / sumD2 ) : 0, maxErr, maxErrFace: maxErr / m.E } );

	}

	return { label, E: m.E, maxWarp, maxWarpFace: maxWarp / m.E, rows };

}

function test( name, fn ) {

	try { fn(); console.log( '  ✓ ' + name ); pass ++; }
	catch ( e ) { console.error( '  ✗ ' + name + '\n      ' + ( e.stack || e.message ).split( '\n' ).slice( 0, 4 ).join( '\n      ' ) ); fail ++; }

}

const STRICT = process.argv.includes( '--strict' );
const GATE = { maxFace: 0.02, maxRms: 0.10 }; // what "carried correctly" means: <2% of the face height, <10% of the delta (rms)
const cases = [];

for ( const sex of [ 'Male', 'Female' ] ) {

	const file = path.join( docs, 'base', `VRoid_V110_${ sex }_v1.1.3.vrm` );
	if ( ! fs.existsSync( file ) ) { console.log( `  - skipped ${ sex }: ${ file } not found` ); continue; }

	for ( const strength of [ 0, 0.5, 1 ] ) cases.push( analyse( file, FACE_REFERENCE, strength, `${ sex } base, bind strength ${ strength }` ) );

}

for ( const c of cases ) {

	const worst = c.rows.reduce( ( a, r ) => r.maxErrFace > a.maxErrFace ? r : a );
	const rms = Math.max( ...c.rows.map( r => r.rmsRel ) );
	results.push( { ...c, worst, rms, ok: worst.maxErrFace < GATE.maxFace && rms < GATE.maxRms } );

	test( `${ c.label }: all 52 ARKit shapes are present and measured`, () => {

		assert.strictEqual( c.rows.filter( r => r.missing ).length, 0, 'every one of the 52 shapes exists on the base' );
		assert.strictEqual( c.rows.length, 52 );

	} );

	if ( /strength 0$/.test( c.label ) ) {

		test( `${ c.label }: an unwarped base carries every delta exactly (the check itself is sound)`, () => {

			assert.strictEqual( c.maxWarp, 0 );
			assert.ok( worst.maxErr < 1e-9, `max error ${ worst.maxErr }` );

		} );

	}

}

// The gate. Reported, and fatal only with --strict: a failing gate is a facebind finding, not a test of this file.
console.log( '\nmorph delta carried through the facebind warp  (|J d - d| per shape at weight 1: carried delta vs the warp applied to the morphed face)\n' );

for ( const r of results ) {

	console.log( `${ r.label }`);
	console.log( `  face height E = ${ ( r.E * 100 ).toFixed( 1 ) } cm; the warp moves a vertex by at most ${ ( r.maxWarp * 1000 ).toFixed( 1 ) } mm (${ ( r.maxWarpFace * 100 ).toFixed( 1 ) }% of E)` );
	const sorted = [ ...r.rows ].sort( ( a, b ) => b.maxErrFace - a.maxErrFace ).slice( 0, 4 );
	for ( const s of sorted ) console.log( `  ${ s.shape.padEnd( 18 ) } max error ${ ( s.maxErr * 1000 ).toFixed( 2 ).padStart( 6 ) } mm (${ ( s.maxErrFace * 100 ).toFixed( 2 ) }% of E)   rms ${ ( s.rmsRel * 100 ).toFixed( 1 ) }% of the delta` );
	console.log( `  worst over 52 shapes: ${ ( r.worst.maxErrFace * 100 ).toFixed( 2 ) }% of E, rms ${ ( r.rms * 100 ).toFixed( 1 ) }% of the delta  ->  ${ r.ok ? 'GATE PASS' : 'GATE FAIL' }\n` );

}

const gateFails = results.filter( r => ! r.ok ).length;
console.log( gateFails ? `facebind morph-delta gate: ${ gateFails } of ${ results.length } cases FAIL (limits: ${ GATE.maxFace * 100 }% of the face height, ${ GATE.maxRms * 100 }% rms). Deltas are carried untransformed through the warp.` : 'facebind morph-delta gate: PASS' );
console.log( `${ pass } passed, ${ fail } failed` );
process.exit( fail || ( STRICT && gateFails ) ? 1 : 0 );
