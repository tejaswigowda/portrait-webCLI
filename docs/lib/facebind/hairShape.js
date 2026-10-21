// Hair SHAPE: the silhouette of the photo's hair mask, the silhouette of the VRM's hair mesh, and a warp
// that moves the VRM's existing hairstyle toward the photo's silhouette. It scales and shifts what the VRM
// has, within limits; it cannot change the cut (curls, braids, a different style). Pure: arrays in, numbers out.
//
// Both silhouettes are measured the same way, in the same head units (u = sideways in head widths W, v = up
// from the eye line in units of E, the chin-to-eye-line height), so photo size and distance drop out:
//   half widths   how far the hair reaches out to the image-right and image-left, per height band
//   crown         how high the hair reaches, per sideways band
//   fringe        where the hair's lower edge sits over the forehead, per sideways band
//   scalar summary (top, width, length, hairline), used when a profile is not available
//
// "Image-right" is the right of the picture. On a VRM that faces -z that is model -x (see uOf).

const clamp = ( v, a, b ) => Math.min( b, Math.max( a, v ) );
const lerp = ( a, b, t ) => a + ( b - a ) * t;
const smooth = t => t * t * ( 3 - 2 * t );
const round = ( v, d = 3 ) => v === null || v === undefined ? null : +v.toFixed( d );

/** The measurement grid. Bin i covers [lo + i * step, lo + (i + 1) * step). */
export const GRID = { v: { lo: - 2.0, step: 0.25, n: 18 }, u: { lo: - 0.6, step: 0.1, n: 12 } };
const vBin = v => { const i = Math.floor( ( v - GRID.v.lo ) / GRID.v.step ); return i >= 0 && i < GRID.v.n ? i : - 1; };
const uBin = u => { const i = Math.floor( ( u - GRID.u.lo ) / GRID.u.step ); return i >= 0 && i < GRID.u.n ? i : - 1; };
const vCenter = i => GRID.v.lo + ( i + 0.5 ) * GRID.v.step;
const uCenter = j => GRID.u.lo + ( j + 0.5 ) * GRID.u.step;
/** Fringe edge: the lowest hair above this height (just above the eye line), so bangs that reach the brows count. */
const FRINGE_FROM = 0.05;
const nulls = n => Array.from( { length: n }, () => null );

function newProfile() {

	return { halfR: nulls( GRID.v.n ), halfL: nulls( GRID.v.n ), topByU: nulls( GRID.u.n ), lineByU: nulls( GRID.u.n ) };

}

// ── from the photo ──────────────────────────────────────────────────────────

/**
 * @param {{x:number,y:number}[]} landmarks MediaPipe landmarks (0–1 of the image)
 * @param {Uint8Array} mask width*height, `hairValue` = hair
 * @returns {object|null} { topV, widthW, lengthV, hairlineV, profile, cropped } (null where the photo cannot tell)
 */
