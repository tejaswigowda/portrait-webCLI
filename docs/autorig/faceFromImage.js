// Photo -> face-blendshape GLB, entirely on this device.
//
// This is the "autorigger" from https://github.com/tejaswigowda/face-to-blendshape-3d (MIT, vendored
// in ./ as arkit-mapper.js, face-mesh-generator.js, face-mesh-triangulation.js, texture-mapper.js),
// driven by a MediaPipe Face Landmarker whose wasm and model are vendored in ../vendor/mediapipe/ and
// loaded with same-origin GETs. The photo is read from a local File / bitmap, decoded in memory and
// never sent anywhere: this module has no network code of its own, and the page's egress guard and
// Content-Security-Policy only allow same-origin GETs of the static files above.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { ARKitBlendshapeMapper } from './arkit-mapper.js';
import { FaceMeshGenerator } from './face-mesh-generator.js';
import { TextureMapper } from './texture-mapper.js';
import { hairColorFromMask, trimmedMeanColor } from '../lib/facebind/hair.js';
import { hairShapeFromMask } from '../lib/facebind/hairShape.js';
import { classifyHairTexture } from '../lib/facebind/hairStyle.js';
import { facialHairFromPhoto } from '../lib/facebind/facialHair.js';
import { faceProportions } from '../lib/facebind/proportions.js';

const VENDOR = new URL( '../vendor/mediapipe/', import.meta.url ).href;

export class ImageError extends Error {

	constructor( code, message ) {

		super( message );
		this.code = code;

	}

}

let landmarker = null;

/** Load the on-device face model (static, same-origin; cached by the browser). Safe to call repeatedly. */
export function loadLandmarker() {

	if ( ! landmarker ) {

		landmarker = ( async () => {

			// CPU delegate: deterministic, and no GPU shader/driver variation between devices
			const vision = await FilesetResolver.forVisionTasks( VENDOR + 'wasm' );
			return FaceLandmarker.createFromOptions( vision, {
				baseOptions: { modelAssetPath: VENDOR + 'face_landmarker.task', delegate: 'CPU' },
				outputFaceBlendshapes: true,
				outputFacialTransformationMatrixes: true,
				runningMode: 'IMAGE',
				numFaces: 1,
			} );

		} )();
		landmarker.catch( () => { landmarker = null; } );

	}
	return landmarker;

}

let segmenter = null;

/** Load the on-device hair segmenter (static, same-origin). */
export function loadHairSegmenter() {

	if ( ! segmenter ) {

		segmenter = ( async () => {

			const vision = await FilesetResolver.forVisionTasks( VENDOR + 'wasm' );
			return ImageSegmenter.createFromOptions( vision, {
				baseOptions: { modelAssetPath: VENDOR + 'hair_segmenter.tflite', delegate: 'CPU' },
				runningMode: 'IMAGE',
				outputCategoryMask: true,
				outputConfidenceMasks: false,
			} );

		} )();
		segmenter.catch( () => { segmenter = null; } );

	}
	return segmenter;

}

// The photo's pixels at up to 1024 px, for the facial hair reading.
function photoPixels( bitmap ) {

	const scale = Math.min( 1, 1024 / Math.max( bitmap.width, bitmap.height ) );
	const width = Math.round( bitmap.width * scale ), height = Math.round( bitmap.height * scale );
	const canvas = document.createElement( 'canvas' );
	canvas.width = width; canvas.height = height;
	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
	ctx.drawImage( bitmap, 0, 0, width, height );
	return { rgba: ctx.getImageData( 0, 0, width, height ).data, size: { width, height } };

}

