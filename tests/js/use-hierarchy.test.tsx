import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { doAction } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HierarchicalDataViews, HierarchyProvider, HierarchyViewProvider, NameCell, useHierarchyContext, withoutPlaceholderIds } from '../../resources/hierarchy';
import {
	BULK_PUBLISH_ROWS,
	EXPANDED_STORAGE_KEY,
	EXPAND_ALL_MAX_ROWS,
	EXPAND_ALL_WARN_ROWS,
	MAX_CACHED_PARENTS,
	MAX_CONCURRENT_REQUESTS,
	boundExpanded,
	createLimiter,
	getChildrenState,
	invalidateVariations,
	loadingParentIds,
	patchVariationRows,
	removeVariationRows,
	resetHierarchyStore,
	subscribeChildren,
	subscribeExpandAllProgress,
	getExpandAllProgress,
	useHierarchy,
} from '../../resources/hierarchy/use-hierarchy';
import type { FetchVariations, VariationsResult } from '../../resources/hierarchy/use-hierarchy';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { ACTIONS } from '../../resources/extensions/hooks';
import { setSettings } from '../../resources/settings';
import { getItemId } from '../../resources/types';
import type { View } from '../../resources/dataviews';
import type { ProductField, ProductRow, RawVariation, Settings } from '../../resources/types';

vi.mock( '../../resources/api/client', () => ( { getVariations: vi.fn() } ) );

function parent( id: number, count = 2 ): ProductRow {
	return normalizeProduct( {
		id,
		type: count > 0 ? 'variable' : 'simple',
		name: `P${ id }`,
		wc_products_list: { variation_count: count, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 },
	} );
}

function rawVariation( parentId: number, n: number ): RawVariation {
	return { id: parentId * 1000 + n, sku: `S${ n }`, status: 'publish', attributes: [ { id: 1, name: 'Size', option: String( n ) } ] };
}

/** A fake server: `counts[parentId]` variations, paginated like wc/v3; honours the abort signal like fetch does. */
function fakeFetch( counts: Record< number, number >, options: { delay?: number; fail?: Set< number > } = {} ) {
	const calls: Array< { parentId: number; page: number; perPage: number; fields: string[]; signal?: AbortSignal } > = [];
	let active = 0;
	let maxActive = 0;

	const fetch: FetchVariations = async ( parentId, page, { perPage, fields, signal } ) => {
		calls.push( { parentId, page, perPage, fields, signal } );
		active += 1;
		maxActive = Math.max( maxActive, active );

		try {
			await new Promise< void >( ( resolve, reject ) => {
				const timer = setTimeout( resolve, options.delay ?? 0 );
				signal?.addEventListener( 'abort', () => {
					clearTimeout( timer );
					reject( Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ) );
				} );
			} );

			if ( options.fail?.has( parentId ) ) {
				throw new Error( `Boom ${ parentId }` );
			}

			const total = counts[ parentId ] ?? 0;
			const start = ( page - 1 ) * perPage;
			const items = Array.from( { length: Math.max( 0, Math.min( perPage, total - start ) ) }, ( _, i ) => rawVariation( parentId, start + i + 1 ) );
			const result: VariationsResult = { items, total, totalPages: Math.max( 1, Math.ceil( total / perPage ) ) };

			return result;
		} finally {
			active -= 1;
		}
	};

	return { fetch, calls, maxActive: () => maxActive };
}

const fields: ProductField[] = [
	{ id: 'name', label: 'Name', rest: { fields: [ 'name' ], applies: { product: true, variation: true } }, productTypes: 'all', edit: false },
	{ id: 'price', label: 'Price', rest: { fields: [ 'price', 'regular_price' ], applies: { product: true, variation: true } }, productTypes: 'all', edit: false },
];

function memoryStorage() {
	const map = new Map< string, string >();

	return {
		getItem: ( key: string ) => map.get( key ) ?? null,
		setItem: ( key: string, value: string ) => {
			map.set( key, value );
		},
		dump: () => Object.fromEntries( map ),
	};
}

beforeEach( () => {
	resetHierarchyStore();
	setSettings( { limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 50, actionBatchSize: 100 } } as unknown as Settings );
} );

afterEach( () => {
	setSettings( undefined );
	window.sessionStorage.clear();
} );

