import { renderHook, waitFor } from '@testing-library/react';
import { addAction, doAction, removeAction } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS } from '../../resources/extensions/hooks';
import { normalizeProduct, normalizeVariation } from '../../resources/hierarchy/normalize';
import { resetHierarchyStore } from '../../resources/hierarchy/use-hierarchy';
import { setSettings } from '../../resources/settings';
import { PARENT_DERIVED_FIELDS, PRODUCTS_PREFIX, cachedProductIds, patchItems, refreshParentsOf, useProductList } from '../../resources/store/products';
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
