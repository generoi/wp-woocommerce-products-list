/**
 * Variations of many parents in one request: `GET /wc-products-list/v1/variations`
 * (docs/contracts.md, "Cross-parent variation reads"), the read twin of the
 * `variations/batch` write route. wc/v3 reads variations per parent, so a
 * bulk edit over an expanded page (100 parents, 500 variations) was 50-100
 * requests of a second each before the editor was ready; across parents it
 * is a handful.
 *
 * - `include=1,2,3` (≤ 100 ids): those variations, whatever their parents.
 * - `parent=1,2,3` (≤ 100 ids): every variation of those parents, ordered
 *   parent, menu_order, id, paged (`per_page` ≤ 100, `X-WP-TotalPages`).
 *
 * A server without the route (an older plugin build answers 404
 * `rest_no_route`) makes both return null once and for the rest of the
 * page's life; the callers then read per parent as before.
 */
import { addQueryArgs } from '@wordpress/url';
import { request, toVariationRow } from '../api/client';
import type { ProductListItem, RawVariation } from '../types';

const ROUTE = '/wc-products-list/v1/variations';

/** Ids per request: the server's limit. */
export const ACROSS_CHUNK = 100;

let supported: boolean | null = null;

/** For tests: forget what the server said. */
export function resetAcrossSupport( value: boolean | null = null ): void {
	supported = value;
}

export function acrossSupported(): boolean | null {
	return supported;
}

function isNoRoute( error: unknown ): boolean {
	const code = ( error as { code?: unknown } | null )?.code;
	const status = ( error as { status?: unknown } | null )?.status;

	return code === 'rest_no_route' || ( status === 404 && code !== 'woocommerce_rest_product_variation_invalid_id' );
}

interface Page {
	items: RawVariation[];
	totalPages: number;
}

export type AcrossFetch = ( query: Record< string, string | number >, signal?: AbortSignal ) => Promise< Page >;

const defaultFetch: AcrossFetch = async ( query, signal ) => {
	const response = await request( { path: addQueryArgs( ROUTE, query ), parse: false, signal } );

	if ( ! response.ok ) {
		const body = ( await response.json().catch( () => ( {} ) ) ) as { code?: string; message?: string };

		throw Object.assign( new Error( body.message ?? `HTTP ${ response.status }` ), { code: body.code ?? 'http_error', status: response.status } );
	}

	const items = ( await response.json() ) as RawVariation[];
	const pages = Number( response.headers.get( 'X-WP-TotalPages' ) );

	return { items: Array.isArray( items ) ? items : [], totalPages: Number.isFinite( pages ) && pages > 0 ? pages : 1 };
};

let fetchPage: AcrossFetch = defaultFetch;

/** For tests: replace the transport. */
export function setAcrossFetch( fetcher: AcrossFetch | null ): void {
	fetchPage = fetcher ?? defaultFetch;
}

/** The parent a raw variation names (wc/v3's `parent_id`, or the plugin's enrichment). */
function parentOfRaw( raw: RawVariation ): number {
	const enriched = ( raw as { wc_products_list?: { parent_id?: unknown } } ).wc_products_list?.parent_id;
	const own = ( raw as { parent_id?: unknown } ).parent_id;

	return Number( own ?? enriched ?? 0 ) || 0;
}

/** One request; null (and remembered) when the server has no such route. */
async function attempt( query: Record< string, string | number >, signal?: AbortSignal ): Promise< Page | null > {
	if ( supported === false ) {
		return null;
	}

	try {
		const page = await fetchPage( query, signal );

		supported = true;

		return page;
	} catch ( error ) {
		if ( supported !== true && isNoRoute( error ) ) {
			supported = false;

			return null;
		}

		throw error;
	}
}

function chunks< T >( list: T[], size: number ): T[][] {
	const out: T[][] = [];

	for ( let index = 0; index < list.length; index += size ) {
		out.push( list.slice( index, index + size ) );
	}

	return out;
}

