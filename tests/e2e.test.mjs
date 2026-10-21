// Run: node tests/e2e.test.mjs
// The page in a real browser (Playwright / Chromium): zero egress, the webCLI contract (run=bind, status, result handle),
// determinism, and the face-GLB path with the network switched off. The photo path runs when a photo is supplied:
//   PORTRAIT_TEST_IMAGE=/path/to/face.jpg node tests/e2e.test.mjs
// (the repository ships no photo: a face is identity data, and a test must not need one).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../server.js';
import { writeGLB } from '../docs/lib/facebind/glb.js';
import { ARKIT_52 } from '../docs/lib/facebind/bind.js';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const localPhoto = path.join( here, 'fixtures-local', 'portrait.jpg' );
const photo = process.env.PORTRAIT_TEST_IMAGE || ( fs.existsSync( localPhoto ) ? localPhoto : null );

let passed = 0, failed = 0, skipped = 0;
const test = async ( name, fn ) => { try { await fn(); passed ++; console.log( '  ✓ ' + name ); } catch ( e ) { failed ++; console.log( '  ✗ ' + name + '\n      ' + ( e.stack || e.message ).split( '\n' ).slice( 0, 4 ).join( '\n      ' ) ); } };
const skip = name => { skipped ++; console.log( '  - ' + name + ' (skipped)' ); };
const ok = ( v, m ) => { if ( ! v ) throw new Error( m || 'expected truthy' ); };
const eq = ( a, b, m ) => { if ( a !== b ) throw new Error( ( m || 'not equal' ) + `: ${ a } vs ${ b }` ); };

// a face-blendshape GLB with the 52 ARKit morph names and no geometry: all the bind reads from a face GLB is the names (and a skin color)
const faceGLB = Buffer.from( writeGLB( {
	json: {
		asset: { version: '2.0' }, nodes: [ { name: 'faceMesh', mesh: 0, extras: { skinColor: { r: 0.8, g: 0.6, b: 0.5 } } } ],
		meshes: [ { primitives: [ { attributes: { POSITION: 0 }, targets: ARKIT_52.map( () => ( { POSITION: 0 } ) ), extras: { targetNames: ARKIT_52 } } ] } ],
	},
	chunks: [ { type: 0x004e4942, data: new Uint8Array( 8 ) } ],
} ) );
const faceFile = { name: 'face.glb', mimeType: 'model/gltf-binary', buffer: faceGLB };

const srv = createServer();
await new Promise( r => srv.listen( 0, '127.0.0.1', r ) );
const origin = `http://127.0.0.1:${ srv.address().port }`;
const browser = await chromium.launch( { args: [ '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader' ] } );

async function open( query = '', { offline = false } = {} ) {

	const ctx = await browser.newContext( { viewport: { width: 1280, height: 900 } } );
	const page = await ctx.newPage();
	const log = { requests: [], console: [], errors: [] };
	page.on( 'request', r => log.requests.push( { method: r.method(), url: r.url(), body: r.postData() } ) );
	page.on( 'console', m => { if ( m.type() === 'error' ) log.console.push( m.text() ); } );
	page.on( 'pageerror', e => log.errors.push( e.message ) );
	await page.goto( `${ origin }/index.html${ query }` );
	await page.waitForFunction( () => /^(ready|unavailable)/.test( document.getElementById( 'model' ).textContent ), null, { timeout: 120000 } );
	if ( offline ) await ctx.setOffline( true );
	return { ctx, page, log };

}
const status = page => page.getAttribute( 'body', 'data-webcli-status' );
const settled = page => page.waitForSelector( 'body[data-webcli-status=done], body[data-webcli-status=error]', { timeout: 180000 } );
const resultOf = page => page.evaluate( () => { const r = window.__webcli_result; return r && { ok: r.ok, op: r.op, error: r.error, artifact: r.artifact && { ...r.artifact }, meta: r.meta && { code: r.meta.code, mapped: r.meta.mapped, sourceMorphs: r.meta.sourceMorphs, source: r.meta.source, faceGlb: r.meta.faceGlb && { ...r.meta.faceGlb } } }; } );
const bytesOf = dataUrl => Buffer.from( dataUrl.split( ',' )[ 1 ], 'base64' );
const external = log => log.requests.filter( r => ! r.url.startsWith( origin ) && ! /^(blob|data):/.test( r.url ) );