// Hair color (sRGB 0–1) and how much of the frame is hair, relative to the face. null if the model is unavailable.
async function readHair( bitmap, landmarks ) {

	const seg = await loadHairSegmenter();
	const scale = Math.min( 1, 1024 / Math.max( bitmap.width, bitmap.height ) );
	const small = scale < 1 ? await createImageBitmap( bitmap, { resizeWidth: Math.round( bitmap.width * scale ), resizeHeight: Math.round( bitmap.height * scale ), resizeQuality: 'high' } ) : bitmap;

	const result = seg.segment( small );
	try {

		const mask = result.categoryMask;
		const { width, height } = mask;
		const canvas = document.createElement( 'canvas' );
		canvas.width = width; canvas.height = height;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		ctx.drawImage( small, 0, 0, width, height );

		const xs = landmarks.map( l => l.x ), ys = landmarks.map( l => l.y );
		const faceArea = ( Math.max( ...xs ) - Math.min( ...xs ) ) * width * ( Math.max( ...ys ) - Math.min( ...ys ) ) * height;
		const labels = seg.getLabels();
		const hairValue = labels.indexOf( 'hair' ) >= 0 ? labels.indexOf( 'hair' ) : 1;
		const data = mask.getAsUint8Array();
		const pixels = ctx.getImageData( 0, 0, width, height ).data;
		const stats = hairColorFromMask( pixels, data, { width, height, hairValue, faceArea } );
		return stats && { ...stats, shape: hairShapeFromMask( landmarks, data, { width, height, hairValue } ), texture: classifyHairTexture( pixels, data, { width, height, hairValue } ), mask: { width, height, hairValue, data: data.slice() } };

	} finally {

		result.close();
		if ( small !== bitmap ) small.close();

	}

}

// Iris and brow color (sRGB 0–1) read at the landmarks: a disc inside each iris, and the polygon of each brow.
const IRIS = [ [ 468, [ 469, 470, 471, 472 ] ], [ 473, [ 474, 475, 476, 477 ] ] ];
const BROWS = [ [ 70, 63, 105, 66, 107, 55, 65, 52, 53, 46 ], [ 300, 293, 334, 296, 336, 285, 295, 282, 283, 276 ] ];

async function readEyeAndBrow( bitmap, landmarks ) {

	if ( landmarks.length < 478 ) return { iris: null, brow: null };
	const scale = Math.min( 1, 1024 / Math.max( bitmap.width, bitmap.height ) );
	const w = Math.round( bitmap.width * scale ), h = Math.round( bitmap.height * scale );
	const canvas = document.createElement( 'canvas' );
	canvas.width = w; canvas.height = h;
	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
	ctx.drawImage( bitmap, 0, 0, w, h );
	const rgba = ctx.getImageData( 0, 0, w, h ).data;
	const P = i => [ landmarks[ i ].x * w, landmarks[ i ].y * h ];

	const irisPx = [];
	for ( const [ c, ring ] of IRIS ) {

		const [ cx, cy ] = P( c );
		const r = ring.map( i => Math.hypot( P( i )[ 0 ] - cx, P( i )[ 1 ] - cy ) ).reduce( ( a, b ) => a + b, 0 ) / ring.length;
		for ( let y = Math.floor( cy - r ); y <= Math.ceil( cy + r ); y ++ ) for ( let x = Math.floor( cx - r ); x <= Math.ceil( cx + r ); x ++ ) {

			if ( x >= 0 && y >= 0 && x < w && y < h && Math.hypot( x - cx, y - cy ) <= 0.8 * r ) irisPx.push( y * w + x );

		}

	}

	// brows: rasterise the polygons on a scratch canvas, then keep the darker half (the hairs, not the skin between them)
	const m = document.createElement( 'canvas' );
	m.width = w; m.height = h;
	const mctx = m.getContext( '2d', { willReadFrequently: true } );
	mctx.fillStyle = '#fff';
	for ( const poly of BROWS ) { mctx.beginPath(); poly.forEach( ( id, k ) => { const [ x, y ] = P( id ); k ? mctx.lineTo( x, y ) : mctx.moveTo( x, y ); } ); mctx.closePath(); mctx.fill(); }
	const mask = mctx.getImageData( 0, 0, w, h ).data;
	const browPx = [];
	for ( let i = 0; i < w * h; i ++ ) if ( mask[ i * 4 + 3 ] > 200 ) browPx.push( i );

	return {
		iris: trimmedMeanColor( rgba, irisPx, { highTrim: 0.15 } ),
		brow: trimmedMeanColor( rgba, browPx, { highTrim: 0.5 } ),
	};

}

