// Run: node tests/static.test.mjs
// Static checks on the portrait page's zero-egress setup and webCLI contract (no browser needed).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join( path.dirname( fileURLToPath( import.meta.url ) ), '..', 'docs' );
const read = f => fs.readFileSync( path.join( root, f ), 'utf8' );
const sha = ( f, enc ) => crypto.createHash( 'sha256' ).update( fs.readFileSync( path.join( root, f ) ) ).digest( enc );

let passed = 0, failed = 0;
const test = ( name, fn ) => { try { fn(); passed ++; console.log( '  ✓ ' + name ); } catch ( e ) { failed ++; console.log( '  ✗ ' + name + '\n      ' + e.message ); } };
const eq2 = ( a, b, m ) => { if ( a !== b ) throw new Error( ( m || 'not equal' ) + `: ${ a } vs ${ b }` ); };
const ok = ( v, m ) => { if ( ! v ) throw new Error( m || 'expected truthy' ); };
const strip = s => s.replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /^\s*\/\/.*$/gm, '' ).replace( /\s\/\/ .*$/gm, '' );

console.log( 'portrait-webCLI page (static)' );

test( 'every script the page loads parses (a stray edit in page.js broke the whole page once)', () => {

	const dirs = [ root, path.join( root, 'autorig' ), path.join( root, 'lib', 'facebind' ), path.join( root, 'lib', 'face' ) ];
	let n = 0;
	for ( const d of dirs ) for ( const f of fs.readdirSync( d ).filter( f => f.endsWith( '.js' ) ) ) {

		const r = spawnSync( process.execPath, [ '--input-type=module', '--check' ], { input: fs.readFileSync( path.join( d, f ) ) } );
		ok( r.status === 0, `${ f } does not parse: ${ String( r.stderr ).split( '\n' ).slice( 0, 4 ).join( ' ' ) }` );
		n ++;

	}
	ok( n >= 15, 'checked ' + n + ' files' );

} );