console.log( 'portrait-webCLI (browser)' );

await test( 'loading the page: only same-origin GETs without a body, no worker or service worker, no CSP violation, status idle', async () => {

	const { ctx, page, log } = await open();
	eq( await status( page ), 'idle' );
	ok( log.requests.length > 5, 'the page made no requests?' );
	ok( external( log ).length === 0, 'external request: ' + external( log ).map( r => r.url ).join( ', ' ) );
	ok( log.requests.every( r => r.method === 'GET' && ! r.body ), 'a request is not a bodyless GET' );
	eq( await page.evaluate( () => navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then( r => r.length ) : 0 ), 0, 'a service worker is registered' );
	ok( ! log.console.some( c => /Content Security Policy|Refused to/i.test( c ) ), 'CSP violation: ' + log.console.join( ' | ' ) );
	eq( log.errors.length, 0, 'page error: ' + log.errors.join( ' | ' ) );
	const names = await page.evaluate( () => [ 'imageFile', 'faceFile', 'vrmFile', 'vrmUrl', 'bind', 'download', 'report', 'statusText' ].every( id => document.getElementById( id ) ) );
	ok( names, 'a control the contract names is missing' );
	await ctx.close();

} );

await test( 'run=bind with a face GLB: status running -> done, result { ok, op, artifact, error, meta }, a valid glTF binary', async () => {

	const { ctx, page, log } = await open( '?vrm=male&run=bind' );
	await page.setInputFiles( '[data-testid=face-input]', faceFile );
	await settled( page );
	eq( await status( page ), 'done' );
	const r = await resultOf( page );
	ok( r.ok && r.op === 'bind' && r.error === null, JSON.stringify( r ) );
	eq( r.artifact.mime, 'model/gltf-binary' );
	eq( r.artifact.name, 'VRoid_V110_Male_v1.1.3.bound.vrm' );
	ok( r.artifact.size > 1e6 && r.artifact.dataUrl.startsWith( 'data:model/gltf-binary;base64,' ) );
	const bytes = bytesOf( r.artifact.dataUrl );
	eq( bytes.length, r.artifact.size, 'size does not match the data URL' );
	eq( bytes.subarray( 0, 4 ).toString(), 'glTF' );
	eq( r.meta.source, 'face-glb' );
	ok( r.meta.mapped > 0 && r.meta.sourceMorphs === 52, `mapped ${ r.meta.mapped } of ${ r.meta.sourceMorphs }` );
	ok( await page.isVisible( '[data-testid=download]' ), 'the download link is not shown' );
	ok( external( log ).length === 0, 'external request: ' + external( log ).map( r => r.url ).join( ', ' ) );
	ok( log.requests.every( r => r.method === 'GET' && ! r.body ), 'a request is not a bodyless GET' );
	await ctx.close();

} );

await test( 'deterministic: the same inputs give byte-identical output, in two fresh pages', async () => {

	const out = [];
	for ( let i = 0; i < 2; i ++ ) {

		const { ctx, page } = await open( '?vrm=male&run=bind' );
		await page.setInputFiles( '[data-testid=face-input]', faceFile );
		await settled( page );
		out.push( bytesOf( ( await resultOf( page ) ).artifact.dataUrl ) );
		await ctx.close();

	}
	ok( out[ 0 ].equals( out[ 1 ] ), 'two runs differ' );

} );

await test( 'the female base is selectable by name', async () => {

	const { ctx, page } = await open( '?vrm=female&run=bind' );
	await page.setInputFiles( '[data-testid=face-input]', faceFile );
	await settled( page );
	eq( ( await resultOf( page ) ).artifact.name, 'VRoid_V110_Female_v1.1.3.bound.vrm' );
	await ctx.close();

} );

