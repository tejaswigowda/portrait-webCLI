// Facial hair (mustache, beard, stubble) from a photo, painted into the VRM's face SKIN texture. Pure: pixels and landmarks in, pixels out.
//
// Reading it: the photo's skin is compared in four small zones (above the lip, the chin, and the two jaws) with the cheeks of the
// same face in the same light. A zone that is clearly darker than the cheeks has hair on it. This is an estimate (a shadow or a
// dark lip corner can fool it), it only ever decides how much to paint, and a clean-shaven face paints nothing.
//
// Painting it: the VRoid face texture has a fixed layout (the mouth line sits at the same place on every VRoid base), so the
// shapes are in texture coordinates. Each pixel of a zone gets a dark dot with a probability that falls off toward the edge of the
// zone: that reads as stubble up close and as a soft beard from a distance, and it does not touch the lips. The dots come from a
// hash of the pixel position, so the same inputs paint the same texture.

const clamp = ( v, a, b ) => Math.min( b, Math.max( a, v ) );
const smooth = t => t * t * ( 3 - 2 * t );

/** Landmark indices (MediaPipe face mesh). */
const L = { noseBase: 2, lipTop: 0, lipBottom: 17, chin: 152, mouthL: 61, mouthR: 291, jawL: 58, jawR: 288, cheekL: 205, cheekR: 425, earL: 234, earR: 454 };

const lum = ( d, i ) => 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];

function discMean( rgba, width, height, cx, cy, r ) {

	let s = 0, n = 0;
	const x0 = Math.max( 0, Math.floor( cx - r ) ), x1 = Math.min( width - 1, Math.ceil( cx + r ) ), y0 = Math.max( 0, Math.floor( cy - r ) ), y1 = Math.min( height - 1, Math.ceil( cy + r ) );
	for ( let y = y0; y <= y1; y ++ ) for ( let x = x0; x <= x1; x ++ ) {

		if ( ( x - cx ) ** 2 + ( y - cy ) ** 2 > r * r ) continue;
		s += lum( rgba, ( y * width + x ) * 4 ); n ++;

	}
	return n >= 12 ? s / n : null;

}

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba the photo, 4 bytes per pixel
 * @param {{x:number,y:number}[]} landmarks normalized face mesh landmarks
 * @returns {{ mustache:number, chin:number, jaw:number, darkness:{mustache:number,chin:number,jaw:number}, reference:number }|null} amounts 0 to 1 per zone; null when nothing can be read or there is no facial hair
 */
export function facialHairFromPhoto( rgba, { width, height }, landmarks ) {

	if ( ! landmarks || landmarks.length < 468 ) return null;
	const P = i => [ landmarks[ i ].x * width, landmarks[ i ].y * height ];
	const mid = ( a, b, t ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ];
	const W = Math.hypot( P( L.earL )[ 0 ] - P( L.earR )[ 0 ], P( L.earL )[ 1 ] - P( L.earR )[ 1 ] );
	if ( ! ( W > 40 ) ) return null; // too small a face to tell hair from skin texture

	const ref = [ L.cheekL, L.cheekR ].map( i => discMean( rgba, width, height, ...P( i ), 0.06 * W ) ).filter( v => v !== null );
	if ( ! ref.length ) return null;
	const reference = ref.reduce( ( a, b ) => a + b, 0 ) / ref.length;
	if ( reference < 40 ) return null; // too dark a picture to compare

	const zone = ( [ cx, cy ], r ) => discMean( rgba, width, height, cx, cy, r * W );
	const mustacheM = zone( mid( P( L.noseBase ), P( L.lipTop ), 0.5 ), 0.045 );
	const chinM = zone( mid( P( L.lipBottom ), P( L.chin ), 0.62 ), 0.06 );
	const jawL = zone( mid( P( L.mouthL ), P( L.jawL ), 0.55 ), 0.055 ), jawR = zone( mid( P( L.mouthR ), P( L.jawR ), 0.55 ), 0.055 );
	const jawM = [ jawL, jawR ].filter( v => v !== null );
	const dark = m => m === null ? 0 : clamp( ( reference - m ) / reference, 0, 1 );
	const darkness = { mustache: dark( mustacheM ), chin: dark( chinM ), jaw: jawM.length ? jawM.reduce( ( a, b ) => a + dark( b ), 0 ) / jawM.length : 0 };

	// 0.07 darker than the cheeks is within shadow; 0.4 darker is a full beard
	const amount = d => clamp( ( d - 0.07 ) / 0.33, 0, 1 );
	const out = { mustache: amount( darkness.mustache ), chin: amount( darkness.chin ), jaw: amount( darkness.jaw ) };
	if ( out.mustache + out.chin + out.jaw < 0.15 ) return null;
	const r = v => +v.toFixed( 3 );
	return { mustache: r( out.mustache ), chin: r( out.chin ), jaw: r( out.jaw ), darkness: { mustache: r( darkness.mustache ), chin: r( darkness.chin ), jaw: r( darkness.jaw ) }, reference: Math.round( reference ) };

}