describe( 'useHierarchy', () => {
	it( 'starts collapsed and renders the parents', () => {
		const { fetch } = fakeFetch( { 1: 2 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ), parent( 2, 0 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '2' ] );
		expect( result.current.expandedItemIds ).toEqual( [] );
		expect( result.current.getItemHasChildren( result.current.rows[ 0 ]! ) ).toBe( true );
		expect( result.current.getItemParentId( result.current.rows[ 0 ]! ) ).toBeNull();
		expect( result.current.getItemLevel( result.current.rows[ 0 ]! ) ).toBe( 0 );
	} );

	it( 'expands a parent: placeholder first, then the variations with the right _fields', async () => {
		const { fetch, calls } = fakeFetch( { 1: 3 }, { delay: 5 } );
		const storage = memoryStorage();
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 3 ), parent( 2 ) ], fields, { fetchVariations: fetch, storage } ) );

		let done: Promise< void > | undefined;
		act( () => {
			done = result.current.expand( 1 );
		} );

		expect( result.current.expandedItemIds ).toEqual( [ 1 ] );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1:loading', '2' ] );
		expect( result.current.childrenOf( 1 )?.status ).toBe( 'loading' );

		await act( async () => {
			await done;
		} );

		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1001', '1002', '1003', '2' ] );
		expect( result.current.rows[ 1 ] ).toMatchObject( { name: '1', _level: 1, _parentId: 1, type: 'variation' } );
		expect( result.current.childrenOf( 1 ) ).toMatchObject( { status: 'loaded', total: 3 } );
		expect( calls ).toHaveLength( 1 );
		expect( calls[ 0 ] ).toMatchObject( { parentId: 1, page: 1, perPage: 100 } );
		expect( calls[ 0 ]!.fields ).toEqual( expect.arrayContaining( [ 'id', 'name', 'attributes', 'image', 'wc_products_list', 'price', 'regular_price' ] ) );
		expect( JSON.parse( storage.dump()[ EXPANDED_STORAGE_KEY ]! ) ).toEqual( [ 1 ] );
	} );

	it( 'pages through more than 100 variations and keeps server order', async () => {
		const { fetch, calls } = fakeFetch( { 1: 250 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 250 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		expect( calls.map( ( c ) => c.page ) ).toEqual( [ 1, 2, 3 ] );
		expect( result.current.rows ).toHaveLength( 251 );
		expect( result.current.rows.slice( 1 ).map( ( row ) => row.id ) ).toEqual( Array.from( { length: 250 }, ( _, i ) => 1001 + i ) );
	} );

	it( 'stops fetching at maxChildrenPerParent and shows the "more" row', async () => {
		const { fetch, calls } = fakeFetch( { 1: 450 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 450 ) ], fields, { fetchVariations: fetch, storage: null, maxChildren: 150 } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		expect( calls.map( ( c ) => c.page ) ).toEqual( [ 1, 2 ] );
		const ids = result.current.rows.map( getItemId );
		expect( ids ).toHaveLength( 152 );
		expect( ids.at( -1 ) ).toBe( '1:more' );
		expect( result.current.rows.at( -1 )?._placeholderMessage ).toBe( '300 more variations are not shown.' );
	} );

	it( 'collapses and toggles without refetching', async () => {
		const { fetch, calls } = fakeFetch( { 1: 2 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );
		act( () => result.current.collapse( 1 ) );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1' ] );
		expect( result.current.isExpanded( 1 ) ).toBe( false );

		act( () => result.current.toggle( 1 ) );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1001', '1002' ] );
		act( () => result.current.toggle( 1 ) );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1' ] );
		expect( calls ).toHaveLength( 1 );
	} );

	it( 'dedupes concurrent expands of the same parent', async () => {
		const { fetch, calls } = fakeFetch( { 1: 2 }, { delay: 5 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await Promise.all( [ result.current.expand( 1 ), result.current.expand( 1 ), result.current.expand( 1 ) ] );
		} );

		expect( calls ).toHaveLength( 1 );
	} );

	it( 'shows the error row with the message and retries', async () => {
		const fail = new Set( [ 1 ] );
		const { fetch, calls } = fakeFetch( { 1: 2 }, { fail } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1:error' ] );
		expect( result.current.rows[ 1 ]?._placeholderMessage ).toBe( 'Boom 1' );
		expect( result.current.childrenOf( 1 )?.status ).toBe( 'error' );

		// Collapsing and expanding again must not spin a refetch loop.
		act( () => result.current.collapse( 1 ) );
		act( () => result.current.toggle( 1 ) );
		await act( async () => {} );
		expect( calls ).toHaveLength( 2 );

		fail.clear();
		await act( async () => {
			await result.current.retry( 1 );
		} );

		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1001', '1002' ] );
	} );

	it( 'restores the expanded ids from sessionStorage and loads them', async () => {
		window.sessionStorage.setItem( EXPANDED_STORAGE_KEY, JSON.stringify( [ 2, 'x', -1, 7 ] ) );
		const { fetch, calls } = fakeFetch( { 2: 1, 7: 1 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ), parent( 2, 1 ) ], fields, { fetchVariations: fetch } ) );

		expect( result.current.expandedItemIds ).toEqual( [ 2, 7 ] );

		await waitFor( () => expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '2', '2001' ] ) );
		// 7 is not on this page: nothing fetched for it.
		expect( calls.map( ( c ) => c.parentId ) ).toEqual( [ 2 ] );
	} );

	it( 'loads a restored parent when it appears on a later page', async () => {
		const { fetch } = fakeFetch( { 7: 1 } );
		const storage = memoryStorage();
		storage.setItem( EXPANDED_STORAGE_KEY, JSON.stringify( [ 7 ] ) );
		const { result, rerender } = renderHook( ( { parents } ) => useHierarchy( parents, fields, { fetchVariations: fetch, storage } ), {
			initialProps: { parents: [ parent( 1 ) ] },
		} );

		expect( result.current.rows ).toHaveLength( 1 );
		rerender( { parents: [ parent( 7, 1 ) ] } );
		await waitFor( () => expect( result.current.rows.map( getItemId ) ).toEqual( [ '7', '7001' ] ) );
	} );

	it( 'expands all variable products on the page with at most MAX_CONCURRENT_REQUESTS requests in flight', async () => {
		const parents = Array.from( { length: 10 }, ( _, i ) => parent( i + 1, i === 4 ? 0 : 120 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls, maxActive } = fakeFetch( counts, { delay: 2 } );
		// 9 x 120 rows is above EXPAND_ALL_WARN_ROWS; the warning is answered here.
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null, confirmExpandAll: () => true } ) );

		let ok: boolean | undefined;
		await act( async () => {
			ok = await result.current.expandAll();
		} );

		expect( ok ).toBe( true );
		expect( result.current.expandedItemIds ).toEqual( [ 1, 2, 3, 4, 6, 7, 8, 9, 10 ] );
		expect( calls ).toHaveLength( 9 * 2 );
		expect( maxActive() ).toBeLessThanOrEqual( MAX_CONCURRENT_REQUESTS );
		expect( result.current.rows ).toHaveLength( 10 + 9 * 120 );

		act( () => result.current.collapseAll() );
		expect( result.current.expandedItemIds ).toEqual( [] );
		expect( result.current.rows ).toHaveLength( 10 );
	} );

	it( 'asks before expanding more than EXPAND_ALL_WARN_ROWS rows and respects the answer', async () => {
		// 10 parents + 1,000 rows: above the warning, under the hard limit.
		const parents = Array.from( { length: 10 }, ( _, i ) => parent( i + 1, 100 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls } = fakeFetch( counts );
		const confirm = vi.fn( async () => false );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null, confirmExpandAll: confirm } ) );

		let ok: boolean | undefined;
		await act( async () => {
			ok = await result.current.expandAll();
		} );

		expect( ok ).toBe( false );
		expect( confirm ).toHaveBeenCalledWith( 10 + 1000 );
		expect( calls ).toHaveLength( 0 );
		expect( result.current.expandedItemIds ).toEqual( [] );

		confirm.mockResolvedValue( true );
		await act( async () => {
			ok = await result.current.expandAll();
		} );
		expect( ok ).toBe( true );
		expect( result.current.rows ).toHaveLength( 1010 );

		// force skips the question.
		act( () => result.current.collapseAll() );
		confirm.mockClear();
		await act( async () => {
			await result.current.expandAll( { force: true } );
		} );
		expect( confirm ).not.toHaveBeenCalled();
	} );

	it( 'expandAll stops at EXPAND_ALL_MAX_ROWS, in page order, and reports what it skipped', async () => {
		const parents = Array.from( { length: 30 }, ( _, i ) => parent( i + 1, 100 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls } = fakeFetch( counts );
		const onExpandAllLimit = vi.fn();
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null, confirmExpandAll: () => true, onExpandAllLimit } ) );

		let ok: boolean | undefined;
		await act( async () => {
			ok = await result.current.expandAll();
		} );

		// 30 parents + 14 x 100 = 1,430 rows; the 15th would make 1,530.
		const fit = Math.floor( ( EXPAND_ALL_MAX_ROWS - 30 ) / 100 );
		expect( ok ).toBe( true );
		expect( result.current.expandedItemIds ).toEqual( Array.from( { length: fit }, ( _, i ) => i + 1 ) );
		expect( calls ).toHaveLength( fit );
		expect( result.current.rows ).toHaveLength( 30 + fit * 100 );
		expect( onExpandAllLimit ).toHaveBeenCalledWith( { expanded: fit, skipped: 30 - fit, rows: 30 + fit * 100 } );

		// Nothing more fits: expandAll says so and expands nothing.
		onExpandAllLimit.mockClear();
		await act( async () => {
			ok = await result.current.expandAll();
		} );
		expect( ok ).toBe( false );
		expect( onExpandAllLimit ).toHaveBeenCalledWith( { expanded: 0, skipped: 30 - fit, rows: 30 + fit * 100 } );
		expect( calls ).toHaveLength( fit );
	} );

	it( 'bounds a restored expansion to EXPAND_ALL_WARN_ROWS on load and rewrites the stored ids', async () => {
		const parents = Array.from( { length: 20 }, ( _, i ) => parent( i + 1, 100 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls } = fakeFetch( counts );
		const storage = memoryStorage();
		// 99 is on another page and must survive.
		storage.setItem( EXPANDED_STORAGE_KEY, JSON.stringify( [ 99, ...parents.map( ( p ) => p.id ) ] ) );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage } ) );

		// 20 parents + 5 x 100 = 520 rows; a 6th would make 620.
		const fit = Math.floor( ( EXPAND_ALL_WARN_ROWS - 20 ) / 100 );
		const kept = [ 99, ...Array.from( { length: fit }, ( _, i ) => i + 1 ) ];
		await waitFor( () => expect( result.current.expandedItemIds ).toEqual( kept ) );
		await waitFor( () => expect( result.current.rows ).toHaveLength( 20 + fit * 100 ) );
		expect( new Set( calls.map( ( c ) => c.parentId ) ) ).toEqual( new Set( kept.slice( 1 ) ) );
		expect( JSON.parse( storage.dump()[ EXPANDED_STORAGE_KEY ]! ) ).toEqual( kept );
	} );

	it( 'bounds the expansion of a page it lands on to EXPAND_ALL_MAX_ROWS, and leaves a confirmed one alone', async () => {
		const page1 = Array.from( { length: 30 }, ( _, i ) => parent( i + 1, 100 ) );
		const page2 = Array.from( { length: 30 }, ( _, i ) => parent( 100 + i + 1, 100 ) );
		const counts = Object.fromEntries( [ ...page1, ...page2 ].map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch } = fakeFetch( counts );
		const { result, rerender } = renderHook( ( { parents } ) => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null, confirmExpandAll: () => true } ), {
			initialProps: { parents: page1 },
		} );

		// The contract's setter accepts any ids; the page they belong to is bounded when it shows.
		act( () => result.current.onChangeExpandedItemIds( page2.map( ( p ) => p.id ) ) );
		expect( result.current.expandedItemIds ).toHaveLength( 30 );

		rerender( { parents: page2 } );
		const fit = Math.floor( ( EXPAND_ALL_MAX_ROWS - 30 ) / 100 );
		await waitFor( () => expect( result.current.expandedItemIds ).toEqual( page2.slice( 0, fit ).map( ( p ) => p.id ) ) );
		await waitFor( () => expect( result.current.rows ).toHaveLength( 30 + fit * 100 ) );

		// A save re-creates the parent rows (same ids): nothing is trimmed again.
		rerender( { parents: page2.map( ( p ) => ( { ...p } ) ) } );
		await act( async () => {} );
		expect( result.current.expandedItemIds ).toHaveLength( fit );
	} );

	it( 'variationIdsOf uses loaded children or fetches only ids', async () => {
		const { fetch, calls } = fakeFetch( { 1: 2, 2: 150 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ), parent( 2, 150 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );
		calls.length = 0;

		const ids = await result.current.variationIdsOf( [ 1, 2 ] );

		expect( ids ).toEqual( [ 1001, 1002, ...Array.from( { length: 150 }, ( _, i ) => 2001 + i ) ] );
		expect( calls.map( ( c ) => [ c.parentId, c.page, c.fields ] ) ).toEqual( [ [ 2, 1, [ 'id' ] ], [ 2, 2, [ 'id' ] ] ] );

		// Cached the second time.
		calls.length = 0;
		await result.current.variationIdsOf( [ 2 ] );
		expect( calls ).toHaveLength( 0 );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1001', '1002', '2' ] );
	} );

	it( 'selectVariations expands the parent and adds its rows to the selection', async () => {
		const { fetch } = fakeFetch( { 1: 2 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		let selection: string[] = [];
		await act( async () => {
			selection = await result.current.selectVariations( 1, [ '1', '1001' ] );
		} );

		expect( selection ).toEqual( [ '1', '1001', '1002' ] );
		expect( result.current.isExpanded( 1 ) ).toBe( true );
	} );

	it( 'patches, removes and invalidates variation rows from outside', async () => {
		const { fetch, calls } = fakeFetch( { 1: 2 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		act( () => patchVariationRows( [ { id: 1002, sku: 'NEW', image: { id: 3, src: 'x' } }, { id: 999, sku: 'nope' } ] ) );
		expect( result.current.rows[ 2 ] ).toMatchObject( { id: 1002, sku: 'NEW', images: [ { id: 3, src: 'x' } ], _parentId: 1 } );

		act( () => removeVariationRows( [ 1001 ] ) );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1002' ] );
		expect( result.current.childrenOf( 1 )?.total ).toBe( 1 );

		act( () => invalidateVariations() );
		await waitFor( () => expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1001', '1002' ] ) );
		expect( calls ).toHaveLength( 2 );

		// A removed parent drops its whole state (collapsed first: an expanded one reloads).
		act( () => result.current.collapse( 1 ) );
		act( () => removeVariationRows( [ 1 ] ) );
		expect( result.current.childrenOf( 1 ) ).toBeUndefined();
	} );

	it( 'follows the saved and deleted actions', async () => {
		const { fetch } = fakeFetch( { 1: 2 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		act( () => {
			doAction( ACTIONS.saved, { updated: [ { id: 1001, sku: 'SAVED' } ], errors: [], batchId: 'b' }, { source: 'bulk' } );
		} );
		expect( result.current.rows[ 1 ] ).toMatchObject( { id: 1001, sku: 'SAVED' } );

		act( () => {
			doAction( ACTIONS.deleted, [ 1002 ], { action: 'delete', batchId: 'b' } );
		} );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '1001' ] );
	} );

	it( 'publishes page 1 before the remaining pages arrive', async () => {
		// Each page takes longer than the emit window, as on a real server.
		const { fetch } = fakeFetch( { 1: 250 }, { delay: 70 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 250 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		let done: Promise< void > | undefined;
		act( () => {
			done = result.current.expand( 1 );
		} );

		// Page 1 (100 rows) is on screen with the loading row below it while pages 2-3 load.
		await waitFor( () => expect( result.current.rows ).toHaveLength( 102 ) );
		expect( result.current.childrenOf( 1 ) ).toMatchObject( { status: 'loading', total: 250 } );
		expect( getItemId( result.current.rows.at( -1 )! ) ).toBe( '1:loading' );

		await act( async () => {
			await done;
		} );
		expect( result.current.rows ).toHaveLength( 251 );
	} );

	it( 'expandAll reports its progress through the progress store and clears it at the end', async () => {
		const parents = [ parent( 1, 2 ), parent( 2, 2 ), parent( 3, 2 ) ];
		const { fetch } = fakeFetch( { 1: 2, 2: 2, 3: 2 }, { delay: 10 } );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } ) );
		const seen: Array< { done: number; total: number } | null > = [];
		const unsubscribe = subscribeExpandAllProgress( () => seen.push( getExpandAllProgress() ) );

		await act( async () => {
			await result.current.expandAll();
		} );
		unsubscribe();

		expect( seen ).toEqual( [ { done: 0, total: 3 }, { done: 1, total: 3 }, { done: 2, total: 3 }, { done: 3, total: 3 }, null ] );
		expect( result.current.rows ).toHaveLength( 9 );
	} );

	it( 'expandAll publishes a handful of renders, not one per parent', async () => {
		const counts: Record< number, number > = {};
		const parents: ProductRow[] = [];

		for ( let id = 1; id <= 12; id++ ) {
			counts[ id ] = 3;
			parents.push( parent( id, 3 ) );
		}

		const { fetch, calls } = fakeFetch( counts, { delay: 15 } );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } ) );
		const emits: number[] = [];
		const unsubscribe = subscribeChildren( () => emits.push( Date.now() ) );

		await act( async () => {
			await result.current.expandAll();
		} );
		unsubscribe();

		expect( calls ).toHaveLength( 12 );
		expect( result.current.rows ).toHaveLength( 12 + 36 );
		// Nothing is published while the loads run: one emit when the last one is in.
		expect( emits ).toHaveLength( 1 );
		expect( getExpandAllProgress() ).toBeNull();

		// A single expand still shows its loading marker at once.
		const single = fakeFetch( { 99: 2 }, { delay: 30 } );
		const other = renderHook( () => useHierarchy( [ parent( 99, 2 ) ], fields, { fetchVariations: single.fetch, storage: null } ) );
		act( () => {
			void other.result.current.expand( 99 );
		} );
		expect( other.result.current.childrenOf( 99 )?.status ).toBe( 'loading' );
		await waitFor( () => expect( other.result.current.childrenOf( 99 )?.status ).toBe( 'loaded' ) );
	} );

	it( 'aborts the request when the parent is collapsed while loading, and reloads on the next expand', async () => {
		const { fetch, calls } = fakeFetch( { 1: 150 }, { delay: 30 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 150 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		let first: Promise< void > | undefined;
		act( () => {
			first = result.current.expand( 1 );
		} );
		expect( loadingParentIds() ).toEqual( [ 1 ] );

		act( () => result.current.collapse( 1 ) );
		expect( calls[ 0 ]?.signal?.aborted ).toBe( true );
		expect( loadingParentIds() ).toEqual( [] );

		await act( async () => {
			await first;
		} );
		// Back to idle, no error row, nothing fetched for the parent after the abort.
		expect( result.current.childrenOf( 1 )?.status ).toBe( 'idle' );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1' ] );
		expect( calls ).toHaveLength( 1 );

		await act( async () => {
			await result.current.expand( 1 );
		} );
		expect( result.current.rows ).toHaveLength( 151 );
		expect( calls.map( ( c ) => c.page ) ).toEqual( [ 1, 1, 2 ] );
	} );

	it( 'aborts loads of parents that left the page and of everything on unmount', async () => {
		const { fetch, calls } = fakeFetch( { 1: 5, 2: 5 }, { delay: 30 } );
		const { result, rerender, unmount } = renderHook( ( { parents } ) => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } ), {
			initialProps: { parents: [ parent( 1, 5 ), parent( 2, 5 ) ] },
		} );

		act( () => {
			void result.current.expand( 1 );
			void result.current.expand( 2 );
		} );
		expect( loadingParentIds() ).toEqual( [ 1, 2 ] );

		// Next page: parent 1 is gone, parent 2 stays.
		rerender( { parents: [ parent( 2, 5 ), parent( 3, 5 ) ] } );
		expect( calls.find( ( c ) => c.parentId === 1 )?.signal?.aborted ).toBe( true );
		expect( calls.find( ( c ) => c.parentId === 2 )?.signal?.aborted ).toBe( false );
		expect( loadingParentIds() ).toEqual( [ 2 ] );

		unmount();
		expect( calls.find( ( c ) => c.parentId === 2 )?.signal?.aborted ).toBe( true );
		expect( loadingParentIds() ).toEqual( [] );
	} );

	it( 'drops queued pages of a collapsed parent before they take a request slot', async () => {
		// 7 one-page loads through MAX_CONCURRENT_REQUESTS slots (below the EXPAND_ALL_WARN_ROWS
		// confirm, so the loads start synchronously): one is queued; collapsing all while the first batch is in flight.
		const parents = Array.from( { length: 7 }, ( _, i ) => parent( i + 1, 80 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls } = fakeFetch( counts, { delay: 20 } );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } ) );

		let done: Promise< boolean > | undefined;
		act( () => {
			done = result.current.expandAll();
		} );
		expect( calls ).toHaveLength( MAX_CONCURRENT_REQUESTS );

		act( () => result.current.collapseAll() );
		await act( async () => {
			await done;
		} );

		expect( calls ).toHaveLength( MAX_CONCURRENT_REQUESTS );
		expect( calls.every( ( c ) => c.signal?.aborted ) ).toBe( true );
		expect( result.current.rows ).toHaveLength( 7 );
		expect( loadingParentIds() ).toEqual( [] );
	} );

	it( 'evicts loaded children of parents that are neither expanded nor on the page', async () => {
		const many = Array.from( { length: MAX_CACHED_PARENTS + 5 }, ( _, i ) => parent( i + 1, 1 ) );
		const counts = Object.fromEntries( many.map( ( p ) => [ p.id, 1 ] ) );
		const { fetch } = fakeFetch( counts );
		const { result, rerender } = renderHook( ( { parents } ) => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } ), {
			initialProps: { parents: many },
		} );

		await act( async () => {
			await result.current.expandAll( { force: true } );
		} );
		expect( getChildrenState().size ).toBe( many.length );

		// Collapse everything and page to a parent not among them: the next load evicts the surplus.
		act( () => result.current.collapseAll() );
		rerender( { parents: [ parent( 999, 1 ) ] } );
		await act( async () => {
			await result.current.expand( 999 );
		} );

		expect( getChildrenState().size ).toBeLessThanOrEqual( MAX_CACHED_PARENTS );
		expect( getChildrenState().has( 999 ) ).toBe( true );
	} );

	it( 'selectVariations can take only the variations a predicate accepts', async () => {
		const { fetch } = fakeFetch( { 1: 3 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 3 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		let selection: string[] = [];
		await act( async () => {
			selection = await result.current.selectVariations( 1, [ '1' ], ( item ) => item.sku !== 'S2' );
		} );

		expect( selection ).toEqual( [ '1', '1001', '1003' ] );
	} );

	it( 'onChangeExpandedItemIds dedupes and drops invalid ids', () => {
		const { fetch } = fakeFetch( {} );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		act( () => result.current.onChangeExpandedItemIds( [ 3, 3, 0, -2, 1.5, 4 ] ) );
		expect( result.current.expandedItemIds ).toEqual( [ 3, 4 ] );
	} );
} );