await test( 'the look editor opens on the bound VRM inside the page (same origin), and Done brings the edited VRM back into the result and the download', async () => {

	const { ctx, page, log } = await open( '?vrm=male&run=bind' );
	await page.setInputFiles( '[data-testid=face-input]', faceFile );
	await settled( page );
	const before = await resultOf( page );
	await page.click( '[data-testid=edit]' );
	ok( await page.isVisible( '#editOverlay' ), 'the overlay did not open' );
	const frame = page.frameLocator( '#editFrame' );
	await frame.locator( 'canvas' ).first().waitFor( { timeout: 60000 } );
	// the editor needs a moment to parse the VRM it was handed; press Done until it answers
	let closed = false;
	for ( let i = 0; i < 8 && ! closed; i ++ ) {

		await page.waitForTimeout( 4000 );
		if ( await page.isEnabled( '[data-testid=edit-done]' ) ) await page.click( '[data-testid=edit-done]' );
		closed = await page.waitForSelector( '#editOverlay', { state: 'hidden', timeout: 12000 } ).then( () => true, () => false );

	}
	ok( closed, 'Done never brought the VRM back' );
	await page.waitForSelector( 'body[data-webcli-status=done]', { timeout: 60000 } );
	const after = await resultOf( page );
	ok( after.ok && after.op === 'bind' && after.artifact.name === before.artifact.name, JSON.stringify( after ) );
	eq( await page.evaluate( () => window.__webcli_result.meta.edited ), true, 'the result is not marked edited' );
	eq( bytesOf( after.artifact.dataUrl ).subarray( 0, 4 ).toString(), 'glTF' );
	ok( ( await page.textContent( '[data-testid=download]' ) ).includes( 'edited' ), 'the download link is not the edited VRM' );
	ok( external( log ).length === 0, 'external request: ' + external( log ).map( r => r.url ).join( ', ' ) );
	ok( log.requests.every( r => r.method === 'GET' && ! r.body ), 'a request is not a bodyless GET' );
	await ctx.close();

} );

await test( 'Cancel closes the editor and keeps the bound VRM as it was; the editor is refused before a bind', async () => {

	const { ctx, page } = await open( '?vrm=male&run=bind' );
	await page.evaluate( () => document.getElementById( 'editBtn' ).click() ); // the button is hidden until a bind: a script can still press it
	ok( ! ( await page.isVisible( '#editOverlay' ) ), 'the editor opened with nothing bound' );
	await page.setInputFiles( '[data-testid=face-input]', faceFile );
	await settled( page );
	const before = ( await resultOf( page ) ).artifact.size;
	await page.click( '[data-testid=edit]' );
	await page.click( '[data-testid=edit-cancel]' );
	ok( ! ( await page.isVisible( '#editOverlay' ) ) );
	eq( ( await resultOf( page ) ).artifact.size, before );
	eq( await page.evaluate( () => window.__webcli_result.meta.edited ), undefined );
	await ctx.close();

} );

await test( 'works with the network switched off, once the page has loaded (local VRM file: the bundled bases are fetched on Bind)', async () => {

	const { ctx, page, log } = await open( '?run=bind', { offline: true } );
	const before = log.requests.length;
	await page.setInputFiles( '[data-testid=vrm-input]', path.join( here, '..', 'docs', 'base', 'VRoid_V110_Male_v1.1.3.vrm' ) );
	await page.setInputFiles( '[data-testid=face-input]', faceFile );
	await settled( page );
	eq( await status( page ), 'done', ( await resultOf( page ) ).error );
	ok( ( await resultOf( page ) ).ok );
	eq( log.requests.filter( r => ! /^(blob|data):/.test( r.url ) ).length, before, 'a request was attempted after the page loaded' );
	await ctx.close();

} );

await test( 'an unknown run= is an error with a clear message, and nothing is bound', async () => {

	const { ctx, page } = await open( '?run=nope' );
	eq( await status( page ), 'error' );
	const r = await resultOf( page );
	ok( r && ! r.ok && r.artifact === null && /Unknown run=nope/.test( r.error ), JSON.stringify( r ) );
	await page.setInputFiles( '[data-testid=face-input]', faceFile );
	await page.waitForTimeout( 500 );
	eq( await status( page ), 'error', 'a bad run= must not start a bind' );
	await ctx.close();

} );