export function hairShapeFromMask( landmarks, mask, { width, height, hairValue = 1 } ) {

	if ( ! landmarks || landmarks.length < 468 ) return null;
	const P = i => [ landmarks[ i ].x * width, - landmarks[ i ].y * height ];
	const mid = ( ...ids ) => { const p = ids.map( P ); return [ p.reduce( ( s, a ) => s + a[ 0 ], 0 ) / p.length, p.reduce( ( s, a ) => s + a[ 1 ], 0 ) / p.length ]; };

	const [ ex, ey ] = mid( 33, 133, 263, 362 );
	const roll = Math.atan2( P( 263 )[ 1 ] - P( 33 )[ 1 ], P( 263 )[ 0 ] - P( 33 )[ 0 ] );
	const c = Math.cos( roll ), s = Math.sin( roll );
	const rot = ( x, y ) => [ ( x - ex ) * c + ( y - ey ) * s, - ( x - ex ) * s + ( y - ey ) * c ]; // level the eye line
	const earR = rot( ...P( 234 ) ), earL = rot( ...P( 454 ) ), chin = rot( ...P( 152 ) );
	const W = Math.hypot( earR[ 0 ] - earL[ 0 ], earR[ 1 ] - earL[ 1 ] ), E = - chin[ 1 ];
	if ( ! ( W > 0 ) || ! ( E > 0 ) ) return null;

	let topV = - Infinity, bottomV = Infinity, uMin = Infinity, uMax = - Infinity, lineV = Infinity, n = 0, lineN = 0;
	const cropped = { top: false, side: false, bottom: false };
	const prof = newProfile();
	const rowCut = new Array( GRID.v.n ).fill( false ), colCut = new Array( GRID.u.n ).fill( false );
	const rowN = new Array( GRID.v.n ).fill( 0 ), colN = new Array( GRID.u.n ).fill( 0 ), lineCount = new Array( GRID.u.n ).fill( 0 );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			if ( mask[ y * width + x ] !== hairValue ) continue;
			n ++;
			const edgeX = x === 0 || x === width - 1, edgeTop = y === 0;
			if ( edgeTop ) cropped.top = true;
			if ( edgeX ) cropped.side = true;
			if ( y === height - 1 ) cropped.bottom = true;

			const [ rx, ry ] = rot( x, - y );
			const u = rx / W, v = ry / E;
			if ( Math.abs( u ) < 0.6 && v > topV ) topV = v;
			if ( Math.abs( u ) < 1.0 && v > - 3 && v < bottomV ) bottomV = v;
			if ( v >= 0 && v <= 0.7 ) { if ( u < uMin ) uMin = u; if ( u > uMax ) uMax = u; }
			if ( Math.abs( u ) < 0.12 && v > 0.3 ) { lineN ++; if ( v < lineV ) lineV = v; }

			// profile: sideways reach per height band, crown height and fringe edge per sideways band
			const i = vBin( v );
			if ( i >= 0 ) {

				rowN[ i ] ++;
				if ( edgeX ) rowCut[ i ] = true;
				if ( u > 0 && ( prof.halfR[ i ] === null || u > prof.halfR[ i ] ) ) prof.halfR[ i ] = u;
				if ( u < 0 && ( prof.halfL[ i ] === null || - u > prof.halfL[ i ] ) ) prof.halfL[ i ] = - u;

			}
			const j = uBin( u );
			if ( j >= 0 ) {

				colN[ j ] ++;
				if ( edgeTop ) colCut[ j ] = true;
				if ( prof.topByU[ j ] === null || v > prof.topByU[ j ] ) prof.topByU[ j ] = v;
				if ( v > FRINGE_FROM ) { lineCount[ j ] ++; if ( prof.lineByU[ j ] === null || v < prof.lineByU[ j ] ) prof.lineByU[ j ] = v; }

			}

		}

	}
	if ( ! n ) return null;

	// A band that touches the frame edge is not a real silhouette, and a band with only a few hair pixels is noise
	// (a collar or a stray strand the segmenter called hair): drop both.
	const minRow = Math.max( 12, 0.04 * W * GRID.v.step * E ), minCol = Math.max( 12, 0.04 * W * GRID.u.step * E );
	for ( let i = 0; i < GRID.v.n; i ++ ) if ( rowCut[ i ] || rowN[ i ] < minRow ) { prof.halfR[ i ] = null; prof.halfL[ i ] = null; }
	for ( let j = 0; j < GRID.u.n; j ++ ) {

		if ( colCut[ j ] || colN[ j ] < minCol ) prof.topByU[ j ] = null;
		if ( lineCount[ j ] < minCol ) prof.lineByU[ j ] = null;

	}
	// the hair hangs down from the head: below the ear line only the bands connected to it count, so a
	// disconnected blob lower down (a shirt, a hand) cannot make the hair look longer
	let top = GRID.v.n - 1;
	while ( top >= 0 && prof.halfR[ top ] === null && prof.halfL[ top ] === null ) top --;
	let broken = false;
	for ( let i = top; i >= 0; i -- ) {

		if ( prof.halfR[ i ] === null && prof.halfL[ i ] === null ) broken = true;
		if ( broken ) { prof.halfR[ i ] = null; prof.halfL[ i ] = null; }

	}
	const r = a => a.map( v => round( v ) );

	return {
		topV: cropped.top || topV === - Infinity ? null : round( topV ),
		widthW: cropped.side || uMax === - Infinity ? null : round( uMax - uMin ),
		lengthV: cropped.bottom || bottomV === Infinity ? null : round( bottomV ),
		hairlineV: lineN > 20 ? round( lineV ) : null,
		profile: { halfR: r( prof.halfR ), halfL: r( prof.halfL ), topByU: r( prof.topByU ), lineByU: r( prof.lineByU ) },
		cropped,
	};

}

// ── from the VRM ────────────────────────────────────────────────────────────