describe( 'boundExpanded', () => {
	it( 'keeps ids of other pages and the first on-page ids that fit', () => {
		const parents = [ parent( 1, 50 ), parent( 2, 0 ), parent( 3, 50 ), parent( 4, 50 ) ];

		expect( boundExpanded( [ 9, 4, 1, 3 ], parents, new Map(), 1000, 104 ) ).toEqual( [ 9, 1, 3 ] );
		expect( boundExpanded( [ 9, 1 ], parents, new Map(), 1000, 10 ) ).toEqual( [ 9 ] );
		const unchanged = [ 1, 3 ];
		expect( boundExpanded( unchanged, parents, new Map(), 1000, 1000 ) ).toBe( unchanged );
	} );
} );

describe( 'createLimiter', () => {
	it( 'runs at most N tasks at once and releases on failure', async () => {
		const run = createLimiter( 2 );
		let active = 0;
		let max = 0;
		const task = ( fail = false ) => async () => {
			active += 1;
			max = Math.max( max, active );
			await new Promise( ( resolve ) => setTimeout( resolve, 2 ) );
			active -= 1;
			if ( fail ) {
				throw new Error( 'x' );
			}
			return active;
		};

		const results = await Promise.allSettled( [ run( task() ), run( task( true ) ), run( task() ), run( task() ), run( task() ) ] );

		expect( max ).toBe( 2 );
		expect( results.map( ( r ) => r.status ) ).toEqual( [ 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled' ] );
	} );

	it( 'rejects a queued task that was cancelled before its turn without running it', async () => {
		const run = createLimiter( 1 );
		let cancelled = false;
		const ran: string[] = [];
		const task = ( name: string ) => async () => {
			ran.push( name );
			await new Promise( ( resolve ) => setTimeout( resolve, 2 ) );

			return name;
		};

		const first = run( task( 'a' ) );
		const second = run( task( 'b' ), { isCancelled: () => cancelled } );
		const third = run( task( 'c' ) );
		cancelled = true;

		expect( await first ).toBe( 'a' );
		await expect( second ).rejects.toMatchObject( { name: 'AbortError' } );
		expect( await third ).toBe( 'c' );
		expect( ran ).toEqual( [ 'a', 'c' ] );
	} );
} );

describe( 'withoutPlaceholderIds', () => {
	it( 'keeps numeric ids only', () => {
		expect( withoutPlaceholderIds( [ '1', '1:loading', '2:more', '1001' ] ) ).toEqual( [ '1', '1001' ] );
	} );
} );

describe( 'NameCell + Chevron', () => {
	function Harness( { parents, fetch }: { parents: ProductRow[]; fetch: FetchVariations } ) {
		const hierarchy = useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } );

		return (
			<HierarchyProvider value={ hierarchy }>
				<HierarchyViewProvider
					value={ {
						getItemParentId: hierarchy.getItemParentId,
						getItemHasChildren: hierarchy.getItemHasChildren,
						expandedItemIds: hierarchy.expandedItemIds,
						onChangeExpandedItemIds: hierarchy.onChangeExpandedItemIds,
						childrenState: hierarchy.childrenState,
						onRetryChildren: hierarchy.retry,
					} }
				>
					<ul>
						{ hierarchy.rows.map( ( row ) => (
							<li key={ getItemId( row ) } data-testid="row" onClick={ () => rowClicks.push( getItemId( row ) ) }>
								<NameCell item={ row }>
									<a href={ `#${ row.id }` }>{ row.name }</a>
								</NameCell>
							</li>
						) ) }
					</ul>
					<Toolbar />
				</HierarchyViewProvider>
			</HierarchyProvider>
		);
	}

	function Toolbar() {
		const { expandAll, collapseAll } = useHierarchyContext();

		return (
			<>
				<button onClick={ () => void expandAll() }>Expand all</button>
				<button onClick={ collapseAll }>Collapse all</button>
			</>
		);
	}

	const rowClicks: string[] = [];

	beforeEach( () => {
		rowClicks.length = 0;
	} );

	it( 'renders a chevron with the count for parents and a spacer otherwise', () => {
		const { fetch } = fakeFetch( { 1: 3 } );
		render( <Harness parents={ [ parent( 1, 3 ), parent( 2, 0 ) ] } fetch={ fetch } /> );

		const button = screen.getByRole( 'button', { name: 'Expand 3 variations' } );
		expect( button ).toHaveAttribute( 'aria-expanded', 'false' );
		expect( button ).not.toHaveAttribute( 'aria-controls' );
		expect( button.querySelector( '.wc-pl-chevron__count' ) ).toHaveTextContent( '3' );
		expect( screen.getAllByTestId( 'row' )[ 1 ]!.querySelector( '.wc-pl-chevron--spacer' ) ).toBeInTheDocument();
		expect( screen.getAllByTestId( 'row' )[ 1 ]!.querySelector( 'button' ) ).toBeNull();
	} );

	it( 'toggles on click without bubbling to the row, indents children and wires aria-controls', async () => {
		const { fetch } = fakeFetch( { 1: 2 } );
		render( <Harness parents={ [ parent( 1 ) ] } fetch={ fetch } /> );

		fireEvent.click( screen.getByRole( 'button', { name: 'Expand 2 variations' } ) );
		expect( rowClicks ).toEqual( [] );

		const button = screen.getByRole( 'button', { name: 'Collapse 2 variations' } );
		expect( button ).toHaveAttribute( 'aria-expanded', 'true' );
		expect( button ).toHaveClass( 'is-loading' );
		expect( screen.getByRole( 'status' ) ).toHaveTextContent( 'Loading variations…' );

		await waitFor( () => expect( screen.getAllByTestId( 'row' ) ).toHaveLength( 3 ) );
		expect( button ).not.toHaveClass( 'is-loading' );
		expect( button ).toHaveAttribute( 'aria-controls', 'wc-pl-row-1001 wc-pl-row-1002' );

		const child = screen.getAllByTestId( 'row' )[ 1 ]!.querySelector( '.wc-pl-name' )!;
		expect( child ).toHaveAttribute( 'id', 'wc-pl-row-1001' );
		expect( child ).toHaveClass( 'wc-pl-name--level-1' );
		expect( child.querySelector( '.screen-reader-text' ) ).toHaveTextContent( '(variation of P1)' );
		expect( ( child as HTMLElement ).style.getPropertyValue( '--wc-pl-level' ) ).toBe( '1' );
		expect( child.querySelector( 'a' ) ).toHaveTextContent( '1' );

		fireEvent.click( button );
		expect( screen.getAllByTestId( 'row' ) ).toHaveLength( 1 );
		expect( rowClicks ).toEqual( [] );
	} );

	it( 'supports arrow keys and shows the retry button on error', async () => {
		const fail = new Set( [ 1 ] );
		const { fetch } = fakeFetch( { 1: 2 }, { fail } );
		render( <Harness parents={ [ parent( 1 ) ] } fetch={ fetch } /> );

		const button = screen.getByRole( 'button', { name: 'Expand 2 variations' } );
		fireEvent.keyDown( button, { key: 'ArrowRight' } );
		expect( button ).toHaveAttribute( 'aria-expanded', 'true' );

		await waitFor( () => expect( screen.getByRole( 'alert' ) ).toHaveTextContent( 'Boom 1' ) );
		fail.clear();
		fireEvent.click( screen.getByRole( 'button', { name: 'Retry' } ) );
		await waitFor( () => expect( screen.getAllByTestId( 'row' ) ).toHaveLength( 3 ) );

		fireEvent.keyDown( button, { key: 'ArrowLeft' } );
		expect( button ).toHaveAttribute( 'aria-expanded', 'false' );
		expect( screen.getAllByTestId( 'row' ) ).toHaveLength( 1 );
	} );

	it( 'expand all / collapse all from the toolbar', async () => {
		const { fetch } = fakeFetch( { 1: 1, 2: 1 } );
		render( <Harness parents={ [ parent( 1, 1 ), parent( 2, 1 ), parent( 3, 0 ) ] } fetch={ fetch } /> );

		fireEvent.click( screen.getByText( 'Expand all' ) );
		await waitFor( () => expect( screen.getAllByTestId( 'row' ) ).toHaveLength( 5 ) );
		fireEvent.click( screen.getByText( 'Collapse all' ) );
		expect( screen.getAllByTestId( 'row' ) ).toHaveLength( 3 );
	} );

	it( 'renders plainly outside the hierarchy contexts', () => {
		render( <NameCell item={ parent( 1 ) } /> );

		expect( screen.getByText( 'P1' ) ).toBeInTheDocument();
		expect( screen.queryByRole( 'button' ) ).toBeNull();
	} );
} );

