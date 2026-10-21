// Minimal, deterministic GLB container read/write. The JSON chunk is the only chunk this family
// ever rewrites; every other chunk (BIN: vertices, skin weights, morph deltas, images) is carried
// through byte for byte.

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a;

const toU8 = input => input instanceof Uint8Array ? input : new Uint8Array( input );

export class GLBError extends Error {

	constructor( code, message ) {

		super( message );
		this.code = code;

	}

}

/** @returns {{ json: object, chunks: {type:number, data:Uint8Array}[] }} chunks = every non-JSON chunk, in file order */
export function parseGLB( input ) {

	const u8 = toU8( input );
	if ( u8.byteLength < 20 ) throw new GLBError( 'NOT_GLB', 'not a GLB file (too small)' );
	const dv = new DataView( u8.buffer, u8.byteOffset, u8.byteLength );
	if ( dv.getUint32( 0, true ) !== MAGIC ) throw new GLBError( 'NOT_GLB', 'not a GLB/VRM file (bad magic)' );
	if ( dv.getUint32( 4, true ) !== 2 ) throw new GLBError( 'NOT_GLB', 'only glTF 2.0 binaries are supported' );

	let json = null;
	const chunks = [];
	let off = 12;
	const end = Math.min( dv.getUint32( 8, true ), u8.byteLength );
	while ( off + 8 <= end ) {

		const len = dv.getUint32( off, true ), type = dv.getUint32( off + 4, true );
		const data = u8.subarray( off + 8, off + 8 + len );
		if ( type === JSON_CHUNK && json === null ) json = JSON.parse( new TextDecoder().decode( data ) );
		else chunks.push( { type, data } );
		off += 8 + len;

	}
	if ( ! json ) throw new GLBError( 'NOT_GLB', 'GLB has no JSON chunk' );
	return { json, chunks };

}

/** Same JSON + same chunks → same bytes. */
export function writeGLB( { json, chunks } ) {

	const text = new TextEncoder().encode( JSON.stringify( json ) );
	const jsonLen = Math.ceil( text.length / 4 ) * 4;
	const total = 12 + 8 + jsonLen + chunks.reduce( ( n, c ) => n + 8 + c.data.length, 0 );
	const out = new Uint8Array( total );
	const dv = new DataView( out.buffer );
	dv.setUint32( 0, MAGIC, true ); dv.setUint32( 4, 2, true ); dv.setUint32( 8, total, true );
	dv.setUint32( 12, jsonLen, true ); dv.setUint32( 16, JSON_CHUNK, true );
	out.set( text, 20 );
	out.fill( 0x20, 20 + text.length, 20 + jsonLen ); // JSON is space-padded
	let off = 20 + jsonLen;
	for ( const c of chunks ) {

		dv.setUint32( off, c.data.length, true ); dv.setUint32( off + 4, c.type, true );
		out.set( c.data, off + 8 );
		off += 8 + c.data.length;

	}
	return out;

}
