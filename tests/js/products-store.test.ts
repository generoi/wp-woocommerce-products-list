import { renderHook, waitFor } from '@testing-library/react';
import { addAction, doAction, removeAction } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS } from '../../resources/extensions/hooks';
import { normalizeProduct, normalizeVariation } from '../../resources/hierarchy/normalize';
import { resetHierarchyStore } from '../../resources/hierarchy/use-hierarchy';
import { setSettings } from '../../resources/settings';
import { COUNTS_KEY, PARENT_DERIVED_FIELDS, PRODUCTS_PREFIX, cachedProductIds, deletionsNamedByEditor, refreshParentIds, invalidateProducts, isEdited, markEdited, patchItems, refreshParentsOf, removeItems, resetEditedRows, retainEditedRows, subscribeRemoved, useProductList, variationsKey } from '../../resources/store/products';
import type { View } from '../../resources/dataviews';
import { cache } from '../../resources/store/query-cache';
import type { ListResult } from '../../resources/api/client';
import type { ProductListItem } from '../../resources/types';
import { sampleSettings } from './settings.test';

const listProducts = vi.fn();

vi.mock( '../../resources/api/client', () => ( {
	listProducts: ( ...args: unknown[] ) => listProducts( ...args ),
	getCounts: vi.fn(),
} ) );

const info = vi.fn();

vi.mock( '../../resources/actions/notices', () => ( { notify: { info: ( ...args: unknown[] ) => info( ...args ), error: vi.fn(), success: vi.fn() } } ) );

function parent( id: number, price = '179' ): ProductListItem {
	return normalizeProduct( { id, type: 'variable', name: `P${ id }`, price, on_sale: false, wc_products_list: { variation_count: 2, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 } } );
}