describe( 'HierarchicalDataViews', () => {
	it( 'renders the flattened rows in a table with chevrons and strips placeholder ids from the selection', async () => {
		const { fetch } = fakeFetch( { 1: 2 }, { delay: 20 } );
		const onChangeSelection = vi.fn();

		function Screen() {
			const parents = [ parent( 1 ), parent( 2, 0 ) ];
			const hierarchy = useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } );
			const view: View = { type: 'table', fields: [ 'price' ], titleField: 'name', perPage: 20, page: 1 };

			return (
				<HierarchyProvider value={ hierarchy }>
					<HierarchicalDataViews
						data={ hierarchy.rows }
						fields={ [
							{ id: 'name', label: 'Name', render: ( { item } ) => <NameCell item={ item }>{ item.name }</NameCell> },
							{ id: 'price', label: 'Price' },
						] }
						view={ view }
						onChangeView={ () => {} }
						getItemId={ getItemId }
						paginationInfo={ { totalItems: 2, totalPages: 1 } }
						defaultLayouts={ { table: {} } }
						actions={ [ { id: 'x', label: 'X', supportsBulk: true, callback: () => {}, isEligible: ( item ) => ! item._placeholder } ] }
						selection={ [ '1', '1:loading' ] }
						onChangeSelection={ onChangeSelection }
						getItemParentId={ hierarchy.getItemParentId }
						getItemHasChildren={ hierarchy.getItemHasChildren }
						expandedItemIds={ hierarchy.expandedItemIds }
						onChangeExpandedItemIds={ hierarchy.onChangeExpandedItemIds }
						childrenState={ hierarchy.childrenState }
						onRetryChildren={ hierarchy.retry }
					/>
				</HierarchyProvider>
			);
		}

		render( <Screen /> );

		expect( screen.getAllByRole( 'row' ) ).toHaveLength( 3 );
		fireEvent.click( screen.getByRole( 'button', { name: 'Expand 2 variations' } ) );
		expect( screen.getAllByRole( 'row' ) ).toHaveLength( 4 );

		// Select all while the placeholder row is showing: its id must not leak.
		const [ selectAll ] = screen.getAllByRole( 'checkbox' );
		fireEvent.click( selectAll! );
		expect( onChangeSelection ).toHaveBeenCalled();
		for ( const call of onChangeSelection.mock.calls ) {
			expect( call[ 0 ].every( ( id: string ) => ! id.includes( ':' ) ) ).toBe( true );
		}

		await waitFor( () => expect( screen.getAllByRole( 'row' ) ).toHaveLength( 5 ) );
		expect( screen.getByText( '1', { selector: '.wc-pl-name__content' } ) ).toBeInTheDocument();
	} );
} );

