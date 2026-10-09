/**
 * The first requests of the Catalog, started before the bundle runs.
 *
 * The admin page (src/Modules/AdminPage.php) prints a tiny inline script
 * next to the server-rendered skeleton. It reads, for the page's query
 * string, the GET paths this module stored on the previous visit (the
 * product list and the tab counts) and fetches them at once with the REST
 * nonce and the list-mode header, into `window.wcProductsListPrefetch`
 * (`{ [path]: Promise<{ ok, status, headers: { total, totalPages }, data }> }`).
 * The app then takes the response for the exact path it is about to request
 * instead of asking again, so the first rows no longer wait for the 2 MB
 * bundle to download and parse (about 1.2 s on a warm cache).
 *
 * - A response is used once, and only within PREFETCH_MAX_AGE of the
 *   navigation: anything later asks the server.
 * - Paths are stored as apiFetch sends them (with `_locale=user`), so the
 *   prefetched response is in the same language as the app's own request.
 * - The first successful list and counts requests of a page load are what
 *   gets stored, under the query string the page was loaded with; at most
 *   PREFETCH_MAX_ENTRIES query strings are kept, most recent last.
 * - Storage failures (private mode, a full quota) only mean no prefetch.
 */
import { addQueryArgs } from '@wordpress/url';

/** Keep in sync with AdminPage::PREFETCH_STORAGE_KEY. */
export const PREFETCH_STORAGE_KEY = 'wc-products-list:prefetch';

/** Keep in sync with AdminPage::PREFETCH_GLOBAL. */
export const PREFETCH_GLOBAL = 'wcProductsListPrefetch';

/** Keep in sync with AdminPage::PREFETCH_MAX. */
export const PREFETCH_MAX_PATHS = 4;

/** Query strings remembered. */
export const PREFETCH_MAX_ENTRIES = 20;

/** A prefetched response older than this (ms since navigation) is not used. */
export const PREFETCH_MAX_AGE = 60000;

export interface PrefetchedResponse {
	ok: boolean;
	status: number;
	headers?: { total?: string | null; totalPages?: string | null };
	data: unknown;
}

export type BootRequestKind = 'list' | 'counts';

type Store = Pick< Storage, 'getItem' | 'setItem' >;

/** The query string this page was loaded with: the key the inline script reads. */
let bootSearch: string = typeof window !== 'undefined' ? window.location.search : '';
const recorded = new Map< BootRequestKind, string >();
const ORDER: BootRequestKind[] = [ 'list', 'counts' ];

function storage(): Store | null {
	try {
		return typeof window !== 'undefined' ? window.localStorage : null;
	} catch {
		return null;
	}
}

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** The path as apiFetch sends it (its user-locale middleware adds `_locale=user`). */
export function wirePath( path: string ): string {
	return /[?&]_locale=/.test( path ) ? path : addQueryArgs( path, { _locale: 'user' } );
}

function prefetched(): Record< string, Promise< PrefetchedResponse > | undefined > | null {
	if ( typeof window === 'undefined' ) {
		return null;
	}

	const value = ( window as unknown as Record< string, unknown > )[ PREFETCH_GLOBAL ];

	return value && typeof value === 'object' ? ( value as Record< string, Promise< PrefetchedResponse > | undefined > ) : null;
}

/**
 * The prefetched response for this path, taken (a second call gets null),
 * or null when the inline script did not start it or it is too old.
 */
export function takePrefetched( path: string ): Promise< PrefetchedResponse > | null {
	const all = prefetched();

	if ( ! all ) {
		return null;
	}

	const key = wirePath( path );
	const pending = all[ key ];

	if ( ! pending ) {
		return null;
	}

	delete all[ key ];

	if ( now() > PREFETCH_MAX_AGE || typeof ( pending as { then?: unknown } ).then !== 'function' ) {
		return null;
	}

	return pending;
}

/** What is stored: query string → paths, oldest first. */
export function readPrefetchMap( store: Store | null = storage() ): Record< string, string[] > {
	try {
		const parsed: unknown = JSON.parse( store?.getItem( PREFETCH_STORAGE_KEY ) ?? '{}' );

		return parsed && typeof parsed === 'object' && ! Array.isArray( parsed ) ? ( parsed as Record< string, string[] > ) : {};
	} catch {
		return {};
	}
}

/**
 * Remember the first request of this kind made by this page load, so the
 * next load of the same admin URL can start it right away.
 */
export function recordBootRequest( kind: BootRequestKind, path: string, store: Store | null = storage() ): void {
	if ( recorded.has( kind ) || ! store ) {
		return;
	}

	recorded.set( kind, wirePath( path ) );

	const paths = ORDER.map( ( entry ) => recorded.get( entry ) ).filter( ( entry ): entry is string => Boolean( entry ) ).slice( 0, PREFETCH_MAX_PATHS );
	const map = readPrefetchMap( store );

	if ( JSON.stringify( map[ bootSearch ] ) === JSON.stringify( paths ) ) {
		return;
	}

	// Re-inserted last: the oldest query strings go first.
	delete map[ bootSearch ];
	map[ bootSearch ] = paths;

	const keys = Object.keys( map );

	for ( const key of keys.slice( 0, Math.max( 0, keys.length - PREFETCH_MAX_ENTRIES ) ) ) {
		delete map[ key ];
	}

	try {
		store.setItem( PREFETCH_STORAGE_KEY, JSON.stringify( map ) );
	} catch {
		// A full or blocked store: the next load just does not prefetch.
	}
}

/** Tests: start over as a fresh page load with this query string. */
export function resetPrefetch( search = '' ): void {
	bootSearch = search;
	recorded.clear();
}