/** Sideways position in head widths, positive toward the right of the picture. */
const uOf = ( x, m ) => ( m.front < 0 ? - x : x ) / m.W;

/**
 * @param {Float32Array} positions
 * @param {Iterable<number>} ids vertex indices of the hair
 * @param {{eyeY:number,E:number,W:number,front:number,zc:number}} m the face measurement (same space)
 */
export function measureHair( positions, ids, m ) {

	const { eyeY, E, W, front, zc } = m;
	let top = - Infinity, bottom = Infinity, xMin = Infinity, xMax = - Infinity, line = Infinity;
	const prof = newProfile();

	for ( const i of ids ) {

		const x = positions[ i * 3 ], y = positions[ i * 3 + 1 ], z = positions[ i * 3 + 2 ], v = ( y - eyeY ) / E, u = uOf( x, m );
		const isFront = front * ( z - zc ) > 0;
		if ( Math.abs( x ) < 0.6 * W && y > top ) top = y;
		if ( Math.abs( x ) < 1.0 * W && y < bottom ) bottom = y;
		if ( v >= 0 && v <= 0.7 ) { if ( x < xMin ) xMin = x; if ( x > xMax ) xMax = x; }
		if ( Math.abs( x ) < 0.12 * W && v > 0.3 && isFront && v < line ) line = v;

		const bi = vBin( v );
		if ( bi >= 0 ) {

			if ( u > 0 && ( prof.halfR[ bi ] === null || u > prof.halfR[ bi ] ) ) prof.halfR[ bi ] = u;
			if ( u < 0 && ( prof.halfL[ bi ] === null || - u > prof.halfL[ bi ] ) ) prof.halfL[ bi ] = - u;

		}
		const j = uBin( u );
		if ( j >= 0 ) {

			if ( prof.topByU[ j ] === null || v > prof.topByU[ j ] ) prof.topByU[ j ] = v;
			if ( isFront && v > FRINGE_FROM && ( prof.lineByU[ j ] === null || v < prof.lineByU[ j ] ) ) prof.lineByU[ j ] = v;

		}

	}
	return {
		topV: top === - Infinity ? null : ( top - eyeY ) / E,
		widthW: xMax === - Infinity ? null : ( xMax - xMin ) / W,
		lengthV: bottom === Infinity ? null : ( bottom - eyeY ) / E,
		hairlineV: line === Infinity ? null : line,
		profile: prof,
	};

}

// ── the plan ────────────────────────────────────────────────────────────────

// The hair sits only a centimeter or two outside the skull, which is not moved, so it may not shrink much (that would sink
// it into the head and show the scalp between the strands): the lower limits are small on purpose.
const LIMITS_DEFAULT = { volume: [ 0.7, 1.2 ], top: [ 0.7, 1.25 ], length: [ 0.6, 1.6 ], fringe: 0.35, hairline: [ 0.35, 1.3 ], maxMove: 0.13 };

// ratios (or shifts) per bin, with gaps filled by interpolating between the valid bins, flat past the ends
// Beyond the measured range the value fades back to `restValue` (1 for ratios, 0 for shifts; null = stay flat) over `fade`, so a measurement taken at
// the ears does not stretch the whole head.
function curve( values, centerOf, fade, restValue = 1 ) {

	const pts = values.map( ( v, i ) => v === null ? null : [ centerOf( i ), v ] ).filter( Boolean );
	if ( ! pts.length ) return null;
	const rest = ( edge, t ) => restValue === null ? edge[ 1 ] : lerp( edge[ 1 ], restValue, clamp( Math.abs( t - edge[ 0 ] ) / fade, 0, 1 ) );
	return t => {

		if ( t <= pts[ 0 ][ 0 ] ) return rest( pts[ 0 ], t );
		for ( let k = 1; k < pts.length; k ++ ) if ( t <= pts[ k ][ 0 ] ) { const [ a, av ] = pts[ k - 1 ], [ b, bv ] = pts[ k ]; return lerp( av, bv, ( t - a ) / ( b - a ) ); }
		return rest( pts[ pts.length - 1 ], t );

	};

}