describe( 'expandAll progressive commits', () => {
	it( 'publishes the loaded rows in bounded commits while the loads run, not once at the end', async () => {
		const counts: Record< number, number > = {};
		const parents: ProductRow[] = [];

		// 20 x 50 rows: above EXPAND_ALL_WARN_ROWS (answered), well under EXPAND_ALL_MAX_ROWS;
		// MAX_CONCURRENT_REQUESTS slots make the loads arrive in waves.
		for ( let id = 1; id <= 20; id++ ) {
			counts[ id ] = 50;
			parents.push( parent( id, 50 ) );
		}

		const { fetch } = fakeFetch( counts, { delay: 30 } );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null, confirmExpandAll: () => true } ) );
		const loadedAtEmit: number[] = [];
		const unsubscribe = subscribeChildren( () => loadedAtEmit.push( Array.from( getChildrenState().values() ).filter( ( state ) => state.status === 'loaded' ).length ) );

		await act( async () => {
			await result.current.expandAll();
		} );
		unsubscribe();

		expect( result.current.rows ).toHaveLength( 20 + 1000 );
		// About one commit per BULK_PUBLISH_ROWS rows: several, never one per parent.
		expect( loadedAtEmit.length ).toBeGreaterThanOrEqual( 3 );
		expect( loadedAtEmit.length ).toBeLessThanOrEqual( 10 );
		// The first commit came while parents were still loading; each later one had more.
		expect( loadedAtEmit[ 0 ] ).toBeGreaterThan( 0 );
		expect( loadedAtEmit[ 0 ] ).toBeLessThan( 20 );
		expect( loadedAtEmit.at( -1 ) ).toBe( 20 );
		expect( [ ...loadedAtEmit ].sort( ( a, b ) => a - b ) ).toEqual( loadedAtEmit );
		expect( Math.ceil( 1000 / BULK_PUBLISH_ROWS ) ).toBeGreaterThanOrEqual( loadedAtEmit.length - 1 );
	} );
} );