await test( 'identity data is never a URL: ?image= and ?face= are refused, and window.__portrait.run rejects a string', async () => {

	const { ctx, page, log } = await open( '?image=http://127.0.0.1:1/x.jpg&face=https://example.com/f.glb' );
	ok( /local-only/.test( await page.textContent( '#statusText' ) ), 'no refusal message' );
	ok( ! log.requests.some( r => ! r.url.startsWith( origin + '/index.html' ) && /example\.com|127\.0\.0\.1:1\//.test( r.url ) ), 'the URL was fetched' );
	const r = await page.evaluate( () => window.__portrait.run( { image: 'https://example.com/me.jpg' } ) );
	ok( ! r.ok && r.meta.code === 'IMAGE_MUST_BE_LOCAL', JSON.stringify( r ) );
	eq( await status( page ), 'error' );
	await ctx.close();

} );

await test( 'the egress guard blocks a POST, a beacon, a WebSocket and a Worker from the page, and logs them', async () => {

	const { ctx, page, log } = await open();
	const out = await page.evaluate( async () => {
		const res = {};
		try { await fetch( location.href, { method: 'POST', body: 'x' } ); res.post = 'sent'; } catch ( e ) { res.post = 'blocked'; }
		try { await fetch( 'https://example.com/' ); res.cross = 'sent'; } catch ( e ) { res.cross = 'blocked'; }
		res.beacon = navigator.sendBeacon( '/x', 'x' ) === false ? 'blocked' : 'sent';
		try { new WebSocket( 'ws://127.0.0.1:1' ); res.ws = 'sent'; } catch ( e ) { res.ws = 'blocked'; }
		try { new Worker( 'page.js' ); res.worker = 'sent'; } catch ( e ) { res.worker = 'blocked'; }
		res.log = window.__portrait_net.filter( r => r.blocked ).length;
		return res;
	} );
	ok( out.post === 'blocked' && out.cross === 'blocked' && out.beacon === 'blocked' && out.ws === 'blocked' && out.worker === 'blocked', JSON.stringify( out ) );
	ok( out.log >= 5, 'blocked attempts were not logged: ' + out.log );
	ok( external( log ).length === 0 );
	await ctx.close();

} );

if ( photo ) {

	await test( `run=bind with a photo (${ path.basename( photo ) }): face GLB made on device, bound VRM out, deterministic, no egress`, async () => {

		const out = [];
		for ( let i = 0; i < 2; i ++ ) {

			const { ctx, page, log } = await open( '?vrm=male&run=bind', { offline: i === 1 } );
			// offline, the bundled base cannot be fetched on Bind, so the second run hands the same file over locally
			if ( i === 1 ) await page.setInputFiles( '[data-testid=vrm-input]', path.join( here, '..', 'docs', 'base', 'VRoid_V110_Male_v1.1.3.vrm' ) );
			await page.setInputFiles( '[data-testid=photo-input]', photo );
			await settled( page );
			const r = await resultOf( page );
			ok( r.ok, r.error );
			eq( r.meta.source, 'photo' );
			ok( r.meta.faceGlb && r.meta.faceGlb.size > 1e4, 'no face GLB artifact' );
			eq( bytesOf( r.meta.faceGlb.dataUrl ).subarray( 0, 4 ).toString(), 'glTF' );
			ok( external( log ).length === 0, 'external request: ' + external( log ).map( x => x.url ).join( ', ' ) );
			out.push( bytesOf( r.artifact.dataUrl ) );
			if ( i === 0 ) { fs.mkdirSync( path.join( here, 'out' ), { recursive: true } ); await page.screenshot( { path: path.join( here, 'out', 'photo-run.png' ), fullPage: true } ); }
			await ctx.close();

		}
		ok( out[ 0 ].equals( out[ 1 ] ), 'two photo runs differ (the second one ran with the network off)' );

	} );

} else skip( 'run=bind with a photo (set PORTRAIT_TEST_IMAGE, or put a photo at tests/fixtures-local/portrait.jpg)' );

await browser.close();
srv.close();
console.log( `${ passed } passed, ${ failed } failed${ skipped ? `, ${ skipped } skipped` : '' }` );
process.exit( failed ? 1 : 0 );
