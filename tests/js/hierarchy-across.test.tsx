/**
 * Several parents' variations in one request (`wc-products-list/v1/variations?parent=…`):
 * expand all, a restored expansion, "Select all variations" and variationIdsOf.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BULK_PUBLISH_ROWS,
	EXPANDED_STORAGE_KEY,
	EXPAND_ALL_MAX_ROWS,
	findLoadedVariation,
	getChildrenState,
	isNoopPatch,
	nextExpansion,
	patchVariationRows,
	resetHierarchyStore,
	subscribeChildren,
	useHierarchy,
} from '../../resources/hierarchy/use-hierarchy';
import type { FetchVariations, FetchVariationsAcross, VariationsResult } from '../../resources/hierarchy/use-hierarchy';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { setSettings } from '../../resources/settings';
import { getItemId } from '../../resources/types';
import type { ProductField, ProductRow, RawVariation, Settings } from '../../resources/types';

vi.mock( '../../resources/api/client', () => ( { getVariations: vi.fn(), getVariationsAcross: vi.fn() } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), remove: vi.fn() } } ) );

function parent( id: number, count = 2 ): ProductRow {
	return normalizeProduct( {
		id,
		type: count > 0 ? 'variable' : 'simple',
		name: `P${ id }`,
		wc_products_list: { variation_count: count, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 },
	} );
}

function rawVariation( parentId: number, n: number ): RawVariation {
	return { id: parentId * 1000 + n, parent_id: parentId, sku: `S${ n }`, status: 'publish', attributes: [ { id: 1, name: 'Size', option: String( n ) } ] } as RawVariation;
}

const wait = ( ms: number, signal?: AbortSignal ) =>
	new Promise< void >( ( resolve, reject ) => {
		const timer = setTimeout( resolve, ms );
		signal?.addEventListener( 'abort', () => {
			clearTimeout( timer );
			reject( Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ) );
		} );
	} );

/** The cross-parent route: every variation of the parents, parent by parent, paged across them. */
function fakeAcross( counts: Record< number, number >, options: { delay?: ( page: number ) => number; unsupported?: boolean } = {} ) {
	const calls: Array< { parentIds: number[]; page: number; fields: string[]; signal?: AbortSignal } > = [];
	const fetch: FetchVariationsAcross = async ( parentIds, page, { perPage, fields, signal } ) => {
		calls.push( { parentIds, page, fields, signal } );
		await wait( options.delay?.( page ) ?? 5, signal );

		if ( options.unsupported ) {
			return null;
		}

		const all = parentIds.flatMap( ( id ) => Array.from( { length: counts[ id ] ?? 0 }, ( _, i ) => rawVariation( id, i + 1 ) ) );
		const items = all.slice( ( page - 1 ) * perPage, page * perPage );
		const result: VariationsResult = { items, total: all.length, totalPages: Math.max( 1, Math.ceil( all.length / perPage ) ) };

		return result;
	};

	return { fetch, calls };
}

function fakeSingle( counts: Record< number, number > ) {
	const calls: number[] = [];
	const fetch: FetchVariations = async ( parentId, page, { perPage, signal } ) => {
		calls.push( parentId );
		await wait( 5, signal );
		const total = counts[ parentId ] ?? 0;
		const items = Array.from( { length: Math.max( 0, Math.min( perPage, total - ( page - 1 ) * perPage ) ) }, ( _, i ) => rawVariation( parentId, ( page - 1 ) * perPage + i + 1 ) );

		return { items, total, totalPages: Math.max( 1, Math.ceil( total / perPage ) ) };
	};

	return { fetch, calls };
}

const fields: ProductField[] = [ { id: 'name', label: 'Name', rest: { fields: [ 'name' ], applies: { product: true, variation: true } }, productTypes: 'all', edit: false } ];

function page( count: number, variations: number ): { parents: ProductRow[]; counts: Record< number, number > } {
	const parents: ProductRow[] = [];
	const counts: Record< number, number > = {};

	for ( let id = 1; id <= count; id++ ) {
		parents.push( parent( id, variations ) );
		counts[ id ] = variations;
	}

	return { parents, counts };
}

beforeEach( () => {
	resetHierarchyStore();
	setSettings( { limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 50, actionBatchSize: 100 } } as unknown as Settings );
} );

afterEach( () => {
	setSettings( undefined );
	window.sessionStorage.clear();
} );

