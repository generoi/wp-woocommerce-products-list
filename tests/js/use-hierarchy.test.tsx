import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { doAction } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HierarchicalDataViews, HierarchyProvider, HierarchyViewProvider, NameCell, useHierarchyContext, withoutPlaceholderIds } from '../../resources/hierarchy';
import {
	EXPANDED_STORAGE_KEY,
	createLimiter,
	invalidateVariations,
	patchVariationRows,
	removeVariationRows,
	resetHierarchyStore,
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

/** A fake server: `counts[parentId]` variations, paginated like wc/v3. */
function fakeFetch( counts: Record< number, number >, options: { delay?: number; fail?: Set< number > } = {} ) {
	const calls: Array< { parentId: number; page: number; perPage: number; fields: string[] } > = [];
	let active = 0;
	let maxActive = 0;

	const fetch: FetchVariations = async ( parentId, page, { perPage, fields } ) => {
		calls.push( { parentId, page, perPage, fields } );
		active += 1;
		maxActive = Math.max( maxActive, active );

		try {
			await new Promise( ( resolve ) => setTimeout( resolve, options.delay ?? 0 ) );

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

	it( 'expands all variable products on the page with at most 4 requests in flight', async () => {
		const parents = Array.from( { length: 10 }, ( _, i ) => parent( i + 1, i === 4 ? 0 : 120 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls, maxActive } = fakeFetch( counts, { delay: 2 } );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null } ) );

		let ok: boolean | undefined;
		await act( async () => {
			ok = await result.current.expandAll();
		} );

		expect( ok ).toBe( true );
		expect( result.current.expandedItemIds ).toEqual( [ 1, 2, 3, 4, 6, 7, 8, 9, 10 ] );
		expect( calls ).toHaveLength( 9 * 2 );
		expect( maxActive() ).toBeLessThanOrEqual( 4 );
		expect( result.current.rows ).toHaveLength( 10 + 9 * 120 );

		act( () => result.current.collapseAll() );
		expect( result.current.expandedItemIds ).toEqual( [] );
		expect( result.current.rows ).toHaveLength( 10 );
	} );

	it( 'asks before expanding more than 2000 rows and respects the answer', async () => {
		const parents = Array.from( { length: 30 }, ( _, i ) => parent( i + 1, 100 ) );
		const counts = Object.fromEntries( parents.map( ( p ) => [ p.id, p._childCount ] ) );
		const { fetch, calls } = fakeFetch( counts );
		const confirm = vi.fn( async () => false );
		const { result } = renderHook( () => useHierarchy( parents, fields, { fetchVariations: fetch, storage: null, confirmExpandAll: confirm } ) );

		let ok: boolean | undefined;
		await act( async () => {
			ok = await result.current.expandAll();
		} );

		expect( ok ).toBe( false );
		expect( confirm ).toHaveBeenCalledWith( 30 + 3000 );
		expect( calls ).toHaveLength( 0 );
		expect( result.current.expandedItemIds ).toEqual( [] );

		confirm.mockResolvedValue( true );
		await act( async () => {
			ok = await result.current.expandAll();
		} );
		expect( ok ).toBe( true );
		expect( result.current.rows ).toHaveLength( 3030 );

		// force skips the question.
		act( () => result.current.collapseAll() );
		confirm.mockClear();
		await act( async () => {
			await result.current.expandAll( { force: true } );
		} );
		expect( confirm ).not.toHaveBeenCalled();
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

	it( 'onChangeExpandedItemIds dedupes and drops invalid ids', () => {
		const { fetch } = fakeFetch( {} );
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null } ) );

		act( () => result.current.onChangeExpandedItemIds( [ 3, 3, 0, -2, 1.5, 4 ] ) );
		expect( result.current.expandedItemIds ).toEqual( [ 3, 4 ] );
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
