// Face proportions from a photo's 478 MediaPipe landmarks, in the units refineFace()/reshape use:
//   W = head width (landmarks 234–454), E = chin-to-eye-line height, dz = how far a landmark sits in
//   front of the eye-corner plane as a fraction of W. Everything is a ratio, so photo size and
//   distance to the camera drop out. The head's roll and yaw are removed first (from the eye line and
//   the ears), so a slightly turned or tilted photo still measures sensibly.
// Pure: landmarks in, numbers out.

const L = { rEyeOut: 33, rEyeIn: 133, lEyeIn: 362, lEyeOut: 263, rUp: 159, rLow: 145, lUp: 386, lLow: 374, mouthR: 61, mouthL: 291, lipTop: 13, lipBottom: 14, nose: 1, chin: 152, earR: 234, earL: 454, jawR: 172, jawL: 397 };

const round = ( v, d = 4 ) => +v.toFixed( d );

/**
 * @param {{x:number,y:number,z:number}[]} landmarks MediaPipe face landmarks (x, y in 0–1 of the image, z on x's scale)
 * @param {{width:number,height:number}} image the photo's pixel size (landmarks are normalised per axis)
 * @returns {object|null} null if there are not enough landmarks
 */
export function faceProportions( landmarks, image ) {

	if ( ! landmarks || landmarks.length < 468 ) return null;
	const { width, height } = image;

	// image pixels, y up, z toward the viewer
	let pts = landmarks.map( p => [ p.x * width, - p.y * height, - p.z * width ] );
	const d2 = ( a, b ) => Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ] );
	const mid = ( ...ids ) => ids.map( i => pts[ i ] ).reduce( ( s, p ) => [ s[ 0 ] + p[ 0 ] / ids.length, s[ 1 ] + p[ 1 ] / ids.length, s[ 2 ] + p[ 2 ] / ids.length ], [ 0, 0, 0 ] );

	// roll: level the eye line (rotate about z)
	const roll = Math.atan2( pts[ L.lEyeOut ][ 1 ] - pts[ L.rEyeOut ][ 1 ], pts[ L.lEyeOut ][ 0 ] - pts[ L.rEyeOut ][ 0 ] );
	const cr = Math.cos( - roll ), sr = Math.sin( - roll );
	pts = pts.map( ( [ x, y, z ] ) => [ x * cr - y * sr, x * sr + y * cr, z ] );

	// yaw: give the two ear landmarks the same depth (rotate about y)
	const yaw = Math.atan2( pts[ L.earL ][ 2 ] - pts[ L.earR ][ 2 ], pts[ L.earL ][ 0 ] - pts[ L.earR ][ 0 ] );
	const cy = Math.cos( yaw ), sy = Math.sin( yaw );
	pts = pts.map( ( [ x, y, z ] ) => [ x * cy + z * sy, y, - x * sy + z * cy ] );

	const W = d2( pts[ L.earR ], pts[ L.earL ] );
	const eyes = mid( L.rEyeOut, L.rEyeIn, L.lEyeIn, L.lEyeOut );
	const E = eyes[ 1 ] - pts[ L.chin ][ 1 ];
	if ( ! ( W > 0 ) || ! ( E > 0 ) ) return null;
	const t = y => ( y - pts[ L.chin ][ 1 ] ) / E;

	const rW = d2( pts[ L.rEyeOut ], pts[ L.rEyeIn ] ), lW = d2( pts[ L.lEyeOut ], pts[ L.lEyeIn ] );
	const zRef = eyes[ 2 ];
	const dz = id => ( pts[ id ][ 2 ] - zRef ) / W;
	const yawDeg = yaw * 180 / Math.PI, rollDeg = roll * 180 / Math.PI;
	const lips = mid( L.lipTop, L.lipBottom );
	// MediaPipe's depth is an estimate and noisy: keep it within what human faces do
	const plausible = ( v, lo, hi ) => Math.min( hi, Math.max( lo, v ) );

	return {
		eyeSeparationW: round( d2( mid( L.rEyeOut, L.rEyeIn ), mid( L.lEyeIn, L.lEyeOut ) ) / W ),
		eyeWidthW: round( ( rW + lW ) / 2 / W ),
		eyeOpenness: round( ( d2( pts[ L.rUp ], pts[ L.rLow ] ) / rW + d2( pts[ L.lUp ], pts[ L.lLow ] ) / lW ) / 2 ),
		mouthWidthW: round( d2( pts[ L.mouthR ], pts[ L.mouthL ] ) / W ),
		jawWidthW: round( d2( pts[ L.jawR ], pts[ L.jawL ] ) / W ),
		jawT: round( t( ( pts[ L.jawR ][ 1 ] + pts[ L.jawL ][ 1 ] ) / 2 ) ),
		// profile depth is only meaningful for a roughly frontal photo
		depth: Math.abs( yawDeg ) <= 25 ? {
			noseTip: { t: round( t( pts[ L.nose ][ 1 ] ) ), dz: round( plausible( dz( L.nose ), 0.12, 0.2 ) ) },
			lips: { t: round( t( lips[ 1 ] ) ), dz: round( plausible( ( lips[ 2 ] - zRef ) / W, 0.05, 0.11 ) ) },
			chin: { t: 0, dz: round( plausible( dz( L.chin ), - 0.02, 0.06 ) ) },
		} : null,
		quality: { yawDeg: round( yawDeg, 1 ), rollDeg: round( rollDeg, 1 ), frontal: Math.abs( yawDeg ) <= 25 && Math.abs( rollDeg ) <= 35 },
	};

}
