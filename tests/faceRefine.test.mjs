// Run: node tests/faceRefine.test.mjs
// Pure checks on a synthetic face (no three.js). The live mesh, morph targets and skin retint are
// exercised in the browser; see guides/FACE_REFINE.md "Verifying".

import { measureFace, planFaceRefine, warpPoint, applyPlan, retintSkin, srgbToLinear } from '../docs/lib/face/FaceRefine.js';
import { FACE_REFERENCE } from '../docs/lib/face/faceReference.js';

let passed = 0, failed = 0;
const test = ( name, fn ) => { try { fn(); passed ++; console.log( '  ✓ ' + name ); } catch ( e ) { failed ++; console.log( '  ✗ ' + name + '\n      ' + e.message ); } };
const ok = ( v, m ) => { if ( ! v ) throw new Error( m || 'expected truthy' ); };
const near = ( a, b, tol, m ) => { if ( Math.abs( a - b ) > tol ) throw new Error( `${ m || 'not near' }: ${ a } vs ${ b }` ); };

// A VRoid-sized face: front is -z, eyes at y 1.61, chin at 1.50, 0.174 m wide.
function buildFace() {

	const pos = [];
	const add = ( x, y, z ) => { pos.push( x, y, z ); return pos.length / 3 - 1; };
	const sets = { skin: [], iris: [], white: [], mouth: [] };

	for ( let x = - 0.087; x <= 0.0871; x += 0.0058 ) for ( let y = 1.5; y <= 1.7; y += 0.005 ) {

		// a gentle nose ridge down the midline
		sets.skin.push( add( x, y, - 0.066 - 0.032 * Math.exp( - ( ( x / 0.012 ) ** 2 + ( ( y - 1.575 ) / 0.012 ) ** 2 ) ) ) );

	}
	// the face piece wraps round toward the ears, so its z range straddles the eye plane
	for ( const x of [ - 0.08, 0, 0.08 ] ) sets.skin.push( add( x, 1.62, 0.025 ) );

	for ( const sgn of [ 1, - 1 ] ) {

		for ( let i = 0; i < 12; i ++ ) {

			const a = i / 12 * Math.PI * 2;
			sets.white.push( add( sgn * 0.044 + 0.024 * Math.cos( a ), 1.61 + 0.012 * Math.sin( a ), - 0.057 ) );

		}
		sets.iris.push( add( sgn * 0.043, 1.611, - 0.061 ) );

	}
	for ( let i = 0; i < 12; i ++ ) sets.mouth.push( add( - 0.0275 + i * 0.005, 1.545, - 0.057 ) );

	return { positions: new Float32Array( pos ), sets };

}

console.log( 'face refine' );

const face = buildFace();

test( 'measures the face in the reference\'s units', () => {

	const m = measureFace( face.positions, face.sets );
	near( m.front, - 1, 0, 'front' );
	near( m.W, 0.174, 0.004, 'W' );
	near( m.E, 0.111, 0.002, 'E' );
	near( m.eyeSeparationW, 0.088 / m.W, 0.01, 'eye separation' );
	ok( m.dz( m.chinY + 0.649 * m.E ) > 0.1, 'nose ridge reads as in front of the eye plane' );

} );

test( 'strength 0 moves nothing', () => {

	const m = measureFace( face.positions, face.sets );
	const out = new Float32Array( face.positions.length );
	near( applyPlan( planFaceRefine( m, FACE_REFERENCE, 0 ), face.positions, out ), 0, 1e-9 );

} );

test( 'strength 1 reaches the reference eye width, eye spacing and mouth width', () => {

	const m = measureFace( face.positions, face.sets );
	const out = new Float32Array( face.positions.length );
	applyPlan( planFaceRefine( m, FACE_REFERENCE, 1 ), face.positions, out );
	const m2 = measureFace( out, face.sets );
	near( m2.eyeWidthW, FACE_REFERENCE.eyeWidthW, 0.012, 'eye width' );
	near( m2.eyeSeparationW, FACE_REFERENCE.eyeSeparationW, 0.012, 'eye separation' );
	near( m2.mouth.widthW, FACE_REFERENCE.mouthWidthW, 0.012, 'mouth width' );

} );

test( 'the warp is local: the head outline and the top of the head do not move', () => {

	const m = measureFace( face.positions, face.sets );
	const plan = planFaceRefine( m, FACE_REFERENCE, 1 );
	for ( const [ x, y, z ] of [ [ 0.087, 1.61, 0 ], [ - 0.087, 1.55, 0 ], [ 0, 1.7, - 0.08 ], [ 0.08, 1.68, - 0.04 ] ] ) {

		const d = warpPoint( plan, x, y, z );
		ok( Math.hypot( ...d ) < 5e-4, `moved ${ Math.hypot( ...d ) } at ${ x },${ y }` );

	}

} );

test( 'the warp is smooth and small (no vertex jumps more than a centimetre)', () => {

	const m = measureFace( face.positions, face.sets );
	const out = new Float32Array( face.positions.length );
	ok( applyPlan( planFaceRefine( m, FACE_REFERENCE, 1 ), face.positions, out ) < 0.02 );

} );

test( 'eye openness and jaw width follow the reference, within their limits', () => {

	const m = measureFace( face.positions, face.sets );
	const out = new Float32Array( face.positions.length );
	const ref = { ...FACE_REFERENCE, eyeOpenness: 0.45, jawWidthW: 0.7, jawT: 0.25 };
	applyPlan( planFaceRefine( m, ref, 1 ), face.positions, out );
	const m2 = measureFace( out, face.sets );
	ok( m2.eyes[ 0 ].height < m.eyes[ 0 ].height * 0.95, 'the eye was not made less tall' );
	const before = m.widthAt( m.chinY + 0.25 * m.E ), after = m2.widthAt( m2.chinY + 0.25 * m2.E );
	ok( Math.abs( after / m.W - 0.7 ) < Math.abs( before / m.W - 0.7 ) || before / m.W >= 0.7 - 0.01, 'jaw moved away from the reference' );
	ok( after / before <= 1.13 && after / before >= 0.89, 'jaw change beyond its limits: ' + after / before );

} );

test( 'retintSkin: strength 0 keeps the render, 1 hits the target', () => {

	const tex = [ 250, 232, 219 ], tint = [ 0.65, 0.4, 0.27 ];
	const t0 = retintSkin( tex, tint, [ 230, 176, 148 ], 0 );
	t0.forEach( ( v, i ) => near( v, tint[ i ], 1e-6 ) );
	const t1 = retintSkin( tex, tint, [ 230, 176, 148 ], 1 );
	// rendered = texture × tint, back in sRGB
	t1.forEach( ( v, i ) => near( srgbToLinear( [ 230, 176, 148 ][ i ] ), srgbToLinear( tex[ i ] ) * v, 1e-4 ) );

} );

console.log( `${ passed } passed, ${ failed } failed` );
process.exit( failed ? 1 : 0 );
