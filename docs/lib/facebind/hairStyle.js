// Hair STYLE: re-lay the VRM's existing hair cards (the locks) into a different texture (wavy, curly, coily) and
// give the hair a different cut (crop, bob, long, afro), on top of the silhouette matching in hairShape.js.
//
// The VRM's hair is a set of card meshes (ribbons, one per lock). This module keeps every card's topology, UVs,
// width and bone weights and only moves vertices, so the file stays rig-safe (same vertices, same attributes):
//   · texture: each lock is bent along a helix around its own strand direction (amplitude, turns per meter and
//     shrinkage set the texture), with a phase per lock so neighbors do not move in lockstep
//   · cut: a preset reference silhouette (top, width, length, fringe) that hairShape.js warps the hair toward
// What it cannot do: change the card structure, so braids, buns, ponytails and other shapes that need new geometry
// are out of reach. Pure: arrays in, arrays out.

const clamp = ( v, a, b ) => Math.min( b, Math.max( a, v ) );
const smooth = t => t * t * ( 3 - 2 * t );
const sub = ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];
const cross = ( a, b ) => [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const len = a => Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] );
const unit = a => { const l = len( a ); return l > 1e-9 ? [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ] : null; };

/** Texture presets. turns = helix turns per meter of strand, amp = helix radius (m), shrink = how much shorter the curled lock is, puff = extra volume, widen = how much wider each lock's ribbon is made (curls open gaps between locks, wider locks close them). */
export const TEXTURES = {
	straight: null,
	wavy: { turns: 7, amp: 0.005, shrink: 0.02, puff: 1.02, widen: 1.2 },
	curly: { turns: 14, amp: 0.008, shrink: 0.05, puff: 1.08, widen: 1.3 },
	coily: { turns: 24, amp: 0.011, shrink: 0.08, puff: 1.15, widen: 1.4 },
};

/** Cut presets: reference silhouettes (the same units as a photo's) and the limits they may use. Applied by hairShape.js. */
export const CUTS = {
	crop: { ref: { topV: 1.5, widthW: 1.05, lengthV: - 0.15, hairlineV: 0.8 }, limits: { volume: [ 0.94, 1.2 ], length: [ 0.1, 1.6 ] } },
	bob: { ref: { topV: 1.55, widthW: 1.4, lengthV: - 1.0, hairlineV: 0.3 }, limits: { volume: [ 0.94, 1.3 ] } },
	long: { ref: { topV: 1.6, widthW: 1.4, lengthV: - 2.6, hairlineV: 0.45 }, limits: { volume: [ 0.94, 1.3 ], length: [ 0.6, 2.8 ] } },
	afro: { ref: { topV: 1.95, widthW: 1.95, lengthV: - 0.15, hairlineV: 0.75 }, limits: { volume: [ 0.94, 1.6 ], top: [ 0.92, 1.35 ], length: [ 0.1, 1.6 ] }, texture: 'coily' },
};

/** Split a primitive set into cards (connected components of the triangle mesh). @returns {number[][]} vertex ids per card */
export function cardsOf( triangleIndexLists ) {

	const parent = new Map();
	const find = x => { let r = x; while ( parent.get( r ) !== r ) r = parent.get( r ); while ( parent.get( x ) !== r ) { const n = parent.get( x ); parent.set( x, r ); x = n; } return r; };
	for ( const idx of triangleIndexLists ) for ( const v of idx ) if ( ! parent.has( v ) ) parent.set( v, v );
	for ( const idx of triangleIndexLists ) {

		for ( let t = 0; t + 2 < idx.length; t += 3 ) for ( const k of [ 1, 2 ] ) { const a = find( idx[ t ] ), b = find( idx[ t + k ] ); if ( a !== b ) parent.set( a, b ); }

	}
	const cards = new Map();
	for ( const v of parent.keys() ) { const r = find( v ); if ( ! cards.has( r ) ) cards.set( r, [] ); cards.get( r ).push( v ); }
	return [ ...cards.values() ].map( c => c.sort( ( a, b ) => a - b ) ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] );

}

/**
 * Make every card wider across the strand, about the card's own center line. Re-laid locks drift apart; wider ribbons keep them
 * overlapping so the scalp does not show. The ribbon's length is unchanged. Vertices are binned along the strand and each bin is
 * scaled about its own mean.
 * @returns {Float32Array}
 */