async function seedPage( items: ProductListItem[] ): Promise< void > {
	await cache.fetch< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1`, async () => ( { items, total: items.length, totalPages: 1 } ) );
}

function setup(): void {
	beforeEach( () => {
		setSettings( sampleSettings() );
		resetHierarchyStore();
		resetEditedRows();
		listProducts.mockReset();
	} );

	afterEach( () => {
		cache.clear();
		setSettings( undefined );
	} );
}

describe( 'refreshParentsOf', () => {
	setup();

	it( 'refetches the derived fields of the cached parents of saved variations and patches them in', async () => {
		await seedPage( [ parent( 10 ), parent( 11 ), normalizeProduct( { id: 12, type: 'simple', name: 'S' } ) ] );
		listProducts.mockResolvedValue( { items: [ { ...parent( 10, '149' ), on_sale: true } ], total: 1, totalPages: 1 } );

		const saved = [ normalizeVariation( { id: 1001, sale_price: '149' }, 10 ), normalizeVariation( { id: 2001 }, 99 ), normalizeProduct( { id: 12, type: 'simple' } ) ];
		const refreshed = await refreshParentsOf( saved );

		expect( refreshed ).toEqual( [ 10 ] );
		expect( listProducts ).toHaveBeenCalledTimes( 1 );
		expect( listProducts.mock.calls[ 0 ]?.[ 0 ] ).toEqual( { include: '10', per_page: 1, status: 'any', _fields: PARENT_DERIVED_FIELDS.join( ',' ) } );

		const page = cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data;
		expect( page?.items[ 0 ] ).toMatchObject( { id: 10, price: '149', on_sale: true, name: 'P10' } );
		expect( page?.items[ 1 ] ).toMatchObject( { id: 11, price: '179' } );
	} );

	it( 'does nothing when no saved row has a cached parent', async () => {
		await seedPage( [ parent( 10 ) ] );

		expect( await refreshParentsOf( [ normalizeVariation( { id: 1 }, 77 ), normalizeProduct( { id: 10, type: 'variable' } ) ] ) ).toEqual( [] );
		expect( listProducts ).not.toHaveBeenCalled();
	} );

	it( 'does not patch a parent that reads back half-deleted: once it is gone it leaves the list and is named', async () => {
		await seedPage( [ parent( 10 ), parent( 11 ) ] );
		info.mockReset();
		// WordPress deleted the product type term first: the parent reads back as a priceless Simple product, then is gone.
		listProducts
			.mockResolvedValueOnce( { items: [ normalizeProduct( { id: 10, type: 'simple', name: 'P10', price: '' } ), parent( 11, '99' ) ], total: 2, totalPages: 1 } )
			.mockResolvedValueOnce( { items: [ { id: 10, status: 'publish' } ], total: 1, totalPages: 1 } )
			.mockResolvedValueOnce( { items: [], total: 0, totalPages: 0 } );

		const refreshed = await refreshParentIds( [ 10, 11 ], undefined, { sleep: async () => {} } );

		expect( refreshed ).toEqual( [ 11 ] );
		expect( listProducts.mock.calls[ 1 ]?.[ 0 ] ).toMatchObject( { include: '10', _fields: 'id,status' } );

		const page = cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data;
		expect( page?.items.map( ( item ) => item.id ) ).toEqual( [ 11 ] );
		expect( page?.items[ 0 ] ).toMatchObject( { id: 11, price: '99' } );
		expect( info ).toHaveBeenCalledWith( expect.stringMatching( /1 product was deleted meanwhile .*: P10$/ ), expect.anything() );
	} );

	it( 'reads a parent again that is still there after the checks, names one missing, and leaves one the editor names to the editor', async () => {
		await seedPage( [ parent( 10 ), parent( 12 ) ] );
		info.mockReset();
		listProducts
			.mockResolvedValueOnce( { items: [ normalizeProduct( { id: 10, type: 'simple', name: 'P10' } ) ], total: 1, totalPages: 1 } )
			.mockResolvedValueOnce( { items: [ { id: 10, status: 'publish' } ], total: 1, totalPages: 1 } )
			.mockResolvedValueOnce( { items: [ { id: 10, status: 'publish' } ], total: 1, totalPages: 1 } )
			.mockResolvedValueOnce( { items: [ normalizeProduct( { id: 10, type: 'simple', name: 'P10', price: '5' } ) ], total: 1, totalPages: 1 } );

		expect( await refreshParentIds( [ 10, 12 ], undefined, { tries: 2, sleep: async () => {} } ) ).toEqual( [ 10 ] );
		expect( cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data?.items.map( ( item ) => item.id ) ).toEqual( [ 10 ] );
		expect( cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data?.items[ 0 ] ).toMatchObject( { price: '5' } );
		// 12 was missing from the first read and gone at the check: removed and named.
		expect( info ).toHaveBeenCalledWith( expect.stringMatching( /: P12$/ ), expect.anything() );
		info.mockReset();

		await seedPage( [ parent( 20 ) ] );
		deletionsNamedByEditor( [ 20 ] );
		listProducts.mockReset();
		listProducts.mockResolvedValue( { items: [], total: 0, totalPages: 0 } );
		await refreshParentIds( [ 20 ], undefined, { sleep: async () => {} } );
		expect( cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data?.items ).toEqual( [] );
		expect( info ).not.toHaveBeenCalled();
	} );

	it( 'runs after the saved action', async () => {
		await seedPage( [ parent( 10 ) ] );
		listProducts.mockResolvedValue( { items: [ parent( 10, '99' ) ], total: 1, totalPages: 1 } );

		doAction( ACTIONS.saved, { updated: [ normalizeVariation( { id: 1001 }, 10 ) ], errors: [], batchId: 'b' }, { source: 'bulk' } );

		await vi.waitFor( () => expect( cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data?.items[ 0 ]?.price ).toBe( '99' ) );
	} );
} );

describe( 'cachedProductIds / patchItems', () => {
	setup();

	it( 'lists product ids across cached pages and patches by id', async () => {
		await seedPage( [ parent( 10 ), parent( 11 ) ] );

		expect( Array.from( cachedProductIds() ) ).toEqual( [ 10, 11 ] );

		patchItems( [ { id: 11, name: 'Renamed' } ] );
		expect( cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data?.items[ 1 ]?.name ).toBe( 'Renamed' );
	} );
} );

describe( 'useProductList', () => {
	setup();

	it( 'fires wcProductsList.loaded once per completed request, not on optimistic patches', async () => {
		listProducts.mockResolvedValue( { items: [ parent( 10 ) ], total: 1, totalPages: 1 } );
		const loaded = vi.fn();
		addAction( ACTIONS.loaded, 'test/loaded', loaded );
		const view: View = { type: 'table', page: 1, perPage: 20, fields: [] };

		const { result, rerender, unmount } = renderHook( ( { v } ) => useProductList( v, 'all', [] ), { initialProps: { v: view } } );
		await waitFor( () => expect( result.current.items ).toHaveLength( 1 ) );
		expect( loaded ).toHaveBeenCalledTimes( 1 );
		expect( loaded.mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { tab: 'all', total: 1 } );

		// A bulk save patches the row several times: no new "load".
		patchItems( [ { id: 10, name: 'A' } ] );
		patchItems( [ { id: 10, name: 'B' } ] );
		await waitFor( () => expect( result.current.items[ 0 ]?.name ).toBe( 'B' ) );
		rerender( { v: view } );
		expect( loaded ).toHaveBeenCalledTimes( 1 );

		// A refetch is a load.
		await result.current.refetch();
		await waitFor( () => expect( loaded ).toHaveBeenCalledTimes( 2 ) );

		// Before afterEach drops the settings and clears the cache (both re-render the hook).
		unmount();
		removeAction( ACTIONS.loaded, 'test/loaded' );
	} );
} );

describe( 'edited rows that leave the filter', () => {
	setup();

	it( 'retainEditedRows puts edited rows back at their old positions, flagged, and counts them', () => {
		const previous = { items: [ parent( 10 ), parent( 11 ), parent( 12 ) ], total: 3, totalPages: 1 };
		const next = { items: [ parent( 10 ), parent( 12 ) ], total: 2, totalPages: 1 };

		const merged = retainEditedRows( previous, next, new Set( [ 11 ] ) );
		expect( merged.items.map( ( item ) => item.id ) ).toEqual( [ 10, 11, 12 ] );
		expect( merged.items[ 1 ]?._noLongerMatches ).toBe( true );
		expect( merged.items[ 0 ]?._noLongerMatches ).toBeUndefined();
		expect( merged.total ).toBe( 3 );

		// Not edited: it leaves. Nothing previous: the server's answer as is.
		expect( retainEditedRows( previous, next, new Set( [ 99 ] ) ) ).toBe( next );
		expect( retainEditedRows( undefined, next, new Set( [ 11 ] ) ) ).toBe( next );
	} );

	it( 'keeps rows changed by an action visible after the filtered list refetches, until the view changes', async () => {
		listProducts.mockResolvedValue( { items: [ parent( 10 ), parent( 11 ), parent( 12 ) ], total: 3, totalPages: 1 } );
		const view: View = { type: 'table', page: 1, perPage: 20, fields: [], search: 'missing' };
		const { result, rerender, unmount } = renderHook( ( { v } ) => useProductList( v, 'all', [] ), { initialProps: { v: view } } );
		await waitFor( () => expect( result.current.items ).toHaveLength( 3 ) );

		// An action (a language-tools copy) patches 10 and 11, then the list refetches without them.
		patchItems( [ { id: 10, name: 'Fixed' }, { id: 11, name: 'Fixed too' } ] );
		doAction( ACTIONS.actionPerformed, { action: 'i18n_copy', ids: [ 10, 11 ], batchId: 'b', items: [] } );
		listProducts.mockResolvedValue( { items: [ parent( 12 ) ], total: 1, totalPages: 1 } );
		invalidateProducts( { counts: false } );

		await waitFor( () => expect( listProducts ).toHaveBeenCalledTimes( 2 ) );
		await waitFor( () => expect( result.current.items.map( ( item ) => item.id ) ).toEqual( [ 10, 11, 12 ] ) );
		expect( result.current.items[ 0 ] ).toMatchObject( { name: 'Fixed', _noLongerMatches: true } );
		expect( result.current.items[ 2 ]?._noLongerMatches ).toBeUndefined();
		expect( result.current.total ).toBe( 3 );

		// A new search is a new view: they go.
		listProducts.mockResolvedValue( { items: [ parent( 12 ) ], total: 1, totalPages: 1 } );
		rerender( { v: { ...view, search: 'other' } } );
		await waitFor( () => expect( result.current.items.map( ( item ) => item.id ) ).toEqual( [ 12 ] ) );
		rerender( { v: view } );
		await result.current.refetch();
		await waitFor( () => expect( result.current.items.map( ( item ) => item.id ) ).toEqual( [ 12 ] ) );

		unmount();
	} );

	it( 'only marks rows written by a save or an action, never a cache merge', () => {
		// Hydrating an editor, a rollback, a parent's refreshed price range: merges only.
		patchItems( [ { id: 20, name: 'Hydrated' } ] );
		expect( isEdited( 20 ) ).toBe( false );

		doAction( ACTIONS.saved, { updated: [ parent( 21 ) ], errors: [] }, { source: 'quick' } );
		expect( isEdited( 21 ) ).toBe( true );

		doAction( ACTIONS.actionPerformed, { action: 'x', ids: [ 22 ], batchId: 'b', items: [] } );
		expect( isEdited( 22 ) ).toBe( true );

		markEdited( [ 23, -1, 0 ] );
		expect( isEdited( 23 ) ).toBe( true );
		expect( isEdited( -1 ) ).toBe( false );
	} );

	it( 'lets a row the editor only hydrated leave a filtered list on refetch', async () => {
		listProducts.mockResolvedValue( { items: [ parent( 10 ), parent( 11 ) ], total: 2, totalPages: 1 } );
		const view: View = { type: 'table', page: 1, perPage: 20, fields: [], search: 'missing' };
		const { result, unmount } = renderHook( ( { v } ) => useProductList( v, 'all', [] ), { initialProps: { v: view } } );
		await waitFor( () => expect( result.current.items ).toHaveLength( 2 ) );

		// The quick edit opened (hydrated 11) and was cancelled; something else refetched the list.
		patchItems( [ { id: 11, name: 'P11', description: 'full' } as Partial< ProductListItem > & { id: number } ] );
		listProducts.mockResolvedValue( { items: [ parent( 10 ) ], total: 1, totalPages: 1 } );
		invalidateProducts( { counts: false } );

		await waitFor( () => expect( result.current.items.map( ( item ) => item.id ) ).toEqual( [ 10 ] ) );
		expect( result.current.total ).toBe( 1 );

		unmount();
	} );
} );

describe( 'removeItems', () => {
	setup();

	it( 'drops the rows, tells the listeners, refetches the counts and updates the parents of removed variations', async () => {
		await seedPage( [ parent( 10 ), parent( 11 ), normalizeProduct( { id: 12, type: 'simple', name: 'S' } ) ] );
		await cache.fetch< ListResult< ProductListItem > >( variationsKey( 10, 1 ), async () => ( { items: [ normalizeVariation( { id: 1001 }, 10 ), normalizeVariation( { id: 1002 }, 10 ) ], total: 2, totalPages: 1 } ) );
		await cache.fetch( COUNTS_KEY, async () => ( { all: 3 } ) );
		listProducts.mockResolvedValue( { items: [ { ...parent( 10 ), _childCount: 1, wc_products_list: { variation_count: 1, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 } } ], total: 1, totalPages: 1 } );
		const removed = vi.fn();
		const unsubscribe = subscribeRemoved( removed );

		removeItems( [ 1002, 12 ] );
		unsubscribe();

		expect( removed ).toHaveBeenCalledWith( [ 1002, 12 ] );
		const page = cache.get< ListResult< ProductListItem > >( `${ PRODUCTS_PREFIX }page1` )?.data;
		expect( page?.items.map( ( item ) => item.id ) ).toEqual( [ 10, 11 ] );
		// The parent shows one variation fewer at once, then its derived fields are refetched.
		expect( page?.items[ 0 ] ).toMatchObject( { id: 10, _childCount: 1, _hasChildren: true, wc_products_list: { variation_count: 1 } } );
		expect( page?.items[ 1 ] ).toMatchObject( { id: 11, _childCount: 2 } );
		expect( cache.get< ListResult< ProductListItem > >( variationsKey( 10, 1 ) )?.data?.items.map( ( item ) => item.id ) ).toEqual( [ 1001 ] );
		// Nobody watches the counts here, so the invalidation drops them (a mounted tab bar refetches).
		expect( cache.get( COUNTS_KEY ) ).toBeUndefined();
		await vi.waitFor( () => expect( listProducts ).toHaveBeenCalledWith( expect.objectContaining( { include: '10', _fields: PARENT_DERIVED_FIELDS.join( ',' ) } ) ) );
	} );
} );

describe( 'removeItems across the pages of one query', () => {
	setup();

	it( 'lowers the total and the page count of every page of the query, also the page without the removed rows', async () => {
		const key = ( page: number, search = '' ) => `${ PRODUCTS_PREFIX }${ JSON.stringify( { page, per_page: 20, search } ) }`;
		const rows = ( from: number, count: number ) => Array.from( { length: count }, ( _, index ) => parent( from + index ) );

		// 22 products, 20 per page: page 1 holds 1..20, page 2 holds 21 and 22. Another search holds 21 too.
		await cache.fetch< ListResult< ProductListItem > >( key( 1 ), async () => ( { items: rows( 1, 20 ), total: 22, totalPages: 2 } ) );
		await cache.fetch< ListResult< ProductListItem > >( key( 2 ), async () => ( { items: rows( 21, 2 ), total: 22, totalPages: 2 } ) );
		await cache.fetch< ListResult< ProductListItem > >( key( 1, 'x' ), async () => ( { items: rows( 30, 3 ), total: 3, totalPages: 1 } ) );

		// Four parents on page 1 and the two of page 2 were deleted.
		removeItems( [ 3, 4, 5, 6, 21, 22 ] );

		const first = cache.get< ListResult< ProductListItem > >( key( 1 ) )?.data;
		const second = cache.get< ListResult< ProductListItem > >( key( 2 ) )?.data;

		expect( first?.items ).toHaveLength( 16 );
		expect( first ).toMatchObject( { total: 16, totalPages: 1 } );
		expect( second ).toMatchObject( { items: [], total: 16, totalPages: 1 } );
		// A query that held none of the rows keeps its total.
		expect( cache.get< ListResult< ProductListItem > >( key( 1, 'x' ) )?.data ).toMatchObject( { total: 3, totalPages: 1 } );
	} );
} );

describe( 'removeItems of rows no cached page holds', () => {
	setup();

	it( 'loads the pages on screen again (their total counted rows of pages not loaded yet)', async () => {
		const key = `${ PRODUCTS_PREFIX }${ JSON.stringify( { page: 1, per_page: 20 } ) }`;

		await cache.fetch< ListResult< ProductListItem > >( key, async () => ( { items: [ parent( 1 ), parent( 2 ) ], total: 22, totalPages: 2 } ) );
		const invalidate = vi.spyOn( cache, 'invalidate' );

		// Two products of page 2, never loaded, were found deleted by the editor.
		removeItems( [ 21, 22 ] );
		expect( invalidate ).toHaveBeenCalledWith( PRODUCTS_PREFIX );

		// Nobody watched the page: the invalidation dropped it. Loaded again, a row it holds is patched in place: no reload.
		expect( cache.get( key ) ).toBeUndefined();
		await cache.fetch< ListResult< ProductListItem > >( key, async () => ( { items: [ parent( 1 ), parent( 2 ) ], total: 20, totalPages: 1 } ) );
		invalidate.mockClear();
		removeItems( [ 2 ] );
		expect( invalidate ).not.toHaveBeenCalledWith( PRODUCTS_PREFIX );
		invalidate.mockRestore();
	} );
} );
