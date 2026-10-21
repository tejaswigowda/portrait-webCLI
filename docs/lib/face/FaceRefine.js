// refineFace( object, opts ): nudge a VRoid-style VRM face toward the proportions in
// faceReference.js (measured on a real-face GLB). It is a smooth, local warp of the face mesh's
// base positions plus a skin-tone retint:
//   · eyes: spacing and size
//   · mouth: width
//   · profile: nose tip, lips and chin depth
// The 100+ morph targets (VRM presets, ARKit shapes) are deltas and are left untouched, so
// every existing blendshape keeps working on the refined base. Hair, body and brows keep their
// outline: the warp falls to zero outside the eye / mouth / midline regions it edits.

import { FACE_REFERENCE } from './faceReference.js';

const clamp = ( v, a, b ) => Math.min( b, Math.max( a, v ) );
const lerp = ( a, b, t ) => a + ( b - a ) * t;
const smooth = t => t * t * ( 3 - 2 * t );

// 1 inside r0, 0 outside r1, smooth in between
function falloff( r, r0, r1 ) {

	if ( r <= r0 ) return 1;
	if ( r >= r1 ) return 0;
	return 1 - smooth( ( r - r0 ) / ( r1 - r0 ) );

}

export function srgbToLinear( c ) {

	c /= 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

}

export function linearToSrgb( c ) {

	c = clamp( c, 0, 1 );
	return 255 * ( c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055 );

}

// Vertex index lists per face part (indices into positions)
function stats( positions, idx, pred = () => true ) {

	const s = { n: 0, cx: 0, cy: 0, cz: 0, minX: Infinity, maxX: - Infinity, minY: Infinity, maxY: - Infinity, minZ: Infinity, maxZ: - Infinity };
	for ( const i of idx ) {

		const x = positions[ i * 3 ], y = positions[ i * 3 + 1 ], z = positions[ i * 3 + 2 ];
		if ( ! pred( x, y, z ) ) continue;
		s.n ++; s.cx += x; s.cy += y; s.cz += z;
		s.minX = Math.min( s.minX, x ); s.maxX = Math.max( s.maxX, x );
		s.minY = Math.min( s.minY, y ); s.maxY = Math.max( s.maxY, y );
		s.minZ = Math.min( s.minZ, z ); s.maxZ = Math.max( s.maxZ, z );

	}
	if ( s.n ) { s.cx /= s.n; s.cy /= s.n; s.cz /= s.n; }
	return s;

}

/**
 * Measure a face from its base positions.
 * @param {Float32Array|number[]} positions xyz triples
 * @param {{skin:number[], iris:number[], white:number[], mouth:number[]}} sets vertex indices per part
 */
export function measureFace( positions, sets ) {

	const skin = stats( positions, sets.skin );
	const iris = stats( positions, sets.iris );
	if ( ! skin.n || ! iris.n || ! sets.white.length || ! sets.mouth.length ) throw new Error( 'refineFace: could not find the face skin, eyes and mouth' );

	const zc = ( skin.minZ + skin.maxZ ) / 2;
	const front = iris.cz < zc ? - 1 : 1; // which z the face looks toward
	const eyeY = iris.cy;
	const chinY = skin.minY;
	const E = eyeY - chinY;

	// head width at eye level; `skin` is the main face piece, so the ears (a separate piece) stay out
	const wide = stats( positions, sets.skin, ( x, y ) => Math.abs( y - eyeY ) < 0.1 * E );
	const W = 2 * Math.max( Math.abs( wide.minX ), Math.abs( wide.maxX ) );

	const eyes = [ 1, - 1 ].map( sgn => {

		const w = stats( positions, sets.white, x => Math.sign( x ) === sgn );
		return { sgn, cx: w.cx, cy: w.cy, width: w.maxX - w.minX, height: w.maxY - w.minY };

	} );

	const mouth = stats( positions, sets.mouth );

	// front-most skin z on the midline (or at x0) around height y0
	const frontZ = ( x0, y0 ) => {

		for ( let k = 1; k <= 8; k *= 2 ) {

			const s = stats( positions, sets.skin, ( x, y ) => Math.abs( x - x0 ) < 0.05 * W * k && Math.abs( y - y0 ) < 0.03 * E * k );
			if ( s.n ) return front < 0 ? s.minZ : s.maxZ;

		}
		return zc;

	};

	// head width at height y0 (the main face piece only, so ears stay out)
	const widthAt = y0 => {

		const s = stats( positions, sets.skin, ( x, y ) => Math.abs( y - y0 ) < 0.04 * E );
		return s.n ? 2 * Math.max( Math.abs( s.minX ), Math.abs( s.maxX ) ) : 0;

	};

	const zRef = ( frontZ( eyes[ 0 ].cx, eyeY ) + frontZ( eyes[ 1 ].cx, eyeY ) ) / 2;
	const dz = y => front * ( frontZ( 0, y ) - zRef ) / W;

	return {
		front, W, E, eyeY, chinY, zRef, zc, eyes,
		eyeSeparationW: ( eyes[ 0 ].cx - eyes[ 1 ].cx ) / W,
		eyeWidthW: ( eyes[ 0 ].width + eyes[ 1 ].width ) / 2 / W,
		eyeOpenness: ( eyes[ 0 ].height + eyes[ 1 ].height ) / ( eyes[ 0 ].width + eyes[ 1 ].width ),
		widthAt,
		mouth: { cy: mouth.cy, width: mouth.maxX - mouth.minX, widthW: ( mouth.maxX - mouth.minX ) / W },
		dz,
	};

}