describe( 'variations across parents', () => {
	it( 'expand all reads 10 parents with 40 variations each in 4 requests, not 10, each parent in its own order', async () => {
		const { parents, counts } = page( 10, 40 );
		const across = fakeAcross( counts );
		const single = fakeSingle( counts );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: single.fetch, fetchVariationsAcross: across.fetch, storage: null, confirmExpandAll: () => true } ) );

		await act( async () => {
			await result.current.expandAll();
		} );

		expect( single.calls ).toEqual( [] );
		expect( across.calls.map( ( call ) => call.page ) ).toEqual( [ 1, 2, 3, 4 ] );
		expect( across.calls[ 0 ]!.parentIds ).toEqual( parents.map( ( item ) => item.id ) );
		expect( across.calls[ 0 ]!.fields ).toContain( 'parent_id' );
		expect( result.current.rows ).toHaveLength( 410 );

		for ( const item of parents ) {
			const state = result.current.childrenOf( item.id );
			expect( state?.status ).toBe( 'loaded' );
			expect( state?.items.map( ( row ) => row.id ) ).toEqual( Array.from( { length: 40 }, ( _, i ) => item.id * 1000 + i + 1 ) );
			expect( state?.items.every( ( row ) => row._parentId === item.id ) ).toBe( true );
		}
	} );

	it( 'publishes parents as their rows complete, in slices of about BULK_PUBLISH_ROWS rows, also when pages arrive out of order', async () => {
		const { parents, counts } = page( 10, 40 );
		// Page 1 last: nothing can be published before it is in.
		const across = fakeAcross( counts, { delay: ( n ) => ( n === 1 ? 5 : 40 - n * 5 ) } );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fakeSingle( counts ).fetch, fetchVariationsAcross: across.fetch, storage: null, confirmExpandAll: () => true } ) );
		const loadedAtEmit: number[] = [];
		const unsubscribe = subscribeChildren( () => loadedAtEmit.push( Array.from( getChildrenState().values() ).filter( ( state ) => state.status === 'loaded' ).length ) );

		await act( async () => {
			await result.current.expandAll();
		} );
		unsubscribe();

		const commits = loadedAtEmit.filter( ( count, index ) => count > ( loadedAtEmit[ index - 1 ] ?? 0 ) );
		expect( commits.length ).toBeGreaterThanOrEqual( Math.floor( 400 / ( BULK_PUBLISH_ROWS + 40 ) ) );
		expect( loadedAtEmit.at( -1 ) ).toBe( 10 );
		expect( result.current.rows ).toHaveLength( 410 );
	} );

	it( 'falls back to one request per parent when the server has no cross-parent route', async () => {
		const { parents, counts } = page( 4, 3 );
		const across = fakeAcross( counts, { unsupported: true } );
		const single = fakeSingle( counts );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: single.fetch, fetchVariationsAcross: across.fetch, storage: null, confirmExpandAll: () => true } ) );

		await act( async () => {
			await result.current.expandAll();
		} );

		expect( across.calls ).toHaveLength( 1 );
		expect( [ ...single.calls ].sort() ).toEqual( [ 1, 2, 3, 4 ] );
		expect( result.current.rows ).toHaveLength( 16 );
	} );

	it( 'collapsing one parent mid-load drops its rows only; collapsing them all aborts the request', async () => {
		const { parents, counts } = page( 3, 5 );
		const across = fakeAcross( counts, { delay: () => 30 } );
		const { result, unmount } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fakeSingle( counts ).fetch, fetchVariationsAcross: across.fetch, storage: null, confirmExpandAll: () => true } ) );

		let done: Promise< boolean > | undefined;
		act( () => {
			done = result.current.expandAll();
		} );
		await waitFor( () => expect( across.calls ).toHaveLength( 1 ) );
		act( () => result.current.collapse( 2 ) );
		expect( across.calls[ 0 ]!.signal?.aborted ).toBe( false );

		await act( async () => {
			await done;
		} );

		expect( result.current.childrenOf( 1 )?.status ).toBe( 'loaded' );
		expect( result.current.childrenOf( 3 )?.status ).toBe( 'loaded' );
		expect( result.current.childrenOf( 2 )?.status ).toBe( 'idle' );
		expect( result.current.rows.filter( ( row ) => row._parentId === 2 ) ).toHaveLength( 0 );

		// All of them: the shared request stops.
		unmount();
		resetHierarchyStore();
		const again = fakeAcross( counts, { delay: () => 30 } );
		const second = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fakeSingle( counts ).fetch, fetchVariationsAcross: again.fetch, storage: null, confirmExpandAll: () => true } ) );
		act( () => {
			void second.result.current.expandAll();
		} );
		await waitFor( () => expect( again.calls ).toHaveLength( 1 ) );
		act( () => second.result.current.collapseAll() );
		expect( again.calls[ 0 ]!.signal?.aborted ).toBe( true );
	} );

	it( 'a restored expansion of several parents is one request', async () => {
		const { parents, counts } = page( 5, 4 );
		const storage = { getItem: ( key: string ) => ( key === EXPANDED_STORAGE_KEY ? JSON.stringify( [ 1, 2, 3 ] ) : null ), setItem: () => {} };
		const across = fakeAcross( counts );
		const single = fakeSingle( counts );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: single.fetch, fetchVariationsAcross: across.fetch, storage } ) );

		await waitFor( () => expect( result.current.rows ).toHaveLength( 5 + 12 ) );
		expect( across.calls ).toHaveLength( 1 );
		expect( across.calls[ 0 ]!.parentIds ).toEqual( [ 1, 2, 3 ] );
		expect( single.calls ).toEqual( [] );
	} );

	it( 'variationIdsOf reads the ids of many parents across parents', async () => {
		const { parents, counts } = page( 3, 2 );
		const across = fakeAcross( counts );
		const single = fakeSingle( counts );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: single.fetch, fetchVariationsAcross: across.fetch, storage: null } ) );

		let ids: number[] = [];
		await act( async () => {
			ids = await result.current.variationIdsOf( [ 1, 2, 3 ] );
		} );

		expect( ids ).toEqual( [ 1001, 1002, 2001, 2002, 3001, 3002 ] );
		expect( across.calls ).toHaveLength( 1 );
		expect( across.calls[ 0 ]!.fields ).toEqual( [ 'id', 'parent_id' ] );
		expect( single.calls ).toEqual( [] );
	} );
} );