// where the mouth is on the VRoid face texture (0 to 1; measured from the base's own texture, the same on the male and female bases)
const MOUTH = { x: 0.5, y: 0.757 };

const hash = ( x, y, seed ) => { let h = ( Math.imul( x + 1, 374761393 ) ^ Math.imul( y + 1, 668265263 ) ^ Math.imul( seed + 1, 2246822519 ) ) >>> 0; h = Math.imul( h ^ ( h >>> 13 ), 1274126177 ) >>> 0; return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296; };

// weight 0 to 1 of a soft rectangle / ellipse
const softRect = ( u, v, cx, cy, hx, hy, soft ) => smooth( clamp( ( 1 - Math.abs( u - cx ) / hx ) / soft, 0, 1 ) ) * smooth( clamp( ( 1 - Math.abs( v - cy ) / hy ) / soft, 0, 1 ) );
const softEllipse = ( u, v, cx, cy, rx, ry, soft ) => smooth( clamp( ( 1 - Math.hypot( ( u - cx ) / rx, ( v - cy ) / ry ) ) / soft, 0, 1 ) );

/**
 * Paints facial hair onto a copy of the face skin texture.
 * @param {Uint8ClampedArray|Uint8Array} rgba the face SKIN texture, 4 bytes per pixel
 * @param {{ mustache:number, chin:number, jaw:number }} amounts from facialHairFromPhoto
 * @param {{r:number,g:number,b:number}} [hairColor] 0 to 1; the dots use a darker version of it
 * @returns {Uint8ClampedArray} the painted copy (same size)
 */
export function paintFacialHair( rgba, width, height, amounts, hairColor = null ) {

	const out = Uint8ClampedArray.from( rgba );
	const base = hairColor ? [ hairColor.r, hairColor.g, hairColor.b ].map( c => clamp( c * 255 * 0.8, 0, 90 ) ) : [ 62, 57, 54 ];
	const { mustache = 0, chin = 0, jaw = 0 } = amounts;

	for ( let y = 0; y < height; y ++ ) {

		const v = ( y + 0.5 ) / height;
		if ( v < 0.6 || v > 0.92 ) continue;
		for ( let x = 0; x < width; x ++ ) {

			const u = ( x + 0.5 ) / width;
			if ( Math.abs( u - MOUTH.x ) > 0.26 ) continue;
			// the zones, relative to the mouth: a mustache above the lip, a chin patch below it, and a wider haze along the jaw
			let w = Math.max(
				mustache * softRect( u, v, MOUTH.x, MOUTH.y - 0.052, 0.085, 0.036, 0.5 ),
				chin * softRect( u, v, MOUTH.x, MOUTH.y + 0.045, 0.095, 0.05, 0.5 ),
				jaw * 0.7 * softEllipse( u, v, MOUTH.x, MOUTH.y + 0.03, 0.22, 0.12, 0.7 ) );
			if ( w <= 0 ) continue;
			// the lips and the mouth line stay clear
			const lip = softRect( u, v, MOUTH.x, MOUTH.y, 0.075, 0.009, 0.5 );
			w *= 1 - lip;
			if ( hash( x, y, 1 ) > w * 0.85 ) continue; // a dot with probability w: stubble, thicker toward the middle of a zone
			const a = 0.45 + 0.4 * hash( x, y, 2 ), i = ( y * width + x ) * 4;
			for ( let c = 0; c < 3; c ++ ) out[ i + c ] = out[ i + c ] * ( 1 - a ) + ( base[ c ] * ( 0.8 + 0.4 * hash( x, y, 3 ) ) ) * a;

		}

	}
	return out;

}