// the value at the nearest valid bin within `reach` (interpolating between two valid bins that are close), else null
function nearestWithin( values, centerOf, reach ) {

	const pts = values.map( ( v, i ) => v === null ? null : [ centerOf( i ), v ] ).filter( Boolean );
	if ( ! pts.length ) return null;
	return t => {

		let best = null;
		for ( const p of pts ) if ( Math.abs( p[ 0 ] - t ) <= reach && ( ! best || Math.abs( p[ 0 ] - t ) < Math.abs( best[ 0 ] - t ) ) ) best = p;
		return best ? best[ 1 ] : null;

	};

}

const ratio = ( ref, cur, min, lo, hi ) => ref.map( ( r, i ) => r !== null && cur[ i ] !== null && cur[ i ] > min && r > min ? clamp( r / cur[ i ], lo, hi ) : null );

/** @returns {object} plan: what applies and by how much (it is also the report) */
export function planHair( cur, ref, m, strength, limits = {} ) {

	const LIMITS = { ...LIMITS_DEFAULT, ...limits };
	const s = clamp( strength, 0, 1 );
	const plan = { m, strength: s, curBottomV: cur.lengthV, curLineV: cur.hairlineV, mode: 'scalar', volume: null, top: null, length: null, fringe: null, profile: null };
	const rp = ref.profile, cp = cur.profile;

	if ( rp && cp ) {

		plan.mode = 'silhouette';
		const sm = a => curve( a, vCenter, 0.5 ), um = a => curve( a, uCenter, 0.3 );
		const widthR = sm( ratio( rp.halfR, cp.halfR, 0.25, ...LIMITS.volume ) ), widthL = sm( ratio( rp.halfL, cp.halfL, 0.25, ...LIMITS.volume ) );
		const crown = um( ratio( rp.topByU, cp.topByU, 0.3, ...LIMITS.top ) );
		// Fringe: where the lower edge should sit, per sideways band. A fringe that must come UP is lifted (the
		// strands at the fringe rise toward the photo's hairline); one that
		// must go DOWN is moved down.
		const target = rp.lineByU.map( ( r, j ) => r !== null && cp.lineByU[ j ] !== null ? clamp( r, ...LIMITS.hairline ) : null );
		const down = target.map( ( t, j ) => t !== null && t < cp.lineByU[ j ] ? clamp( t - cp.lineByU[ j ], - LIMITS.fringe, 0 ) : null );
		const upEdge = target.map( ( t, j ) => t !== null && t > cp.lineByU[ j ] ? t : null );
		const fringe = curve( down, uCenter, 0.3, 0 ), fringeAt = curve( cp.lineByU, uCenter, 0.3, null );
		const edge = nearestWithin( upEdge, uCenter, 0.15 );
		// the lift is one amount for the whole front (the median over the middle columns), so the hairline moves as a piece and keeps the VRM's own shape
		const lifts = upEdge.map( ( t, j ) => t !== null && Math.abs( uCenter( j ) ) < 0.35 ? t - cp.lineByU[ j ] : null ).filter( v => v !== null ).sort( ( a, b ) => a - b );
		const edgeLift = lifts.length ? lifts[ Math.floor( lifts.length / 2 ) ] : null;
		// Length: how far down each side reaches (the lowest band that has hair). Shorter than the VRM: pulled up
		// toward the photo's length (squeezed by at most half). Longer: stretched.
		const lowest = a => { for ( let i = 0; i < a.length; i ++ ) if ( a[ i ] !== null ) return vCenter( i ) - GRID.v.step / 2; return null; };
		const lenR = lowest( rp.halfR ), lenL = lowest( rp.halfL ), curR = lowest( cp.halfR ), curL = lowest( cp.halfL );
		// hair that ends above the ear line in the photo (a short cut) is the shortest cut there is
		const lenRatio = ( refV, curV ) => refV === null || curV === null || 0.1 - curV <= 0.05 ? null : 0.1 - refV <= 0.05 ? LIMITS.length[ 0 ] : clamp( ( 0.1 - refV ) / ( 0.1 - curV ), ...LIMITS.length );
		const rR = lenRatio( lenR, curR ), rL = lenRatio( lenL, curL );
		plan.profile = {
			widthR, widthL, crown, fringe, fringeAt, edge, edgeLift,
			lengthR: rR !== null && rR > 1 ? rR : null, lengthL: rL !== null && rL > 1 ? rL : null,
			trimR: rR !== null && rR < 1 ? lenR : null, trimL: rL !== null && rL < 1 ? lenL : null,
		};
		const pp = plan.profile;
		const any = widthR || widthL || crown || fringe || edge || pp.lengthR || pp.lengthL || pp.trimR !== null || pp.trimL !== null;
		if ( ! any ) plan.mode = 'scalar';

	}
	if ( plan.mode === 'scalar' ) {

		if ( ref.widthW && cur.widthW ) plan.volume = clamp( ref.widthW / cur.widthW, ...LIMITS.volume );
		if ( ref.topV > 0 && cur.topV > 0 ) plan.top = clamp( ref.topV / cur.topV, ...LIMITS.top );
		if ( ref.lengthV !== null && ref.lengthV !== undefined && cur.lengthV !== null ) {

			const refL = 0.1 - ref.lengthV, curL = 0.1 - cur.lengthV; // how far below the ear line the hair hangs
			if ( refL > 0.05 && curL > 0.05 ) {

				const r = clamp( refL / curL, ...LIMITS.length );
				if ( r < 1 ) plan.trimV = ref.lengthV; else plan.length = r; // shorter: cut at the photo's length; longer: stretch

			}

		}
		if ( ref.hairlineV !== null && ref.hairlineV !== undefined && cur.hairlineV !== null ) {

			const target = clamp( ref.hairlineV, ...LIMITS.hairline );
			if ( target > cur.hairlineV ) plan.edgeV = target; // the fringe has to come up: lift it to the edge
			else plan.fringe = { v0: cur.hairlineV, shift: clamp( target - cur.hairlineV, - LIMITS.fringe, 0 ) };

		}

	}
	// the swept-up lift: how short the photo's hair is decides how much of it is used
	const A = 0.15;
	let need = 0;
	const bottom = plan.curBottomV;
	const cuts = plan.mode === 'silhouette' ? [ plan.profile.trimR, plan.profile.trimL ].filter( v => v !== null && v !== undefined ) : ( plan.trimV !== undefined && plan.trimV !== null ? [ plan.trimV ] : [] );
	if ( cuts.length && bottom !== null && bottom !== undefined ) need = Math.max( 0, ( cuts.reduce( ( a, b ) => a + b, 0 ) / cuts.length ) - bottom );
	const edgeLift = plan.mode === 'silhouette' ? plan.profile.edgeLift : ( plan.edgeV && plan.curLineV !== null && plan.curLineV !== undefined ? plan.edgeV - plan.curLineV : null );
	const B = Math.min( SWEPT.bottomMax, need ), shortness = Math.min( 1, B / SWEPT.max );
	// the crown is lifted only when the photo's crown is about as tall as the VRM's: a photo with a much lower crown wants proportionally less hair, not a taller head
	const topRatio = ref.topV > 0 && cur.topV > 0 ? ref.topV / cur.topV : 1, crownShare = clamp( ( topRatio - 0.7 ) / 0.3, 0, 1 );
	const F = Math.min( SWEPT.fringeMax, Math.max( edgeLift > 0 ? edgeLift : 0, 1.15 * shortness ) );
	plan.swept = B > 0.02 || F > 0.1 ? { B, T: Math.min( B, SWEPT.max ) * crownShare, F, shortness: +shortness.toFixed( 2 ) } : null;
	// the swept-up look raises the crown, so a photo whose crown measures lower than the VRM's must not also shrink it
	if ( plan.swept ) {

		if ( crownShare >= 1 && plan.top && plan.top < 1 ) plan.top = 1;
		if ( crownShare >= 1 && plan.profile && plan.profile.crown ) { const c = plan.profile.crown; plan.profile.crown = t => Math.max( 1, c( t ) ); }

	}

	return plan;

}