describe( 'select all variations stays under the row limit', () => {
	it( 'expands only the parents that fit and selects the variations of the others collapsed', async () => {
		const { parents, counts } = page( 20, 50 );
		const across = fakeAcross( counts );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fakeSingle( counts ).fetch, fetchVariationsAcross: across.fetch, storage: null } ) );

		let ids: string[] = [];
		await act( async () => {
			ids = await result.current.selectVariations( parents.map( ( item ) => item.id ) );
		} );

		// Every variation is selected…
		expect( ids ).toHaveLength( 1000 );
		// …but the page stays under the limit: 20 parents + 11 × 50 rows.
		expect( result.current.rows.length ).toBeLessThanOrEqual( EXPAND_ALL_MAX_ROWS );
		expect( result.current.expandedItemIds ).toHaveLength( 11 );
		// A collapsed parent's variation is still known to the selection.
		expect( findLoadedVariation( '20050' )?._parentId ).toBe( 20 );
		expect( across.calls.length ).toBeLessThanOrEqual( 10 );
	} );
} );

describe( 'expand next', () => {
	it( 'plans the next products after the last expanded one, on top when they fit, else instead', () => {
		const { parents } = page( 10, 100 );
		const none = new Map();

		// 3 open (310 rows): 2 more fit on top.
		expect( nextExpansion( parents, [ 1, 2, 3 ], none, 1000, 310 ).fit.map( ( item ) => item.id ) ).toEqual( [ 4, 5 ] );
		expect( nextExpansion( parents, [ 1, 2, 3 ], none, 1000, 310 ).replaces ).toBe( 0 );
		// 5 open (510 rows): none fits on top; the next 5 instead of them.
		const plan = nextExpansion( parents, [ 1, 2, 3, 4, 5 ], none, 1000, 510 );
		expect( plan.fit.map( ( item ) => item.id ) ).toEqual( [ 6, 7, 8, 9, 10 ] );
		expect( plan.replaces ).toBe( 5 );
	} );

	it( 'expandNext swaps in the products expand all left collapsed', async () => {
		const { parents, counts } = page( 10, 100 );
		const across = fakeAcross( counts );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fakeSingle( counts ).fetch, fetchVariationsAcross: across.fetch, storage: null, confirmExpandAll: () => true, onExpandAllLimit: () => {} } ) );

		await act( async () => {
			await result.current.expandAll();
		} );
		expect( result.current.expandedItemIds ).toEqual( [ 1, 2, 3, 4, 5 ] );
		expect( result.current.nextExpand ).toEqual( { count: 5, replaces: 5 } );

		await act( async () => {
			await result.current.expandNext?.();
		} );
		expect( result.current.expandedItemIds ).toEqual( [ 6, 7, 8, 9, 10 ] );
		expect( result.current.rows ).toHaveLength( 510 );
		// Every product has been opened once: the next round starts over from the top.
		expect( result.current.nextExpand ).toEqual( { count: 5, replaces: 5 } );
	} );
} );

describe( 'patches', () => {
	it( 'a patch that changes nothing keeps the row object (no re-render after a save hands the rows over twice)', async () => {
		const { parents, counts } = page( 1, 2 );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fakeSingle( counts ).fetch, fetchVariationsAcross: null, storage: null } ) );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		act( () => patchVariationRows( [ { id: 1001, sku: 'NEW' } ] ) );
		const patched = result.current.childrenOf( 1 )!.items[ 0 ]!;
		expect( patched.sku ).toBe( 'NEW' );
		expect( isNoopPatch( patched, { id: 1001, sku: 'NEW' } ) ).toBe( true );

		const emits: number[] = [];
		const unsubscribe = subscribeChildren( () => emits.push( 1 ) );
		act( () => patchVariationRows( [ { id: 1001, sku: 'NEW' } ] ) );
		unsubscribe();

		expect( emits ).toEqual( [] );
		expect( result.current.childrenOf( 1 )!.items[ 0 ] ).toBe( patched );
		expect( getItemId( patched ) ).toBe( '1001' );
	} );
} );