/** Turn a measurement and the reference into a list of warp regions. strength 0 = no change, 1 = match the reference. */
export function planFaceRefine( m, reference = FACE_REFERENCE, strength = 0.5 ) {

	const s = clamp( strength, 0, 1 );
	const { W, E, front } = m;

	const curEyeW = ( m.eyes[ 0 ].width + m.eyes[ 1 ].width ) / 2, curEyeH = ( m.eyes[ 0 ].height + m.eyes[ 1 ].height ) / 2;
	const eyeScale = clamp( lerp( 1, ( reference.eyeWidthW * W ) / curEyeW, s ), 0.7, 1.3 );
	// eye height follows the reference's openness (visible opening / width) when it has one
	const eyeScaleY = reference.eyeOpenness ? clamp( lerp( 1, ( reference.eyeOpenness * reference.eyeWidthW * W ) / curEyeH, s ), 0.75, 1.25 ) : eyeScale;
	const halfSepMove = s * ( reference.eyeSeparationW - m.eyeSeparationW ) * W / 2; // negative = toward the nose
	const eyes = m.eyes.map( e => ( {
		cx: e.cx, cy: e.cy,
		shiftX: e.sgn * halfSepMove,
		kx: eyeScale, ky: eyeScaleY,
		r0: 0.28 * W, r1: 0.53 * W, outlineFrom: 0.42 * W, outlineSpan: 0.08 * W,
	} ) );

	const mouthScale = clamp( lerp( 1, ( reference.mouthWidthW * W ) / m.mouth.width, s ), 0.7, 1.3 );
	const mouth = { cy: m.mouth.cy, k: mouthScale, rx: 1.1 * m.mouth.width, ry: 0.26 * E };

	// jaw: widen or narrow the lower face about the midline, fading out toward the ears and the neck
	let jaw = null;
	if ( reference.jawWidthW ) {

		const cur = m.widthAt( m.chinY + ( reference.jawT || 0.25 ) * E );
		if ( cur > 0 ) jaw = { k: clamp( lerp( 1, ( reference.jawWidthW * W ) / cur, s ), 0.9, 1.12 ), chinY: m.chinY, E };

	}

	const bumps = [];
	for ( const [ key, ref ] of Object.entries( reference.depth || {} ) ) {

		const y = m.chinY + ref.t * E + ( key === 'chin' ? 0.04 * E : 0 );
		const amount = s * ( ref.dz - m.dz( y ) ) * W; // metres to move forward
		bumps.push( { key, y, amount: front * amount } );

	}

	return { eyes, mouth, jaw, bumps, sigmaX: 0.16 * W, sigmaY: 0.1 * E, strength: s };

}

