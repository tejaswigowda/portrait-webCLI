// Scalp hugging: after the hair is lifted or reshaped it must still sit on the head. A lift that leaves hair floating a few centimeters
// above the skull reads as a wig, so hair that has come away from the skull is pulled back toward it, keeping the thickness it had
// originally (the shell of the hair over the skull) plus whatever share of the new volume is wanted. Pure: positions in, positions out.
//
// The skull is estimated from the VRM itself: the face mesh covers only the front of the head, but the hair covers all of it, so the
// innermost points of the hair and the face together trace the scalp. It is a height field of the smallest radius in every direction from
// a point inside the head, so "how far is this hair from the skull" is a radius difference.

const clamp = ( v, a, b ) => Math.min( b, Math.max( a, v ) );
const smooth = t => t * t * ( 3 - 2 * t );

const AZ = 96, EL = 30, EL_LO = - 25 * Math.PI / 180, EL_HI = Math.PI / 2;

/**
 * @param {Float32Array} positions vertices on and over the head (the face mesh and the hair), x y z
 * @param {[number, number, number]} center a point inside the head (about the middle of the skull)
 * @returns {{ center:number[], radiusAt:(x:number,y:number,z:number)=>number }}
 */
export function buildSkull( positions, center ) {

	const grid = new Float32Array( AZ * EL ).fill( 0 ); // 0 = nothing there yet
	const cell = ( x, y, z ) => {

		const dx = x - center[ 0 ], dy = y - center[ 1 ], dz = z - center[ 2 ];
		const el = Math.atan2( dy, Math.hypot( dx, dz ) ), az = Math.atan2( dx, dz );
		return { a: ( az + Math.PI ) / ( 2 * Math.PI ) * AZ, e: ( el - EL_LO ) / ( EL_HI - EL_LO ) * EL, r: Math.hypot( dx, dy, dz ) };

	};
	for ( let i = 0; i < positions.length; i += 3 ) {

		const c = cell( positions[ i ], positions[ i + 1 ], positions[ i + 2 ] );
		const ia = Math.floor( c.a ) % AZ, ie = Math.floor( c.e );
		if ( ie < 0 || ie >= EL ) continue;
		const g = grid[ ie * AZ + ia ];
		if ( g === 0 || c.r < g ) grid[ ie * AZ + ia ] = c.r;

	}
	// fill the cells no vertex fell in from their neighbors, so the field has no holes
	for ( let pass = 0; pass < 12; pass ++ ) {

		const next = Float32Array.from( grid );
		let empty = 0;
		for ( let e = 0; e < EL; e ++ ) for ( let a = 0; a < AZ; a ++ ) {

			if ( grid[ e * AZ + a ] > 0 ) continue;
			let s = 0, n = 0;
			for ( let de = - 1; de <= 1; de ++ ) for ( let da = - 1; da <= 1; da ++ ) {

				const ee = e + de, aa = ( a + da + AZ ) % AZ;
				if ( ee < 0 || ee >= EL ) continue;
				const v = grid[ ee * AZ + aa ];
				if ( v > 0 ) { s += v; n ++; }

			}
			if ( n ) next[ e * AZ + a ] = s / n; else empty ++;

		}
		grid.set( next );
		if ( ! empty ) break;

	}

	// the face mesh is coarse over the cranium, so the raw field is jagged: smooth it, or the hair would copy the jags
	for ( let pass = 0; pass < 3; pass ++ ) {

		const next = new Float32Array( grid.length );
		for ( let e = 0; e < EL; e ++ ) for ( let a = 0; a < AZ; a ++ ) {

			let sum = 0, n = 0;
			for ( let de = - 1; de <= 1; de ++ ) for ( let da = - 1; da <= 1; da ++ ) {

				const ee = e + de;
				if ( ee < 0 || ee >= EL ) continue;
				sum += grid[ ee * AZ + ( ( a + da + AZ ) % AZ ) ]; n ++;

			}
			next[ e * AZ + a ] = sum / n;

		}
		grid.set( next );

	}

	return {
		center,
		radiusAt( x, y, z ) {

			const c = cell( x, y, z );
			const e = clamp( c.e - 0.5, 0, EL - 1.001 ), a = c.a - 0.5;
			const ie = Math.floor( e ), te = e - ie, ia = Math.floor( a ), ta = a - ia;
			const at = ( ee, aa ) => grid[ ee * AZ + ( ( aa % AZ ) + AZ ) % AZ ];
			const lo = at( ie, ia ) * ( 1 - ta ) + at( ie, ia + 1 ) * ta, hi = at( ie + 1, ia ) * ( 1 - ta ) + at( ie + 1, ia + 1 ) * ta;
			return lo * ( 1 - te ) + hi * te;

		},
	};

}

/** How far outside the skull (along the line from the center) a point is, in model units. */
export function thicknessAt( skull, x, y, z ) {

	return Math.hypot( x - skull.center[ 0 ], y - skull.center[ 1 ], z - skull.center[ 2 ] ) - skull.radiusAt( x, y, z );

}

/**
 * Pulls a lifted point back toward the skull. Hair that is farther from the skull than it was (`thickness`, measured before the lift) is moved along the line from the center
 * so that only (1 - hug) of the extra distance is left. Hair that is not floating is not moved. The pull fades in above the ear line (`weight`), because
 * below it the hair hangs free past the neck and the ears.
 * @param {number} thickness the point's own distance from the skull before it was moved
 * @param {number} weight 0 to 1: how much this height hugs
 * @param {number} hug 0 to 1
 * @returns {[number, number, number]} the point, moved
 */
export function hugScalp( skull, x, y, z, thickness, weight, hug, minThickness = 0.004 ) {

	const k = hug * weight;
	const [ cx, cy, cz ] = skull.center;
	const dx = x - cx, dy = y - cy, dz = z - cz, r = Math.hypot( dx, dy, dz );
	if ( r < 1e-6 || weight <= 0 ) return [ x, y, z ];
	const rs = skull.radiusAt( x, y, z ), cur = r - rs, extra = cur - thickness;
	// hair the reshape has pushed into the head comes back out to a thin shell over the scalp (never sunk in), whatever the hug
	let target = extra > 0 ? rs + thickness + extra * ( 1 - k ) : cur;
	if ( target < rs + minThickness * weight ) target = rs + minThickness * weight;
	if ( Math.abs( target - r ) < 1e-9 ) return [ x, y, z ];
	const s = target / r;
	return [ cx + dx * s, cy + dy * s, cz + dz * s ];

}

/** The share of the hug at a height v (up from the eye line in eye-to-chin heights): none below the ear line, full from the brow up. */
export const hugWeight = v => smooth( clamp( ( v - 0.1 ) / 0.5, 0, 1 ) );