async function inParallel< T >( tasks: Array< () => Promise< T > >, limit: number ): Promise< T[] > {
	const results: T[] = new Array( tasks.length );
	let next = 0;
	const worker = async () => {
		while ( next < tasks.length ) {
			const index = next++;

			results[ index ] = await tasks[ index ]!();
		}
	};

	await Promise.all( Array.from( { length: Math.max( 1, Math.min( limit, tasks.length ) ) }, worker ) );

	return results;
}

export interface AcrossOptions {
	fields: string[];
	signal?: AbortSignal;
	/** Requests in flight at once. */
	concurrency?: number;
}

/**
 * These variations, read across their parents (chunks of 100, a few side by
 * side), normalised as list rows under the parent `parentOf` names (the one
 * the list knows), else the one the server sent. Null when the server has no
 * cross-parent route: the caller reads per parent.
 */
export async function getVariationsByIds( ids: number[], parentOf: ReadonlyMap< number, number >, options: AcrossOptions ): Promise< ProductListItem[] | null > {
	if ( ids.length === 0 ) {
		return [];
	}

	const _fields = Array.from( new Set( [ ...options.fields, 'id', 'parent_id' ] ) ).join( ',' );
	const parts = chunks( ids, ACROSS_CHUNK );
	// The first request tells whether the route exists; the rest follow side by side.
	const first = await attempt( { include: parts[ 0 ]!.join( ',' ), per_page: parts[ 0 ]!.length, _fields }, options.signal );

	if ( first === null ) {
		return null;
	}

	const rest = await inParallel(
		parts.slice( 1 ).map( ( part ) => async () => ( await attempt( { include: part.join( ',' ), per_page: part.length, _fields }, options.signal ) )?.items ?? [] ),
		options.concurrency ?? 4
	);

	return [ ...first.items, ...rest.flat() ].map( ( raw ) => toVariationRow( raw, parentOf.get( raw.id ) ?? parentOfRaw( raw ) ) );
}

/**
 * Every variation of these parents, by parent (each parent present, an
 * empty list when it has none), in the server's order. Parents go 100 per
 * request; a request's further pages are read side by side once the first
 * says how many there are. Null when the server has no cross-parent route.
 */
export async function getVariationsOfParents( parentIds: number[], options: AcrossOptions ): Promise< Map< number, ProductListItem[] > | null > {
	const byParent = new Map< number, ProductListItem[] >( parentIds.map( ( id ) => [ id, [] ] ) );

	if ( parentIds.length === 0 ) {
		return byParent;
	}

	const _fields = Array.from( new Set( [ ...options.fields, 'id', 'parent_id' ] ) ).join( ',' );
	const concurrency = options.concurrency ?? 4;
	const parts = chunks( parentIds, ACROSS_CHUNK );
	const query = ( part: number[], page: number ) => ( { parent: part.join( ',' ), per_page: ACROSS_CHUNK, page, _fields } );
	const first = await attempt( query( parts[ 0 ]!, 1 ), options.signal );

	if ( first === null ) {
		return null;
	}

	const firstPages = [ first, ...( await inParallel( parts.slice( 1 ).map( ( part ) => async () => ( await attempt( query( part, 1 ), options.signal ) ) ?? { items: [], totalPages: 1 } ), concurrency ) ) ];
	const more = await inParallel(
		parts.flatMap( ( part, index ) =>
			Array.from( { length: Math.max( 0, ( firstPages[ index ]?.totalPages ?? 1 ) - 1 ) }, ( _, offset ) => async () => ( await attempt( query( part, offset + 2 ), options.signal ) )?.items ?? [] )
		),
		concurrency
	);
	const known = new Set( parentIds );

	for ( const raw of [ ...firstPages.flatMap( ( page ) => page.items ), ...more.flat() ] ) {
		const parentId = parentOfRaw( raw );

		if ( known.has( parentId ) ) {
			byParent.get( parentId )!.push( toVariationRow( raw, parentId ) );
		}
	}

	return byParent;
}