describe( 'a refetch keeps the loaded variations on screen', () => {
	it( 'invalidation (a column added, an action on another row) keeps every variation row until the new rows arrive', async () => {
		const { fetch } = fakeFetch( { 1: 250 }, { delay: 20 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1, 250 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );
		expect( result.current.rows.some( ( row ) => row.id === 1250 ) ).toBe( true );

		// Every snapshot while it refetches still holds the last variation (on page 3 of the refetch).
		const seen: boolean[] = [];
		const unsubscribe = subscribeChildren( () => {
			seen.push( ( getChildrenState().get( 1 )?.items ?? [] ).some( ( row ) => row.id === 1250 ) );
		} );

		act( () => invalidateVariations() );
		expect( getChildrenState().get( 1 )?.status ).not.toBe( 'loaded' );
		expect( result.current.rows.some( ( row ) => row.id === 1250 ) ).toBe( true );

		await waitFor( () => expect( getChildrenState().get( 1 )?.status ).toBe( 'loaded' ) );
		unsubscribe();

		expect( seen.length ).toBeGreaterThan( 0 );
		expect( seen.every( Boolean ) ).toBe( true );
	} );

	it( 'a collapse while refetching keeps the stale rows for the next expand', async () => {
		const { fetch } = fakeFetch( { 1: 2 }, { delay: 20 } );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );
		act( () => invalidateVariations( [ 1 ] ) );
		act( () => result.current.collapse( 1 ) );

		await waitFor( () => expect( loadingParentIds() ).toEqual( [] ) );
		expect( getChildrenState().get( 1 )?.items.map( ( row ) => row.id ) ).toEqual( [ 1001, 1002 ] );
	} );
} );