async function toBitmap( image ) {

	if ( typeof image === 'string' || ( image && image.href ) ) throw new ImageError( 'IMAGE_MUST_BE_LOCAL', 'The photo must be a local file, never a URL.' );
	if ( typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap ) return image;
	if ( typeof Blob !== 'undefined' && image instanceof Blob ) {

		try { return await createImageBitmap( image, { imageOrientation: 'from-image' } ); } catch ( e ) { throw new ImageError( 'BAD_IMAGE', 'Could not read that file as an image.' ); }

	}
	throw new ImageError( 'BAD_IMAGE', 'Expected an image file.' );

}

/**
 * @param {Blob|File|ImageBitmap} image a LOCAL photo of one face
 * @returns {Promise<{ glb: Uint8Array, blendshapes: Object<string, number>, skinColor: {r:number,g:number,b:number}, hair: {color:{r:number,g:number,b:number}, pixels:number, coverage:number}|null }>}
 */
export async function faceGLBFromImage( image ) {

	const bitmap = await toBitmap( image );
	const lm = await loadLandmarker();

	const results = lm.detect( bitmap );
	if ( ! results.faceLandmarks || ! results.faceLandmarks.length ) throw new ImageError( 'NO_FACE_DETECTED', 'No face was detected in the photo. Use a clear, front-facing photo of one face.' );

	const landmarks = results.faceLandmarks[ 0 ];
	const categories = ( results.faceBlendshapes && results.faceBlendshapes[ 0 ] && results.faceBlendshapes[ 0 ].categories ) || [];
	const blendshapes = new ARKitBlendshapeMapper().mapMediaPipeToARKit( categories, landmarks );
	const transform = results.facialTransformationMatrixes && results.facialTransformationMatrixes[ 0 ];

	let facialHair = null, pixels = null;
	try { pixels = photoPixels( bitmap ); facialHair = facialHairFromPhoto( pixels.rgba, pixels.size, landmarks ); } catch ( e ) { console.warn( 'portrait: facial hair not read', e ); }
	let hair = null;
	try { hair = await readHair( bitmap, landmarks ); } catch ( e ) { console.warn( 'portrait: hair segmentation unavailable', e ); }

	let eyeBrow = { iris: null, brow: null };
	try { eyeBrow = await readEyeAndBrow( bitmap, landmarks ); } catch ( e ) { console.warn( 'portrait: iris/brow colors unavailable', e ); }
	const proportions = faceProportions( landmarks, { width: bitmap.width, height: bitmap.height } );

	const texture = new TextureMapper().createFaceTexture( bitmap, landmarks );
	const generator = new FaceMeshGenerator();
	const mesh = generator.generateWithMorphTargets( landmarks, blendshapes, transform, texture );
	mesh.name = 'faceMesh';
	// travels in the face GLB's node extras next to skinColor, so the bind reads it from the GLB like everything else
	if ( hair ) { mesh.userData.hairColor = hair.color; mesh.userData.hairCoverage = hair.coverage; if ( hair.shape ) mesh.userData.hairShape = hair.shape; if ( hair.texture ) mesh.userData.hairTexture = hair.texture; }
	if ( facialHair ) mesh.userData.facialHair = facialHair;
	if ( eyeBrow.iris ) mesh.userData.irisColor = eyeBrow.iris;
	if ( eyeBrow.brow ) mesh.userData.browColor = eyeBrow.brow;
	if ( proportions ) mesh.userData.faceProportions = proportions;

	const group = new THREE.Group();
	group.add( mesh );
	const glb = await new Promise( ( resolve, reject ) => {

		new GLTFExporter().parse( group, r => r instanceof ArrayBuffer ? resolve( new Uint8Array( r ) ) : reject( new Error( 'GLB export did not return binary' ) ), reject,
			{ binary: true, maxTextureSize: 2048, embedImages: true, truncateDrawRange: false } );

	} );

	mesh.geometry.dispose(); mesh.material.map.dispose(); mesh.material.dispose();
	if ( bitmap.close && image !== bitmap ) bitmap.close();
	return { glb, blendshapes, skinColor: generator.skinColor, hair, hairMask: hair ? hair.mask : null, iris: eyeBrow.iris, brow: eyeBrow.brow, proportions, facialHair };

}