export function widenCards( positions, cards, factor ) {

	const out = Float32Array.from( positions );
	if ( ! ( factor > 1 ) ) return out;
	for ( const card of cards ) {

		if ( card.length < 12 ) continue;
		const P = i => [ positions[ i * 3 ], positions[ i * 3 + 1 ], positions[ i * 3 + 2 ] ];
		const c = [ 0, 0, 0 ]; for ( const i of card ) { const p = P( i ); c[ 0 ] += p[ 0 ] / card.length; c[ 1 ] += p[ 1 ] / card.length; c[ 2 ] += p[ 2 ] / card.length; }
		// the strand direction: from the card's center toward its farthest vertex (the tip side), sign does not matter
		let far = card[ 0 ], fd = - 1; for ( const i of card ) { const d = len( sub( P( i ), c ) ); if ( d > fd ) { fd = d; far = i; } }
		const d = unit( sub( P( far ), c ) ); if ( ! d ) continue;
		const bins = new Map();
		for ( const i of card ) { const k = Math.round( dot( sub( P( i ), c ), d ) / 0.004 ); if ( ! bins.has( k ) ) bins.set( k, [] ); bins.get( k ).push( i ); }
		for ( const ids of bins.values() ) {

			if ( ids.length < 2 ) continue;
			const mean = [ 0, 0, 0 ]; for ( const i of ids ) { const p = P( i ); mean[ 0 ] += p[ 0 ] / ids.length; mean[ 1 ] += p[ 1 ] / ids.length; mean[ 2 ] += p[ 2 ] / ids.length; }
			for ( const i of ids ) { const p = P( i ); for ( let a = 0; a < 3; a ++ ) out[ i * 3 + a ] = mean[ a ] + ( p[ a ] - mean[ a ] ) * factor; }

		}

	}
	return out;

}

// a deterministic phase that varies smoothly over the scalp, so neighboring locks curl together and keep covering each other
const phaseAt = R => 2 * Math.PI * ( R[ 0 ] * 17 + R[ 1 ] * 11 + R[ 2 ] * 13 );

/**
 * Re-lay every card as a helix around its own strand direction.
 * @param {Float32Array} positions all positions of the accessor
 * @param {number[][]} cards vertex ids per card
 * @param {{eyeY:number,E:number,zc:number}} m face frame
 * @param {string} texture 'straight' | 'wavy' | 'curly' | 'coily'
 * @returns {{ positions: Float32Array, tangents: Map<number, {from:number[], to:number[]}> }|null} null for straight
 */
export function relayCards( positions, cards, m, texture ) {

	const t = TEXTURES[ texture ];
	if ( ! t ) return null;
	const out = Float32Array.from( positions );
	const tangents = new Map();
	const C = [ 0, m.eyeY + 0.3 * m.E, m.zc ]; // about the middle of the skull

	for ( const card of cards ) {

		if ( card.length < 12 ) continue; // the tiny outline / shadow cards are left alone
		const P = i => [ positions[ i * 3 ], positions[ i * 3 + 1 ], positions[ i * 3 + 2 ] ];
		const byRoot = [ ...card ].sort( ( a, b ) => len( sub( P( a ), C ) ) - len( sub( P( b ), C ) ) );
		const nRoot = Math.max( 2, Math.round( card.length * 0.1 ) );
		const R = [ 0, 0, 0 ]; for ( const i of byRoot.slice( 0, nRoot ) ) { const p = P( i ); R[ 0 ] += p[ 0 ] / nRoot; R[ 1 ] += p[ 1 ] / nRoot; R[ 2 ] += p[ 2 ] / nRoot; }
		let Lmax = 0; for ( const i of card ) Lmax = Math.max( Lmax, len( sub( P( i ), R ) ) );
		if ( Lmax < 0.03 ) continue;
		const phi0 = phaseAt( R );

		for ( const i of card ) {

			const p = P( i ), v = sub( p, R ), s = len( v );
			const d = unit( v ); if ( ! d || s < 1e-4 ) continue;
			let e1 = unit( cross( d, [ 0, 1, 0 ] ) ); if ( ! e1 || Math.abs( dot( d, [ 0, 1, 0 ] ) ) > 0.95 ) e1 = unit( cross( d, [ 1, 0, 0 ] ) );
			const e2 = cross( d, e1 );
			const ramp = smooth( clamp( s / 0.04, 0, 1 ) ); // the root stays on the scalp
			const sh = t.shrink * smooth( clamp( s / Lmax, 0, 1 ) );
			const phi = 2 * Math.PI * t.turns * s + phi0;
			const A = t.amp * ramp;
			const q = [ R[ 0 ] + v[ 0 ] * ( 1 - sh ) + A * ( Math.cos( phi ) * e1[ 0 ] + Math.sin( phi ) * e2[ 0 ] ), R[ 1 ] + v[ 1 ] * ( 1 - sh ) + A * ( Math.cos( phi ) * e1[ 1 ] + Math.sin( phi ) * e2[ 1 ] ), R[ 2 ] + v[ 2 ] * ( 1 - sh ) + A * ( Math.cos( phi ) * e1[ 2 ] + Math.sin( phi ) * e2[ 2 ] ) ];
			// outward puff away from the middle of the skull (radial, so a lock keeps its place on the scalp), growing toward the tips
			const k = 1 + ( t.puff - 1 ) * smooth( clamp( s / Lmax, 0, 1 ) );
			const o = [ C[ 0 ] + ( q[ 0 ] - C[ 0 ] ) * k, C[ 1 ] + ( q[ 1 ] - C[ 1 ] ) * k, C[ 2 ] + ( q[ 2 ] - C[ 2 ] ) * k ];
			out[ i * 3 ] = o[ 0 ]; out[ i * 3 + 1 ] = o[ 1 ]; out[ i * 3 + 2 ] = o[ 2 ];

			// the strand direction before and after (for carrying the normal along): the helix tilts it by amp * 2 pi * turns
			const k2 = 2 * Math.PI * t.turns * t.amp * ramp * 0.9;
			const dn = unit( [ d[ 0 ] * ( 1 - sh ) + k2 * ( - Math.sin( phi ) * e1[ 0 ] + Math.cos( phi ) * e2[ 0 ] ), d[ 1 ] * ( 1 - sh ) + k2 * ( - Math.sin( phi ) * e1[ 1 ] + Math.cos( phi ) * e2[ 1 ] ), d[ 2 ] * ( 1 - sh ) + k2 * ( - Math.sin( phi ) * e1[ 2 ] + Math.cos( phi ) * e2[ 2 ] ) ] );
			if ( dn ) tangents.set( i, { from: d, to: dn } );

		}

	}
	return { positions: out, tangents };

}