const html = read( 'index.html' );
const csp = ( html.match( /Content-Security-Policy" content="([^"]*)"/ ) || [] )[ 1 ] || '';

test( 'CSP: no remote scripts, no inline script except the import map (by hash), connect-src is same-origin + the VRM host', () => {

	ok( /default-src 'none'/.test( csp ) );
	const script = csp.match( /script-src ([^;]*)/ )[ 1 ];
	ok( ! /unsafe-inline|https?:/.test( script ), 'script-src is not strict: ' + script );
	const connect = csp.match( /connect-src ([^;]*)/ )[ 1 ].split( /\s+/ );
	ok( connect.every( c => [ "'self'", 'blob:', 'https://raw.githubusercontent.com' ].includes( c ) ), 'unexpected connect-src: ' + connect.join( ' ' ) );
	ok( /name="referrer" content="no-referrer"/.test( html ), 'no no-referrer policy' );
	ok( /form-action 'none'/.test( csp ) );
	ok( /worker-src 'none'/.test( csp ), "worker-src 'none' is missing: workers would bypass the egress guard" );
	ok( /style-src 'self'(;|$)/.test( csp ), 'style-src must be same-origin only (no inline styles)' );
	ok( ! /frame-src|frame-ancestors/.test( csp ) || /frame-src 'none'/.test( csp ), 'the page embeds nothing' );

} );

test( 'webcam selfie: video only, the stream is stopped after the shot, nothing is recorded or sent', () => {

	const s = strip( read( 'selfie.js' ) );
	ok( /getUserMedia/.test( s ) && /audio: false/.test( s ), 'the selfie must ask for video only' );
	ok( /getTracks\(\) \) t\.stop\(\)/.test( s ) && /stop\(\);\s*return new File/.test( s ), 'the stream must be stopped when the frame is taken' );
	ok( ! /MediaRecorder|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|indexedDB/.test( s ), 'the selfie module must not record, store or send anything' );
	ok( /pagehide/.test( read( 'page.js' ) ), 'the camera must be released when the page is left' );

} );

test( 'no inline styles or inline event handlers in the page (the CSP forbids them)', () => {

	ok( ! /<style[\s>]/.test( html ), 'inline <style>' );
	ok( ! /\sstyle="/.test( html ), 'style attribute' );
	ok( ! /\son[a-z]+="/.test( html ), 'inline event handler' );

} );

test( 'webCLI contract: status attribute, result handle, run= validation, testids, local-only identity inputs', () => {

	const p = strip( read( 'page.js' ) );
	ok( /data-webcli-status/.test( p ) && /'idle'/.test( p ) && /'running'/.test( p ) && /'done'/.test( p ) && /'error'/.test( p ), 'data-webcli-status is not driven through idle / running / done / error' );
	ok( /op: 'bind'/.test( p ) && /artifact: artifactOf\(/.test( p ) && /error: null/.test( p ), 'result shape is not { ok, op, artifact, error, meta }' );
	ok( /const OPS = \[ 'bind' \]/.test( p ) && /Unknown run=/.test( p ), 'run= is not validated' );
	ok( /IMAGE_MUST_BE_LOCAL/.test( p ) && /FACE_MUST_BE_LOCAL/.test( p ), 'a photo or face GLB can be a URL' );
	for ( const id of [ 'photo-input', 'face-input', 'vrm-input', 'vrm-url', 'bind', 'download', 'result', 'status' ] ) ok( html.includes( `data-testid="${ id }"` ), `data-testid="${ id }" is missing` );
	ok( /<body>/.test( html ) && /window\.__portrait = /.test( p ), 'window.__portrait is missing' );

} );

test( 'a bound result is a pure function of its inputs: nothing time- or random-dependent in the bind libraries', () => {

	for ( const f of [ 'glb.js', 'faceSource.js', 'bind.js', 'reshape.js', 'hairShape.js', 'hairStyle.js', 'scalp.js', 'facialHair.js', 'hair.js', 'proportions.js' ] ) {

		const s = strip( read( 'lib/facebind/' + f ) );
		ok( ! /Math\.random|Date\.now|new Date|performance\.now/.test( s ), `${ f } reads the clock or a random number` );

	}

} );


test( 'the inline import map is covered by the CSP hash', () => {

	const maps = [ ...html.matchAll( /<script type="importmap">([\s\S]*?)<\/script>/g ) ];
	ok( maps.length === 1, 'expected exactly one import map' );
	const want = `'sha256-${ crypto.createHash( 'sha256' ).update( maps[ 0 ][ 1 ] ).digest( 'base64' ) }'`;
	ok( csp.includes( want ), `CSP is missing ${ want }; re-hash the import map` );
	const inline = [ ...html.matchAll( /<script(?![^>]*\ssrc=)(?![^>]*importmap)[^>]*>/g ) ];
	ok( inline.length === 0, 'inline script found' );

} );

test( 'no CDN or other remote URL is loaded by the page, the glue, or the vendored autorigger', () => {

	for ( const f of [ 'index.html', 'page.js', 'egressGuard.js', 'autorig/faceFromImage.js', 'autorig/arkit-mapper.js', 'autorig/face-mesh-generator.js', 'autorig/texture-mapper.js' ] ) {

		const src = strip( read( f ) ).replace( /<!--[\s\S]*?-->/g, '' ).replace( /Content-Security-Policy" content="[^"]*"/, '' );
		// plain <a href> links (navigation, no data sent) to the project's own repo and to look-webCLI are allowed; nothing is loaded from them
		const urls = ( src.match( /https?:\/\/[^\s'"`)<]+/g ) || [] ).filter( u => ! /^https?:\/\/(www\.w3\.org|raw\.githubusercontent\.com\/…|github\.com\/tejaswigowda\/|look\.webcli\.app\/)/.test( u ) );
		ok( urls.length === 0, `${ f } mentions ${ urls.join( ', ' ) }` );

	}

} );

test( 'the page\'s only network call is a GET of the base VRM; photos and face GLBs are never sent anywhere', () => {

	const src = strip( read( 'page.js' ) );
	const calls = src.match( /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/g ) || [];
	ok( calls.length === 1 && calls[ 0 ] === 'fetch', `network APIs used: ${ calls.join( ', ' ) }` );
	ok( /await fetch\( target\.href \)/.test( src ), 'the fetch is not the base-VRM GET' );
	ok( /__portrait_allow\( target\.href \)/.test( src ), 'a cross-origin base VRM must be registered with the guard first' );
	ok( ! /method\s*:/.test( src ) && ! /body\s*:/.test( src ), 'a request method/body is set' );

} );

test( 'no network, storage or dynamic-import-by-URL API anywhere else in the bind, face and autorig code', () => {

	const files = [];
	const walk = ( dir, base ) => { for ( const e of fs.readdirSync( dir, { withFileTypes: true } ) ) { const p = path.join( dir, e.name ); if ( e.isDirectory() ) { if ( e.name !== '__tests__' && e.name !== 'vendor' ) walk( p, base ); } else if ( /\.(js|mjs)$/.test( e.name ) ) files.push( p ); } };
	walk( path.join( root, 'lib', 'facebind' ) ); walk( path.join( root, 'lib', 'face' ) );
	walk( path.join( root, 'autorig' ) ); files.push( path.join( root, 'preview.js' ), path.join( root, 'selfie.js' ) );
	ok( files.length >= 12, 'expected to scan the whole code base, found ' + files.length );
	for ( const f of files ) {

		const src = strip( fs.readFileSync( f, 'utf8' ) );
		const hit = src.match( /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource|RTCPeerConnection|WebTransport|localStorage|sessionStorage|indexedDB|caches|importScripts|serviceWorker|postMessage|BroadcastChannel|Worker|SharedWorker|Worklet)\b/ );
		ok( ! hit, `${ path.relative( root, f ) } uses ${ hit && hit[ 0 ] }` );
		ok( ! /\bimport\s*\(\s*[^'"\s]/.test( src ), `${ path.relative( root, f ) } has a dynamic import with a computed URL` );

	}

} );

test( 'the egress guard allows only same-origin / blob / data / the user-registered base VRM, and GET without a body', () => {

	const g = strip( read( 'egressGuard.js' ) );
	ok( /destinationOk/.test( g ) && /u\.origin === location\.origin/.test( g ) && /allowed\.has\( u\.href \)/.test( g ), 'destination allow-list is missing' );
	ok( /method !== 'GET'/.test( g ) && /hasBody/.test( g ), 'GET / no-body check is missing' );
	for ( const name of [ 'sendBeacon', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'window.open', 'Worker', 'SharedWorker', 'serviceWorker' ] ) ok( g.includes( name ), `${ name } is not blocked` );

} );

test( 'the report is built with escaped text only (file-derived strings never reach innerHTML raw)', () => {

	const p = strip( read( 'page.js' ) );
	ok( ( p.match( /innerHTML/g ) || [] ).length === 1, 'innerHTML is used outside render()' );
	ok( /const esc = /.test( p ) );
	for ( const frag of [ 'esc( u.name', 'esc( u.reason', 'esc( n )', 'esc( w )', 'esc( a.material', 'esc( report.nameResolution' ] ) ok( p.includes( frag ), `${ frag } ... is not escaped` );

} );

test( 'vendored MediaPipe files match their recorded SHA-256', () => {

	const readme = read( 'vendor/mediapipe/README.md' );
	for ( const f of [ 'vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'face_landmarker.task', 'hair_segmenter.tflite' ] ) {

		const h = sha( 'vendor/mediapipe/' + f, 'hex' );
		ok( readme.includes( `${ h }  ${ f }` ), `${ f }: hash ${ h } is not in the README` );

	}

} );

console.log( `${ passed } passed, ${ failed } failed` );
process.exit( failed ? 1 : 0 );
