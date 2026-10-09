import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiFetch from '@wordpress/api-fetch';
import { batchProducts, batchVariations, listProducts, runAction } from '../../resources/api/client';
import { setSettings } from '../../resources/settings';
import { editSettings } from './edit-fixtures';

vi.mock( '@wordpress/api-fetch', () => {
	const fn = vi.fn();
	( fn as unknown as { use: unknown } ).use = vi.fn();

	return { default: fn };
} );

const fetchMock = apiFetch as unknown as ReturnType< typeof vi.fn >;

function calls(): Array< { path: string; method?: string; data?: unknown } > {
	return fetchMock.mock.calls.map( ( [ options ] ) => options as { path: string; method?: string; data?: unknown } );
}

describe( 'batch writes', () => {
	beforeEach( () => {
		fetchMock.mockReset();
		fetchMock.mockImplementation( async ( options: { path: string; data?: { update?: Array< { id: number } > } } ) => {
			if ( options.path.includes( '/batch' ) ) {
				return { update: ( options.data?.update ?? [] ).map( ( row ) => ( { ...row, echoed: true } ) ) };
			}

			return { id: Number( options.path.match( /\/(\d+)(\?|$)/ )?.[ 1 ] ), echoed: true };
		} );
	} );

	afterEach( () => setSettings( undefined ) );

	it( 'sends `fields` (not `_fields`) on the batch routes, chunked by batchSize, under one batch id', async () => {
		setSettings( editSettings( { limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 2, actionBatchSize: 100 } } ) );

		const result = await batchProducts( [ { id: 1 }, { id: 2 }, { id: 3 } ], { batchId: 'b-1', source: 'bulk', fields: [ 'id', 'price', 'i18n.se.name' ] } );

		expect( result.update?.map( ( row ) => row.id ) ).toEqual( [ 1, 2, 3 ] );
		expect( calls().map( ( call ) => call.path ) ).toEqual( [ '/wc/v3/products/batch?fields=id%2Cprice%2Ci18n.se.name', '/wc/v3/products/batch?fields=id%2Cprice%2Ci18n.se.name' ] );
		expect( calls()[ 0 ] ).toMatchObject( { method: 'POST', data: { update: [ { id: 1 }, { id: 2 } ] }, wcProductsList: { batchId: 'b-1', source: 'bulk' } } );

		await batchVariations( 9, [ { id: 91 } ], { fields: [ 'id' ] } );
		expect( calls()[ 2 ]?.path ).toBe( '/wc/v3/products/9/variations/batch?fields=id' );

		await batchVariations( 9, [ { id: 91 } ] );
		expect( calls()[ 3 ]?.path ).toBe( '/wc/v3/products/9/variations/batch' );
	} );

	it( 'saves one row through POST products/{id} when the user may not batch (no edit_others_products)', async () => {
		setSettings( editSettings( { caps: { edit: true, editOthers: false, publish: true, delete: true, deleteOthers: false, manageWoocommerce: false, manageTerms: false } } ) );

		const result = await batchProducts( [ { id: 5, regular_price: '10' } ], { batchId: 'b-2', source: 'quick', fields: [ 'id', 'price' ] } );

		expect( calls()[ 0 ] ).toMatchObject( { path: '/wc/v3/products/5?_fields=id%2Cprice', method: 'POST', data: { regular_price: '10' }, wcProductsList: { batchId: 'b-2', source: 'quick' } } );
		expect( result ).toEqual( { update: [ { id: 5, echoed: true } ] } );

		const variations = await batchVariations( 7, [ { id: 71, stock_quantity: 3 } ] );
		expect( calls()[ 1 ] ).toMatchObject( { path: '/wc/v3/products/7/variations/71', method: 'POST', data: { stock_quantity: 3 } } );
		expect( variations.update?.[ 0 ] ).toMatchObject( { id: 71 } );

		// Several rows still go to the batch route (the server answers woocommerce_rest_cannot_batch).
		await batchProducts( [ { id: 1 }, { id: 2 } ] );
		expect( calls()[ 2 ]?.path ).toBe( '/wc/v3/products/batch' );
	} );

	it( 'shapes a failed single write as a batch item error', async () => {
		setSettings( editSettings( { caps: { edit: true, editOthers: false, publish: true, delete: true, deleteOthers: false, manageWoocommerce: false, manageTerms: false } } ) );
		fetchMock.mockRejectedValueOnce( { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.', data: { status: 404 } } );

		const result = await batchProducts( [ { id: 404 } ] );

		expect( result.update?.[ 0 ] ).toMatchObject( { id: 404, error: { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' } } );
	} );
} );

describe( 'list reads', () => {
	beforeEach( () => {
		fetchMock.mockReset();
		setSettings( editSettings() );
	} );

	afterEach( () => {
		setSettings( undefined );
		vi.unstubAllGlobals();
		delete ( fetchMock as unknown as { nonceEndpoint?: string } ).nonceEndpoint;
		delete ( fetchMock as unknown as { nonceMiddleware?: unknown } ).nonceMiddleware;
	} );

	function page( rows: unknown[], total = rows.length ): Response {
		return new Response( JSON.stringify( rows ), { status: 200, headers: { 'X-WP-Total': String( total ), 'X-WP-TotalPages': '1' } } );
	}

	it( 'refreshes a stale nonce once and retries the unparsed list request', async () => {
		const api = fetchMock as unknown as { nonceEndpoint?: string; nonceMiddleware?: { nonce: string } };
		api.nonceEndpoint = '/wp-admin/admin-ajax.php?action=rest-nonce';
		api.nonceMiddleware = { nonce: 'stale' };
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( new Response( 'fresh', { status: 200 } ) ) );

		// apiFetch rejects an unparsed (`parse: false`) failure with the raw Response, which core's own nonce retry does not recognise.
		fetchMock.mockRejectedValueOnce( new Response( JSON.stringify( { code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } } ), { status: 403 } ) );
		fetchMock.mockResolvedValueOnce( page( [ { id: 1, type: 'simple', name: 'A' } ], 1 ) );

		const result = await listProducts( { page: 1 } );

		expect( result.items.map( ( row ) => row.id ) ).toEqual( [ 1 ] );
		expect( result.total ).toBe( 1 );
		expect( api.nonceMiddleware.nonce ).toBe( 'fresh' );
		expect( globalThis.fetch ).toHaveBeenCalledWith( api.nonceEndpoint );
		expect( fetchMock ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'gives up after one refresh and surfaces the error, and never refreshes for another 403', async () => {
		const api = fetchMock as unknown as { nonceEndpoint?: string; nonceMiddleware?: { nonce: string } };
		api.nonceEndpoint = '/nonce';
		api.nonceMiddleware = { nonce: 'stale' };
		const refresh = vi.fn().mockResolvedValue( new Response( 'fresh', { status: 200 } ) );
		vi.stubGlobal( 'fetch', refresh );

		const stale = () => new Response( JSON.stringify( { code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } } ), { status: 403 } );
		fetchMock.mockRejectedValueOnce( stale() ).mockRejectedValueOnce( stale() );
		await expect( listProducts( { page: 1 } ) ).rejects.toMatchObject( { code: 'rest_cookie_invalid_nonce', status: 403 } );
		expect( refresh ).toHaveBeenCalledTimes( 1 );
		expect( fetchMock ).toHaveBeenCalledTimes( 2 );

		fetchMock.mockRejectedValueOnce( new Response( JSON.stringify( { code: 'rest_forbidden', message: 'Sorry', data: { status: 403 } } ), { status: 403 } ) );
		await expect( listProducts( { page: 1 } ) ).rejects.toMatchObject( { code: 'rest_forbidden', message: 'Sorry' } );
		expect( refresh ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'treats a failed Response an older apiFetch resolves with like a thrown one', async () => {
		fetchMock.mockResolvedValueOnce( new Response( JSON.stringify( { code: 'rest_forbidden', message: 'Sorry', data: { status: 403 } } ), { status: 403 } ) );

		await expect( listProducts( { page: 1 } ) ).rejects.toMatchObject( { code: 'rest_forbidden', status: 403 } );
	} );
} );

describe( 'runAction chunking', () => {
	afterEach( () => setSettings( undefined ) );

	it( 'chunks by the action\'s own limit and re-chunks to the server\'s data.max on wc_products_list_too_many_ids', async () => {
		setSettings( editSettings( { limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 100, actionBatchSize: 100, actionBatchSizes: { duplicate: 5, trash: 3 } } } ) );
		fetchMock.mockReset();
		fetchMock.mockImplementation( async ( options: { data: { ids: number[] } } ) => ( { results: options.data.ids.map( ( id ) => ( { id, ok: true } ) ), items: [] } ) );

		const ids = Array.from( { length: 12 }, ( _, index ) => index + 1 );
		const result = await runAction( 'duplicate', ids );

		expect( calls().map( ( call ) => ( call.data as { ids: number[] } ).ids.length ) ).toEqual( [ 5, 5, 2 ] );
		expect( result.results ).toHaveLength( 12 );
		expect( new Set( calls().map( ( call ) => ( call as { wcProductsList?: { batchId?: string } } ).wcProductsList?.batchId ) ).size ).toBe( 1 );

		fetchMock.mockReset();
		fetchMock.mockImplementation( async ( options: { data: { ids: number[] } } ) => {
			if ( options.data.ids.length > 2 ) {
				throw { code: 'wc_products_list_too_many_ids', message: 'Too many', data: { status: 400, max: 2 } };
			}

			return { results: options.data.ids.map( ( id ) => ( { id, ok: true } ) ), items: [] };
		} );

		const trashed = await runAction( 'trash', [ 1, 2, 3, 4, 5 ] );

		expect( trashed.results.map( ( row ) => row.id ) ).toEqual( [ 1, 2, 3, 4, 5 ] );
		expect( calls().map( ( call ) => ( call.data as { ids: number[] } ).ids ) ).toEqual( [ [ 1, 2, 3 ], [ 1, 2 ], [ 3 ], [ 4, 5 ] ] );
	} );
} );