/** Displacement of one point under a plan. */
export function warpPoint( plan, x, y, z ) {

	let dx = 0, dy = 0, dz = 0;

	for ( const e of plan.eyes ) {

		// The region is squashed vertically (×1.6) so it covers the eye and lid but not brow or mouth.
		// Each eye only pulls on its own side of the nose bridge, and its region ends before the head
		// outline so the face still meets the hair and ears.
		const side = smooth( clamp( Math.sign( e.cx ) * x / ( 0.4 * Math.abs( e.cx ) ), 0, 1 ) );
		const w = side * falloff( Math.hypot( x - e.cx, ( y - e.cy ) * 1.6 ), e.r0, e.r1 ) * ( 1 - smooth( clamp( ( Math.abs( x ) - e.outlineFrom ) / e.outlineSpan, 0, 1 ) ) );
		if ( ! w ) continue;
		dx += w * ( e.shiftX + ( e.kx - 1 ) * ( x - e.cx ) );
		dy += w * ( e.ky - 1 ) * ( y - e.cy );

	}

	const mw = falloff( Math.hypot( x / plan.mouth.rx, ( y - plan.mouth.cy ) / plan.mouth.ry ), 0.55, 1 );
	if ( mw ) dx += mw * ( plan.mouth.k - 1 ) * x;

	if ( plan.jaw ) {

		const t = ( y - plan.jaw.chinY ) / plan.jaw.E;
		const wj = ( 1 - smooth( clamp( ( t - 0.25 ) / 0.2, 0, 1 ) ) ) * smooth( clamp( ( t - 0.03 ) / 0.12, 0, 1 ) );
		if ( wj ) dx += wj * ( plan.jaw.k - 1 ) * x;

	}

	const gx = Math.exp( - 0.5 * ( x / plan.sigmaX ) ** 2 );
	for ( const b of plan.bumps ) dz += b.amount * gx * Math.exp( - 0.5 * ( ( y - b.y ) / plan.sigmaY ) ** 2 );

	return [ dx, dy, dz ];

}

/** Write warped positions from `source` into `target` (same length). Returns the largest move. */
export function applyPlan( plan, source, target ) {

	let max = 0;
	for ( let i = 0; i < source.length; i += 3 ) {

		const [ dx, dy, dz ] = warpPoint( plan, source[ i ], source[ i + 1 ], source[ i + 2 ] );
		target[ i ] = source[ i ] + dx; target[ i + 1 ] = source[ i + 1 ] + dy; target[ i + 2 ] = source[ i + 2 ] + dz;
		max = Math.max( max, Math.hypot( dx, dy, dz ) );

	}
	return max;

}

/**
 * New color multiplier (linear rgb) so that texture × tint renders `strength` of the way from its
 * current color to the target skin color.
 * @param {number[]} textureSRGB mean of the skin texture, 0–255
 * @param {number[]} tintLinear current material color (linear 0–1)
 * @param {number[]} targetSRGB 0–255
 */
export function retintSkin( textureSRGB, tintLinear, targetSRGB, strength = 0.5 ) {

	return textureSRGB.map( ( t, c ) => {

		const tex = Math.max( srgbToLinear( t ), 1e-4 );
		const renderedSrgb = linearToSrgb( tex * tintLinear[ c ] );
		const goalSrgb = lerp( renderedSrgb, targetSRGB[ c ], strength );
		return clamp( srgbToLinear( goalSrgb ) / tex, 0, 1 );

	} );

}

const PART_BY_MATERIAL = [
	[ 'iris', /_EyeIris_/ ], [ 'white', /_EyeWhite_/ ], [ 'mouth', /_FaceMouth_/ ], [ 'skin', /_Face_\d+_SKIN/ ],
];
const FACE_MATERIAL = /_(FaceMouth|EyeIris|EyeHighlight|EyeWhite|FaceBrow|FaceEyelash|FaceEyeline|Face)_\d+_(FACE|EYE|SKIN)/;

function findFaceMeshes( root ) {

	const meshes = [];
	root.traverse( o => {

		const mat = Array.isArray( o.material ) ? o.material[ 0 ] : o.material;
		if ( o.isMesh && mat && FACE_MATERIAL.test( mat.name || '' ) && o.geometry && o.geometry.attributes.position ) meshes.push( o );

	} );
	return meshes;

}

// mean sRGB color of the face skin texture over the cheeks and forehead
function sampleSkinTexture( mesh, m ) {

	const map = mesh.material.map;
	const img = map && map.image;
	if ( ! img || typeof document === 'undefined' ) return null;

	const g = mesh.geometry, p = g.attributes.position.array, uv = g.attributes.uv && g.attributes.uv.array;
	if ( ! uv ) return null;

	const canvas = document.createElement( 'canvas' );
	canvas.width = img.width; canvas.height = img.height;
	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
	ctx.drawImage( img, 0, 0 );

	const sum = [ 0, 0, 0 ]; let n = 0;
	for ( const i of new Set( g.index.array ) ) {

		const ax = Math.abs( p[ i * 3 ] ), t = ( p[ i * 3 + 1 ] - m.eyeY ) / m.E;
		const cheek = ax > 0.22 * m.W && ax < 0.42 * m.W && t > - 0.4 && t < - 0.19;
		const forehead = ax < 0.28 * m.W && t > 0.45 && t < 0.8;
		if ( ! ( cheek || forehead ) || m.front * ( p[ i * 3 + 2 ] - m.zRef ) < - 0.2 * m.W ) continue;
		const px = Math.round( clamp( uv[ i * 2 ], 0, 1 ) * ( img.width - 1 ) );
		const py = Math.round( clamp( map.flipY ? 1 - uv[ i * 2 + 1 ] : uv[ i * 2 + 1 ], 0, 1 ) * ( img.height - 1 ) );
		const d = ctx.getImageData( px, py, 1, 1 ).data;
		sum[ 0 ] += d[ 0 ]; sum[ 1 ] += d[ 1 ]; sum[ 2 ] += d[ 2 ]; n ++;

	}
	return n ? sum.map( v => v / n ) : null;

}

