/**
 * The first requests of the Catalog started before the bundle runs
 * (api/prefetch.ts, AdminPage::prefetchScript()), and the cross-parent
 * variations read (api/client.ts getVariationsAcross).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiFetch from '@wordpress/api-fetch';
import { getCounts, getVariationsAcross, listProducts, resetVariationsAcrossSupport, VARIATIONS_ACROSS_ROUTE } from '../../resources/api/client';
import { PREFETCH_GLOBAL, PREFETCH_MAX_PATHS, PREFETCH_STORAGE_KEY, readPrefetchMap, recordBootRequest, resetPrefetch, takePrefetched, wirePath } from '../../resources/api/prefetch';
import type { PrefetchedResponse } from '../../resources/api/prefetch';
import { setSettings } from '../../resources/settings';
import { editSettings } from './edit-fixtures';

vi.mock( '@wordpress/api-fetch', () => {
	const fn = vi.fn();
	( fn as unknown as { use: unknown } ).use = vi.fn();

	return { default: fn };
} );

const fetchMock = apiFetch as unknown as ReturnType< typeof vi.fn >;
const win = window as unknown as Record< string, unknown >;

function memoryStore(): Pick< Storage, 'getItem' | 'setItem' > & { data: Map< string, string > } {
	const data = new Map< string, string >();

	return { data, getItem: ( key ) => data.get( key ) ?? null, setItem: ( key, value ) => void data.set( key, value ) };
}

function prefetch( path: string, response: PrefetchedResponse ): void {
	const all = ( win[ PREFETCH_GLOBAL ] as Record< string, Promise< PrefetchedResponse > > | undefined ) ?? {};
	all[ wirePath( path ) ] = Promise.resolve( response );
	win[ PREFETCH_GLOBAL ] = all;
}

beforeEach( () => {
	fetchMock.mockReset();
	setSettings( editSettings() );
	resetPrefetch( '?post_type=product&page=wc-products-list' );
	resetVariationsAcrossSupport();
	window.localStorage.clear();
} );

afterEach( () => {
	setSettings( undefined );
	delete win[ PREFETCH_GLOBAL ];
	vi.restoreAllMocks();
} );

describe( 'prefetch store', () => {
	it( 'hands a prefetched response out once, by the path apiFetch sends', async () => {
		prefetch( '/wc/v3/products?page=1', { ok: true, status: 200, data: [] } );

		expect( wirePath( '/wc/v3/products?page=1' ) ).toBe( '/wc/v3/products?page=1&_locale=user' );
		expect( takePrefetched( '/wc/v3/products?page=2' ) ).toBeNull();
		await expect( takePrefetched( '/wc/v3/products?page=1' ) ).resolves.toMatchObject( { ok: true } );
		expect( takePrefetched( '/wc/v3/products?page=1' ) ).toBeNull();
	} );

	it( 'ignores a prefetched response once the page has been open too long', () => {
		prefetch( '/wc/v3/products?page=1', { ok: true, status: 200, data: [] } );
		vi.spyOn( performance, 'now' ).mockReturnValue( 120000 );

		expect( takePrefetched( '/wc/v3/products?page=1' ) ).toBeNull();
	} );

	it( 'records the first list and counts paths of a page load under its query string, the oldest query strings dropped', () => {
		const store = memoryStore();

		recordBootRequest( 'counts', '/wc-products-list/v1/counts', store );
		recordBootRequest( 'list', '/wc/v3/products?page=1', store );
		// Later requests of the same load (page 2, a search) are not what the next load starts with.
		recordBootRequest( 'list', '/wc/v3/products?page=2', store );

		expect( readPrefetchMap( store ) ).toEqual( {
			'?post_type=product&page=wc-products-list': [ '/wc/v3/products?page=1&_locale=user', '/wc-products-list/v1/counts?_locale=user' ],
		} );
		expect( readPrefetchMap( store )[ '?post_type=product&page=wc-products-list' ]?.length ).toBeLessThanOrEqual( PREFETCH_MAX_PATHS );

		for ( let index = 0; index < 25; index++ ) {
			resetPrefetch( `?page=wc-products-list&s=${ index }` );
			recordBootRequest( 'list', `/wc/v3/products?search=${ index }`, store );
		}

		const keys = Object.keys( readPrefetchMap( store ) );
		expect( keys ).toHaveLength( 20 );
		expect( keys[ 0 ] ).toBe( '?page=wc-products-list&s=5' );
		expect( keys[ 19 ] ).toBe( '?page=wc-products-list&s=24' );
	} );

	it( 'a broken or blocked store only means no prefetch', () => {
		const broken = { getItem: () => '{not json', setItem: () => {
			throw new Error( 'QuotaExceededError' );
		} };

		expect( readPrefetchMap( broken ) ).toEqual( {} );
		expect( () => recordBootRequest( 'list', '/wc/v3/products', broken ) ).not.toThrow();
	} );
} );

describe( 'client reads take the prefetched response', () => {
	it( 'listProducts uses the prefetched page (with its totals) instead of asking again, and remembers the path for the next load', async () => {
		const path = '/wc/v3/products?page=1&per_page=20';
		prefetch( path, { ok: true, status: 200, headers: { total: '855', totalPages: '43' }, data: [ { id: 7, type: 'simple', name: 'Boot' } ] } );

		const result = await listProducts( { page: 1, per_page: 20 } );

		expect( fetchMock ).not.toHaveBeenCalled();
		expect( result ).toMatchObject( { total: 855, totalPages: 43 } );
		expect( result.items.map( ( row ) => row.id ) ).toEqual( [ 7 ] );
		expect( JSON.parse( window.localStorage.getItem( PREFETCH_STORAGE_KEY ) ?? '{}' ) ).toEqual( { '?post_type=product&page=wc-products-list': [ `${ path }&_locale=user` ] } );
	} );

	it( 'a failed prefetch falls back to the app’s own request', async () => {
		prefetch( '/wc/v3/products?page=1', { ok: false, status: 500, data: { code: 'oops' } } );
		fetchMock.mockResolvedValueOnce( new Response( JSON.stringify( [ { id: 3, type: 'simple' } ] ), { status: 200, headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' } } ) );

		const result = await listProducts( { page: 1 } );

		expect( fetchMock ).toHaveBeenCalledTimes( 1 );
		expect( result.items.map( ( row ) => row.id ) ).toEqual( [ 3 ] );
	} );

	it( 'getCounts takes the prefetched counts', async () => {
		prefetch( '/wc-products-list/v1/counts', { ok: true, status: 200, data: { publish: 800, draft: 55 } } );

		await expect( getCounts() ).resolves.toEqual( { publish: 800, draft: 55 } );
		expect( fetchMock ).not.toHaveBeenCalled();
	} );
} );

describe( 'the inline prefetch script of the admin page', () => {
	/** The script exactly as AdminPage::prefetchScript() prints it, with its config. */
	function inlineScript( config: Record< string, unknown > ): string {
		const php = readFileSync( resolve( __dirname, '../../src/Modules/AdminPage.php' ), 'utf8' );
		const body = php.match( /<<<'JS'\n([\s\S]*?)\nJS;/ )?.[ 1 ];

		if ( ! body ) {
			throw new Error( 'No inline script in AdminPage.php' );
		}

		return body.replace( '%s', JSON.stringify( config ) );
	}

	it( 'starts the stored paths with the nonce and the list-mode header, under the keys the app takes them by', async () => {
		const search = window.location.search;
		const path = wirePath( '/wc/v3/products?page=1' );
		window.localStorage.setItem( PREFETCH_STORAGE_KEY, JSON.stringify( { [ search ]: [ path, 'https://evil.example/x', '/wp/v2/users' ] } ) );
		const fetchSpy = vi.fn().mockResolvedValue( new Response( JSON.stringify( [ { id: 1 } ] ), { status: 200, headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' } } ) );
		vi.stubGlobal( 'fetch', fetchSpy );

		// Runs the PHP-printed script as the browser would.
		new Function( inlineScript( { root: 'https://shop.test/wp-json/', nonce: 'n0nce', key: PREFETCH_STORAGE_KEY, global: PREFETCH_GLOBAL, max: 4, header: 'X-WC-Products-List' } ) )();

		expect( fetchSpy ).toHaveBeenCalledTimes( 1 );
		expect( fetchSpy.mock.calls[ 0 ]?.[ 0 ] ).toBe( 'https://shop.test/wp-json/wc/v3/products?page=1&_locale=user' );
		expect( fetchSpy.mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { credentials: 'same-origin', headers: { 'X-WP-Nonce': 'n0nce', 'X-WC-Products-List': '1' } } );
		resetPrefetch( search );
		await expect( takePrefetched( '/wc/v3/products?page=1' ) ).resolves.toEqual( { ok: true, status: 200, headers: { total: '1', totalPages: '1' }, data: [ { id: 1 } ] } );
		vi.unstubAllGlobals();
	} );

	it( 'fetches nothing on a first visit', () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal( 'fetch', fetchSpy );

		new Function( inlineScript( { root: '/wp-json/', nonce: 'n', key: PREFETCH_STORAGE_KEY, global: PREFETCH_GLOBAL, max: 4, header: 'X-WC-Products-List' } ) )();

		expect( fetchSpy ).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	} );
} );

