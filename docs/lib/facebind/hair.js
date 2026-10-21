// Reads a hair color out of a photo, given a hair mask. Pure (no DOM, no network): the caller
// supplies the photo's RGBA pixels and a mask of the same size, so this runs the same in a browser
// and in Node tests. The mask itself comes from the vendored on-device MediaPipe hair segmenter.

const toLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ); };
const toSrgb = c => 255 * ( c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055 );

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba width*height*4
 * @param {Uint8Array} mask width*height; `hairValue` marks hair
 * @param {{ width:number, height:number, hairValue?:number, faceArea?:number, lowTrim?:number, highTrim?:number }} opts
 *   faceArea = the face's bounding-box area in pixels, so coverage can be reported relative to the face.
 *   The darkest `lowTrim` (shadows, the edge against the background) and brightest `highTrim` (specular
 *   highlights) of the hair pixels are ignored.
 * @returns {{ color: {r:number,g:number,b:number}, pixels:number, coverage:number|null } | null} color in sRGB 0–1
 */
export function hairColorFromMask( rgba, mask, opts ) {

	const { width, height, hairValue = 1, faceArea, lowTrim = 0.05, highTrim = 0.15 } = opts;
	const isHair = i => mask[ i ] === hairValue;

	// one-pixel erosion: pixels on the hair/background boundary blend the two
	const px = [];
	for ( let y = 1; y < height - 1; y ++ ) {

		for ( let x = 1; x < width - 1; x ++ ) {

			const i = y * width + x;
			if ( isHair( i ) && isHair( i - 1 ) && isHair( i + 1 ) && isHair( i - width ) && isHair( i + width ) ) px.push( i );

		}

	}
	if ( ! px.length ) return null;

	return {
		color: trimmedMeanColor( rgba, px, { lowTrim, highTrim } ),
		pixels: px.length,
		coverage: faceArea ? px.length / faceArea : null,
	};

}

/**
 * Mean color (averaged in linear light, returned as sRGB 0–1) of the pixels `indices`, ignoring the darkest
 * `lowTrim` and the brightest `highTrim` fraction by luminance.
 */
export function trimmedMeanColor( rgba, indices, { lowTrim = 0, highTrim = 0 } = {} ) {

	if ( ! indices.length ) return null;
	const px = Array.from( indices );
	const lum = i => 0.2126 * rgba[ i * 4 ] + 0.7152 * rgba[ i * 4 + 1 ] + 0.0722 * rgba[ i * 4 + 2 ];
	px.sort( ( a, b ) => lum( a ) - lum( b ) );
	const from = Math.floor( px.length * lowTrim ), to = Math.max( from + 1, Math.ceil( px.length * ( 1 - highTrim ) ) );

	let r = 0, g = 0, b = 0;
	for ( let k = from; k < to; k ++ ) { const i = px[ k ]; r += toLinear( rgba[ i * 4 ] ); g += toLinear( rgba[ i * 4 + 1 ] ); b += toLinear( rgba[ i * 4 + 2 ] ); }
	const n = to - from;
	return { r: toSrgb( r / n ) / 255, g: toSrgb( g / n ) / 255, b: toSrgb( b / n ) / 255 };

}

/** Hair below this fraction of the face's area is treated as "no hair detected" (shaved, or a bad mask). */
export const MIN_HAIR_COVERAGE = 0.08;