/** What the plan does, for the report: ratios (1 = unchanged) at a few heights / positions, and fringe shifts in units of E. */
export function summarizePlan( plan ) {

	const s = plan.strength, f = k => k === null || k === undefined ? null : +lerp( 1, k, s ).toFixed( 3 );
	if ( plan.mode === 'silhouette' ) {

		const p = plan.profile, at = ( fn, ts ) => fn ? ts.map( t => f( fn( t ) ) ) : null;
		return { mode: 'silhouette', sides: { right: at( p.widthR, [ - 0.5, 0.25, 1.0 ] ), left: at( p.widthL, [ - 0.5, 0.25, 1.0 ] ) }, crown: at( p.crown, [ - 0.3, 0, 0.3 ] ), fringeShiftE: p.fringe ? [ - 0.3, 0, 0.3 ].map( t => +( p.fringe( t ) * s ).toFixed( 3 ) ) : null, length: { right: f( p.lengthR ), left: f( p.lengthL ) }, trim: { right: p.trimR, left: p.trimL }, swept: plan.swept ? { bottomE: +( plan.swept.B * s ).toFixed( 2 ), topE: +( plan.swept.T * s ).toFixed( 2 ), fringeE: +( plan.swept.F * s ).toFixed( 2 ) } : null };

	}
	return { mode: 'scalar', volume: f( plan.volume ), top: f( plan.top ), length: f( plan.length ), trim: { right: plan.trimV ?? null, left: plan.trimV ?? null }, swept: plan.swept ? { bottomE: +( plan.swept.B * s ).toFixed( 2 ), topE: +( plan.swept.T * s ).toFixed( 2 ), fringeE: +( plan.swept.F * s ).toFixed( 2 ) } : null, fringeShiftE: plan.fringe ? +( plan.fringe.shift * s ).toFixed( 3 ) : null };

}