/**
 * Refine a loaded VRM's face. Returns { applied, measured, revert() }.
 * @param {THREE.Object3D} root the imported VRM
 * @param {{strength?:number, geometry?:boolean, materials?:boolean, reference?:object}} opts
 */
export function refineFace( root, opts = {} ) {

	const { strength = 0.5, geometry = true, materials = true, reference = FACE_REFERENCE } = opts;
	const meshes = findFaceMeshes( root );
	if ( ! meshes.length ) throw new Error( 'refineFace: no VRoid-style face meshes found under that object' );

	const count = meshes[ 0 ].geometry.attributes.position.count;
	if ( meshes.some( me => me.geometry.attributes.position.count !== count ) ) throw new Error( 'refineFace: the face parts do not share one vertex layout' );

	// The skin material is split in two pieces (face, and ears/sides); the larger one is the face.
	const sets = { skin: [], iris: [], white: [], mouth: [] };
	for ( const me of meshes ) {

		const name = ( Array.isArray( me.material ) ? me.material[ 0 ] : me.material ).name;
		const part = PART_BY_MATERIAL.find( ( [ , re ] ) => re.test( name ) );
		if ( ! part ) continue;
		const verts = [ ...new Set( me.geometry.index.array ) ];
		if ( part[ 0 ] === 'skin' ) { if ( verts.length > sets.skin.length ) sets.skin = verts; } else sets[ part[ 0 ] ].push( ...verts );

	}

	const m = measureFace( meshes[ 0 ].geometry.attributes.position.array, sets );
	const plan = planFaceRefine( m, reference, strength );
	const undo = [];
	let maxMove = 0;

	if ( geometry ) {

		for ( const me of meshes ) {

			const attr = me.geometry.attributes.position;
			const before = attr.array.slice();
			maxMove = Math.max( maxMove, applyPlan( plan, before, attr.array ) );
			attr.needsUpdate = true;
			me.geometry.computeBoundingBox(); me.geometry.computeBoundingSphere();
			undo.push( () => { attr.array.set( before ); attr.needsUpdate = true; me.geometry.computeBoundingBox(); me.geometry.computeBoundingSphere(); } );

		}

	}

	let tint = null;
	if ( materials ) {

		const skinMesh = meshes.find( me => /_Face_\d+_SKIN/.test( me.material.name || '' ) );
		const tex = skinMesh && sampleSkinTexture( skinMesh, m );
		if ( tex ) {

			const c = skinMesh.material.color;
			tint = retintSkin( tex, [ c.r, c.g, c.b ], reference.skinRGB, plan.strength );
			// body and face skin share one tint so the neck does not show a seam
			const skinMats = new Set();
			root.traverse( o => {

				for ( const mat of Array.isArray( o.material ) ? o.material : [ o.material ] ) if ( mat && /_SKIN$/.test( mat.name || '' ) && mat.color ) skinMats.add( mat );

			} );
			for ( const mat of skinMats ) {

				const old = mat.color.clone();
				mat.color.setRGB( tint[ 0 ], tint[ 1 ], tint[ 2 ] );
				undo.push( () => mat.color.copy( old ) );

			}

		}

	}

	return {
		applied: { strength: plan.strength, geometry, tint: !! tint },
		measured: {
			eyeSeparationW: m.eyeSeparationW, eyeWidthW: m.eyeWidthW, mouthWidthW: m.mouth.widthW,
			noseTipDz: m.dz( m.chinY + reference.depth.noseTip.t * m.E ), lipsDz: m.dz( m.chinY + reference.depth.lips.t * m.E ), chinDz: m.dz( m.chinY + 0.04 * m.E ),
		},
		maxMove,
		revert() { undo.reverse().forEach( f => f() ); },
	};

}
