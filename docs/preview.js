// 3D preview of the bound VRM (and the base it came from), rendered on this device.
// The bytes never leave the page: GLTFLoader.parse reads the in-memory ArrayBuffer (textures become
// blob: URLs of in-memory data), and nothing here touches the network.
//
// The preview is flat (the VRM's unlit materials, no MToon shading). It shows the reshaped face and hair, the
// skin / hair / eye / brow colors, and lets you drive a few expressions through the bind map.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyFaceWeights, splitExpression } from './lib/facebind/runtime.js';

// slider id -> the ARKit morphs it drives (names as in the face GLB / VRM)
export const EXPRESSIONS = {
	jawOpen: [ 'jawOpen' ],
	smile: [ 'mouthSmileLeft', 'mouthSmileRight' ],
	blink: [ 'eyeBlinkLeft', 'eyeBlinkRight' ],
	browsUp: [ 'browInnerUp' ],
};

export function createPreview( container ) {

	const renderer = new THREE.WebGLRenderer( { antialias: true, preserveDrawingBuffer: true } ) // kept so the canvas can be saved or captured;
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	container.appendChild( renderer.domElement );

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x1b1e24 );
	const camera = new THREE.PerspectiveCamera( 30, 1, 0.01, 50 );
	const controls = new OrbitControls( camera, renderer.domElement );
	controls.enablePan = false;
	controls.enableDamping = false;

	const light = new THREE.DirectionalLight( 0xffffff, 2.2 );
	light.position.set( - 0.6, 0.8, 1 ); // from the upper left, in front
	const ambient = new THREE.AmbientLight( 0xffffff, 0.9 );
	let shading = 'lit';
	scene.add( light, ambient ); // toon shading is the default
	const toonRamp = ( () => { const t = new THREE.DataTexture( new Uint8Array( [ 90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255 ] ), 3, 1, THREE.RGBAFormat ); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; } )();

	const models = { base: null, bound: null };
	let view = 'bound', bind = null, weights = {}, disposed = false, raf = 0;
	let mode = 'manual', photo = null, touched = new Set(), info = { mapped: 0, extra: 0 };

	const render = () => { raf = 0; if ( ! disposed ) renderer.render( scene, camera ); };
	const request = () => { if ( ! raf && ! disposed ) raf = requestAnimationFrame( render ); };
	controls.addEventListener( 'change', request );

	const resize = () => {

		const w = container.clientWidth || 480, h = container.clientHeight || 420;
		renderer.setSize( w, h, false );
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		request();

	};
	const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver( resize ) : null;
	if ( observer ) observer.observe( container ); else window.addEventListener( 'resize', resize );
	resize();

	function disposeModel( m ) {

		if ( ! m ) return;
		scene.remove( m );
		m.traverse( o => {

			if ( o.geometry ) o.geometry.dispose();
			for ( const mat of Array.isArray( o.material ) ? o.material : o.material ? [ o.material ] : [] ) {

				for ( const v of Object.values( mat ) ) if ( v && v.isTexture ) v.dispose();
				mat.dispose();

			}

		} );

	}

	async function load( bytes ) {

		const copy = bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength );
		const gltf = await new GLTFLoader().parseAsync( copy, '' );
		const root = gltf.scene;
		if ( gltf.parser.json.extensions && gltf.parser.json.extensions.VRM ) root.rotation.y = Math.PI; // VRM 0.x faces -Z
		root.updateMatrixWorld( true );
		return root;

	}

	// 'flat': the VRM's own unlit materials. 'lit': a stand-in toon shader driven by the vertex normals, so the shading shows
	// whether the normals follow a reshaped face and hair (it is not MToon, but it reads the same normals).
	function applyShading( root ) {

		if ( ! root ) return;
		root.traverse( o => {

			if ( ! o.isMesh ) return;
			if ( ! o.userData.flatMaterial ) o.userData.flatMaterial = o.material;
			if ( shading === 'flat' ) { o.material = o.userData.flatMaterial; return; }
			if ( ! o.userData.litMaterial ) {

				const m = o.userData.flatMaterial;
				o.userData.litMaterial = new THREE.MeshToonMaterial( { map: m.map || null, color: m.color ? m.color.clone() : 0xffffff, gradientMap: toonRamp, transparent: m.transparent, alphaTest: m.alphaTest, opacity: m.opacity, side: m.side } );

			}
			o.material = o.userData.litMaterial;

		} );
		root.traverse( o => { if ( o.material ) o.material.needsUpdate = true; } );

	}

	function setNamed( root, name, value ) {

		root.traverse( o => { if ( o.morphTargetDictionary && o.morphTargetDictionary[ name ] !== undefined ) o.morphTargetInfluences[ o.morphTargetDictionary[ name ] ] = value; } );

	}

	// mode 'photo': the expression read from the input photo; 'neutral': none; 'manual': the sliders
	function applyWeights() {

		const named = {};
		if ( mode === 'photo' && photo ) Object.assign( named, photo );
		else if ( mode === 'manual' ) for ( const [ k, v ] of Object.entries( weights ) ) for ( const n of EXPRESSIONS[ k ] || [] ) named[ n ] = v;

		for ( const n of touched ) { if ( models.bound ) setNamed( models.bound, n, 0 ); if ( models.base ) setNamed( models.base, n, 0 ); }
		touched = new Set( Object.keys( named ) );

		info = { mapped: 0, extra: 0 };
		if ( models.bound && bind ) {

			const { mapped, extra } = splitExpression( named, bind );
			applyFaceWeights( models.bound, mapped, { bind } ); // through the bind map
			for ( const [ n, v ] of Object.entries( extra ) ) setNamed( models.bound, n, v ); // ARKit shapes the VRM has but the face GLB does not
			info = { mapped: Object.keys( mapped ).length, extra: Object.keys( extra ).length };

		}
		if ( models.base ) for ( const [ n, v ] of Object.entries( named ) ) setNamed( models.base, n, v );
		request();

	}

	function frame( root ) {

		let face = null;
		root.traverse( o => { if ( ! face && o.isMesh && /^Face/.test( o.name ) ) face = o; } );
		const box = new THREE.Box3().setFromObject( face || root );
		const center = box.getCenter( new THREE.Vector3() ), size = box.getSize( new THREE.Vector3() );
		const dist = Math.max( size.y, size.x ) * 3.6;
		center.y += size.y * 0.15; // include the top of the hair
		camera.position.set( center.x, center.y, center.z + dist );
		controls.target.copy( center );
		controls.minDistance = dist * 0.4; controls.maxDistance = dist * 3;
		controls.update();

	}

	return {

		/** @param {{ base: Uint8Array, bound: Uint8Array, bind: object, expression?: Object<string, number> }} args */
		async show( { base, bound, bind: b, expression } ) {

			disposeModel( models.base ); disposeModel( models.bound );
			models.base = await load( base ); models.bound = await load( bound );
			bind = b;
			photo = expression || null;
			mode = photo ? 'photo' : 'manual';
			touched = new Set();
			scene.add( models.base, models.bound );
			applyShading( models.base ); applyShading( models.bound );
			this.setView( view );
			frame( models.bound );
			applyWeights();

		},

		/** 'flat' | 'lit' */
		setShading( s ) {

			shading = s;
			if ( s === 'lit' ) { scene.add( light, ambient ); } else { scene.remove( light, ambient ); }
			applyShading( models.base ); applyShading( models.bound ); request();

		},

		setView( v ) {

			view = v;
			if ( models.base ) models.base.visible = v === 'base';
			if ( models.bound ) models.bound.visible = v === 'bound';
			request();

		},

		/** 'photo' | 'neutral' | 'manual' */
		setExpressionMode( m ) { mode = m; applyWeights(); return info; },

		get expressionMode() { return mode; },

		get shading() { return shading; },

		/** Turn the camera around the head: 0 = front, 180 = back; elevation in degrees (positive looks from above). */
		orbit( degrees, elevation = 0 ) {

			const t = controls.target, r = Math.hypot( camera.position.x - t.x, camera.position.y - t.y, camera.position.z - t.z ), a = degrees * Math.PI / 180, e = elevation * Math.PI / 180;
			camera.position.set( t.x + Math.sin( a ) * Math.cos( e ) * r, t.y + Math.sin( e ) * r, t.z + Math.cos( a ) * Math.cos( e ) * r );
			controls.update(); request();

		},

		get info() { return info; },

		setExpression( key, value ) { weights[ key ] = value; mode = 'manual'; applyWeights(); },

		resetExpressions() { weights = {}; mode = 'neutral'; applyWeights(); },

		dispose() {

			disposed = true;
			disposeModel( models.base ); disposeModel( models.bound );
			if ( observer ) observer.disconnect(); else window.removeEventListener( 'resize', resize );
			controls.dispose(); renderer.dispose(); renderer.domElement.remove();

		},

	};

}