// ── the warp ────────────────────────────────────────────────────────────────

// The swept-up look, copied from a hand-made restyle of this VRoid base (measured vertex by vertex against the stock hair): the same
// mesh with only a smooth vertical field applied, in head units (E = eye-to-chin height; the base's E is about 10 cm):
//   - the hair is lifted by B at the bottom and by T at the top, and left where it meets the head (the ear line, v about 0.16):
//       lift(v) = B or T times (1 - exp(-((v - 0.16) / s)^2)), with s = 0.55 on both sides
//     so the sides and back come out shorter (the ears show) and the crown gets taller, and nothing is folded;
//   - the fringe is lifted more, F at its lower edge (v about -0.25), falling off over 0.8 upward and 0.35 downward, leaving a small tail, strongest at the middle
//     of the forehead and weaker toward the sideburns, and it moves back toward the head by 20 percent of its lift;
//   - the top spreads sideways by 8 percent.
// In the reference B = T = 0.44 and F = 1.15. Here they come from the photo: the shorter the photo's hair is than the VRM's, the
// more of the lift is used.
const SWEPT = { pinch: 0.16, sLow: 0.55, sUp: 0.55, fringeAt: - 0.25, fringeUp: 0.8, fringeDown: 0.35, tail: 0.15, back: 0.2, spread: 0.08, innerTop: 0.44, max: 0.44, bottomMax: 0.55, // the lift's steepest slope is about 1.56 times this: above 0.64 it would fold the strands
	 fringeMax: 1.3 };

const pinchProfile = v => { const s = v < SWEPT.pinch ? SWEPT.sLow : SWEPT.sUp; return 1 - Math.exp( - ( ( ( v - SWEPT.pinch ) / s ) ** 2 ) ); };

/** The lift for a point at height v, in E units: { dv, extra } (extra = the fringe part, which also moves back). */
function sweptLift( swept, v, u, gate, inner ) {

	if ( ! swept ) return { dv: 0, extra: 0 };
	// the back-hair layer under the strands (measured in the reference: its top is lifted 0.44 times as much, and it has no fringe lift)
	// so it stays low and shows between the lifted fringe and the forehead
	const base = ( v < SWEPT.pinch ? swept.B : swept.T * ( inner ? SWEPT.innerTop : 1 ) ) * pinchProfile( v );
	if ( inner ) return { dv: base, extra: 0 };
	const s = v < SWEPT.fringeAt ? SWEPT.fringeDown : SWEPT.fringeUp;
	const lateral = 1 - smooth( clamp( Math.abs( u ) / 0.85, 0, 1 ) ); // measured: 1 at the middle, 0.8 at 0.27 head widths, 0.55 at 0.4, 0.3 at 0.53
	// the fringe's own lift, plus a small lift that the front keeps all the way up to the crown
	const extra = ( swept.F * Math.exp( - ( ( ( v - SWEPT.fringeAt ) / s ) ** 2 ) ) + SWEPT.tail * ( swept.F / 1.15 ) * smooth( clamp( ( v - 0.5 ) / 0.5, 0, 1 ) ) ) * lateral * gate;
	return { dv: base + extra, extra };

}