describe( 'getVariationsAcross', () => {
	it( 'reads the variations of many parents in one request, each row under its own parent', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify( [
					{ id: 11, parent_id: 1, type: 'variation' },
					{ id: 21, parent_id: 2, type: 'variation' },
				] ),
				{ status: 200, headers: { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' } }
			)
		);

		const result = await getVariationsAcross( [ 1, 2 ], 1, { perPage: 100, fields: [ 'sku' ] } );
		const path = ( fetchMock.mock.calls[ 0 ]?.[ 0 ] as { path: string } ).path;

		expect( path.startsWith( `${ VARIATIONS_ACROSS_ROUTE }?` ) ).toBe( true );
		expect( decodeURIComponent( path ) ).toContain( 'parent=1,2' );
		expect( decodeURIComponent( path ) ).toContain( '_fields=sku,id,parent_id' );
		expect( result?.items.map( ( row ) => [ row.id, row._parentId ] ) ).toEqual( [
			[ 11, 1 ],
			[ 21, 2 ],
		] );
	} );

	it( 'answers null (read per parent) once the server says it has no such route, without asking again', async () => {
		fetchMock.mockRejectedValueOnce( new Response( JSON.stringify( { code: 'rest_no_route', message: 'No route', data: { status: 404 } } ), { status: 404 } ) );

		await expect( getVariationsAcross( [ 1, 2 ] ) ).resolves.toBeNull();
		await expect( getVariationsAcross( [ 3, 4 ] ) ).resolves.toBeNull();
		expect( fetchMock ).toHaveBeenCalledTimes( 1 );
	} );
} );