/** Rotate a normal by the minimal rotation that takes direction `from` to `to`. */
export function carryNormal( n, from, to ) {

	const axis = cross( from, to ), s = len( axis ), c = dot( from, to );
	if ( s < 1e-9 ) return n;
	const k = [ axis[ 0 ] / s, axis[ 1 ] / s, axis[ 2 ] / s ], ang = Math.atan2( s, c ), ca = Math.cos( ang ), sa = Math.sin( ang );
	const kxn = cross( k, n ), kdn = dot( k, n );
	return [ n[ 0 ] * ca + kxn[ 0 ] * sa + k[ 0 ] * kdn * ( 1 - ca ), n[ 1 ] * ca + kxn[ 1 ] * sa + k[ 1 ] * kdn * ( 1 - ca ), n[ 2 ] * ca + kxn[ 2 ] * sa + k[ 2 ] * kdn * ( 1 - ca ) ];

}

// ── guessing the texture from the photo ─────────────────────────────────────

/**
 * A rough texture estimate from the hair pixels: how ordered the strand directions are (structure-tensor coherence of the
 * luminance inside the hair mask) and how ragged the hair outline is. Straight hair is ordered; curly hair is not.
 * It is an estimate and it is uncalibrated: dark or low-contrast hair gives `unknown`, and the page lets you choose.
 * @returns {{ kind: 'straight'|'wavy'|'curly'|'coily'|'unknown', coherence: number, contrast: number, roughness: number }|null}
 */
export function classifyHairTexture( rgba, mask, { width, height, hairValue = 1 } ) {

	const lum = i => 0.2126 * rgba[ i * 4 ] + 0.7152 * rgba[ i * 4 + 1 ] + 0.0722 * rgba[ i * 4 + 2 ];
	const hair = i => mask[ i ] === hairValue;
	let jxx = 0, jyy = 0, jxy = 0, mag = 0, n = 0, area = 0, boundary = 0;

	for ( let y = 3; y < height - 3; y ++ ) {

		for ( let x = 3; x < width - 3; x ++ ) {

			const i = y * width + x;
			if ( ! hair( i ) ) continue;
			area ++;
			if ( ! hair( i - 1 ) || ! hair( i + 1 ) || ! hair( i - width ) || ! hair( i + width ) ) { boundary ++; continue; }
			// interior only (two pixels in from the edge), so the hair/background edge does not dominate
			let interior = true;
			for ( const o of [ - 2, 2, - 2 * width, 2 * width ] ) if ( ! hair( i + o ) ) { interior = false; break; }
			if ( ! interior ) continue;
			const gx = ( lum( i + 1 ) - lum( i - 1 ) ) / 2, gy = ( lum( i + width ) - lum( i - width ) ) / 2;
			jxx += gx * gx; jyy += gy * gy; jxy += gx * gy; mag += Math.hypot( gx, gy ); n ++;

		}

	}
	if ( area < 200 || n < 100 ) return null;
	const trace = jxx + jyy;
	const coherence = trace > 1e-9 ? Math.sqrt( ( jxx - jyy ) ** 2 + 4 * jxy * jxy ) / trace : 0;
	const contrast = mag / n;
	const roughness = boundary / ( 2 * Math.sqrt( Math.PI * area ) );
	const disorder = ( 1 - coherence ) * 0.7 + clamp( ( roughness - 1.2 ) / 2.5, 0, 1 ) * 0.3;
	let kind = 'unknown';
	if ( contrast >= 2.5 ) kind = disorder < 0.45 ? 'straight' : disorder < 0.62 ? 'wavy' : disorder < 0.8 ? 'curly' : 'coily';
	const r = v => +v.toFixed( 3 );
	return { kind, coherence: r( coherence ), contrast: r( contrast ), roughness: r( roughness ) };

}