export function warpHairPoint( plan, x, y, z, inner = false ) {

	const { eyeY, E, W, front, zc } = plan.m;
	const v = ( y - eyeY ) / E, u = uOf( x, plan.m );
	const s = plan.strength;
	let dx = 0, dy = 0, dz = 0;
	const gate = front * ( z - zc ) > 0 ? 1 : 0;

	if ( plan.mode === 'silhouette' ) {

		const p = plan.profile;
		// Sideways reach per height band, each side with its own ratio. The two sides blend gradually over the middle of
		// the head (u = 0 is the back or front center), so neighboring strands never get very different scales and tear apart.
		const kr = p.widthR ? p.widthR( v ) : 1, kl = p.widthL ? p.widthL( v ) : 1;
		const mixR = smooth( clamp( ( u + 0.5 ) / 1.0, 0, 1 ) );
		const k = lerp( lerp( 1, kl, s ), lerp( 1, kr, s ), mixR );
		const kAvg = lerp( 1, ( kl + kr ) / 2, s );
		dx += ( k - 1 ) * x; dz += ( kAvg - 1 ) * ( z - zc ); // depth follows the average, not one side
		// crown height per sideways band
		if ( p.crown ) dy += ( lerp( 1, p.crown( clamp( u, GRID.u.lo, GRID.u.lo + GRID.u.n * GRID.u.step ) ), s ) - 1 ) * ( y - ( eyeY + 0.5 * E ) ) * smooth( clamp( ( v - 0.5 ) / 0.6, 0, 1 ) );
		// length below the ear line, per side (longer hair is stretched)
		const kLen = lerp( lerp( 1, p.lengthL ?? 1, s ), lerp( 1, p.lengthR ?? 1, s ), mixR );
		dy += ( kLen - 1 ) * ( y - ( eyeY + 0.1 * E ) ) * smooth( clamp( ( 0.1 - v ) / 0.6, 0, 1 ) );
		// a fringe that has to come down
		if ( p.fringe && Math.abs( u ) < 0.6 ) {

			const v0 = p.fringeAt ? p.fringeAt( u ) : 0.5;
			dy += s * p.fringe( u ) * E * gate * Math.exp( - 0.5 * ( ( v - v0 ) / 0.18 ) ** 2 );

		}
		// shorter hair and a higher hairline: the swept-up lift (see sweptLift)
		const sw = sweptLift( plan.swept, ( y + dy - eyeY ) / E, u, gate, inner );
		dy += s * sw.dv * E;
		dz -= front * SWEPT.back * sw.extra * E * s; // the head's surface falls away as the fringe rises: follow it so it does not float
		if ( plan.swept && ! inner ) dx += s * SWEPT.spread * ( plan.swept.T / SWEPT.max ) * smooth( clamp( ( v - 0.5 ) / 0.6, 0, 1 ) ) * x;
		const y1 = y + dy;
		dy = y1 - y;

	} else {

		if ( plan.volume ) { const k = lerp( 1, plan.volume, s ); dx += ( k - 1 ) * x; dz += ( k - 1 ) * ( z - zc ); }
		if ( plan.top ) dy += ( lerp( 1, plan.top, s ) - 1 ) * ( y - ( eyeY + 0.5 * E ) ) * smooth( clamp( ( v - 0.5 ) / 0.6, 0, 1 ) );
		if ( plan.length ) dy += ( lerp( 1, plan.length, s ) - 1 ) * ( y - ( eyeY + 0.1 * E ) ) * smooth( clamp( ( 0.1 - v ) / 0.6, 0, 1 ) );
		if ( plan.fringe ) dy += s * plan.fringe.shift * E * gate * Math.exp( - 0.5 * ( ( v - plan.fringe.v0 ) / 0.18 ) ** 2 ) * ( 1 - smooth( clamp( ( Math.abs( x ) / W - 0.45 ) / 0.25, 0, 1 ) ) );
		const sw = sweptLift( plan.swept, ( y + dy - eyeY ) / E, u, gate, inner );
		dy += s * sw.dv * E;
		dz -= front * SWEPT.back * sw.extra * E * s;
		if ( plan.swept && ! inner ) dx += s * SWEPT.spread * ( plan.swept.T / SWEPT.max ) * smooth( clamp( ( v - 0.5 ) / 0.6, 0, 1 ) ) * x;
		const y1 = y + dy;
		dy = y1 - y;

	}

	const len = Math.hypot( dx, dy, dz );
	const k = len > LIMITS_DEFAULT.maxMove ? LIMITS_DEFAULT.maxMove / len : 1;
	return [ dx * k, dy * k, dz * k ];

}
