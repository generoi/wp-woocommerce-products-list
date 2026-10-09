import { act, renderHook } from '@testing-library/react';
import { doAction } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS } from '../../resources/extensions/hooks';
import { normalizeProduct, normalizeVariation } from '../../resources/hierarchy/normalize';
import { knownRowIds, MAX_SELECT_ALL, SELECT_ALL_FIELDS, selectRows, useSelection } from '../../resources/list/selection';
import type { FetchPage } from '../../resources/list/selection';
import { setSettings } from '../../resources/settings';
import { removeItems } from '../../resources/store/products';
import type { ProductListItem } from '../../resources/types';
import { sampleSettings } from './settings.test';

vi.mock( '../../resources/api/client', () => ( { listProducts: vi.fn() } ) );

function product( id: number ): ProductListItem {
	return normalizeProduct( { id, type: 'simple', name: `P${ id }` } );
}

function variation( id: number, parentId: number ): ProductListItem {
	return normalizeVariation( { id }, parentId );
}

const page1 = [ product( 1 ), product( 2 ), variation( 2001, 2 ), product( 3 ) ];
const page2 = [ product( 4 ), product( 5 ) ];

function ids( rows: ProductListItem[] ): number[] {
	return rows.map( ( row ) => row.id );
}

describe( 'useSelection', () => {
	beforeEach( () => setSettings( sampleSettings() ) );
	afterEach( () => setSettings( undefined ) );

	it( 'keeps rows selected on another page when DataViews changes the page part', () => {
		const { result, rerender } = renderHook( ( { rows, tab } ) => useSelection( rows, tab ), { initialProps: { rows: page1, tab: 'all' } } );

		act( () => result.current.onPageSelectionChange( [ '1', '2001' ] ) );
		expect( result.current.selection ).toEqual( [ '1', '2001' ] );
		expect( result.current.offPageCount ).toBe( 0 );

		// Next page: the selection stays, nothing of it is on the page.
		rerender( { rows: page2, tab: 'all' } );
		expect( result.current.selection ).toEqual( [ '1', '2001' ] );
		expect( result.current.offPageCount ).toBe( 2 );
		expect( ids( result.current.rows ) ).toEqual( [ 1, 2001 ] );

		// The header checkbox selects this page; the other page's rows survive it.
		act( () => result.current.onPageSelectionChange( [ '4', '5' ] ) );
		expect( result.current.selection ).toEqual( [ '4', '5', '1', '2001' ] );

		// "Deselect all" on this page leaves the others alone too.
		act( () => result.current.onPageSelectionChange( [] ) );
		expect( result.current.selection ).toEqual( [ '1', '2001' ] );

		// Back on page 1 the rows come in page order and are the page's fresh objects.
		const fresh = page1.map( ( row ) => ( { ...row, name: `${ row.name }!` } ) );
		rerender( { rows: fresh, tab: 'all' } );
		expect( result.current.selection ).toEqual( [ '1', '2001' ] );
		expect( result.current.rows[ 0 ] ).toBe( fresh[ 0 ] );
		expect( result.current.offPageCount ).toBe( 0 );
	} );

	it( 'set replaces the whole selection, dropping ids it cannot find a row for', () => {
		const { result, rerender } = renderHook( ( { rows } ) => useSelection( rows, 'all' ), { initialProps: { rows: page1 } } );

		act( () => result.current.onPageSelectionChange( [ '1', '2' ] ) );
		rerender( { rows: page2 } );
		act( () => result.current.onPageSelectionChange( [ '4' ] ) );
		expect( result.current.selection ).toEqual( [ '4', '1', '2' ] );

		// An action dropping the rows it processed: 1 and 4 are done, 2 failed and stays; 99 is unknown.
		act( () => result.current.set( [ '2', '99' ] ) );
		expect( result.current.selection ).toEqual( [ '2' ] );

		act( () => result.current.clear() );
		expect( result.current.selection ).toEqual( [] );
	} );

	it( 'set keeps ids of rows the page does not show but the lookup knows (variations of a collapsed parent)', () => {
		const hidden = variation( 3001, 3 );
		const lookupRow = ( id: string ) => ( id === '3001' ? hidden : undefined );
		const { result } = renderHook( () => useSelection( page1, 'all', { lookupRow } ) );

		act( () => result.current.set( [ '1', '3001', '404' ] ) );

		expect( result.current.selection ).toEqual( [ '1', '3001' ] );
		expect( result.current.rows ).toContain( hidden );
		expect( result.current.offPageCount ).toBe( 1 );
	} );

	it( 'survives a bulk save, so edits chain on the same set, and drops rows a save found gone', () => {
		const { result } = renderHook( ( { rows, tab } ) => useSelection( rows, tab ), { initialProps: { rows: page1, tab: 'all' } } );

		act( () => result.current.onPageSelectionChange( [ '1', '2', '3' ] ) );
		act( () => {
			doAction( ACTIONS.saved, { updated: [ { id: 2001 }, { id: 1 } ], errors: [], batchId: 'b' }, { source: 'bulk' } );
		} );
		expect( result.current.selection ).toEqual( [ '1', '2', '3' ] );

		act( () => {
			doAction( ACTIONS.saved, { updated: [ { id: 1 } ], errors: [ { id: 2, message: 'gone', code: 'woocommerce_rest_product_invalid_id' }, { id: 3, message: 'x', code: 'rest_invalid_param' } ], batchId: 'b' }, { source: 'bulk' } );
		} );
		// 1 saved and stays, 2 deleted elsewhere leaves, 3 failed and stays for the retry.
		expect( result.current.selection ).toEqual( [ '1', '3' ] );
	} );

	it( 'selectRows narrows the mounted selection from outside ("Select the skipped")', () => {
		const { result, unmount } = renderHook( () => useSelection( page1, 'all' ) );

		act( () => result.current.onPageSelectionChange( [ '1', '2', '3' ] ) );
		act( () => {
			expect( selectRows( [ 2, 3 ] ) ).toBe( true );
		} );
		expect( result.current.selection ).toEqual( [ '2', '3' ] );

		unmount();
		expect( selectRows( [ 1 ] ) ).toBe( false );
	} );

	it( 'selectRows leaves the selection alone when the list shows none of the ids (they are on another tab, or in the Trash)', () => {
		const { result } = renderHook( () => useSelection( page1, 'all' ) );

		act( () => result.current.onPageSelectionChange( [ '1', '2' ] ) );
		act( () => {
			expect( selectRows( [ 9001 ] ) ).toBe( false );
		} );
		expect( result.current.selection ).toEqual( [ '1', '2' ] );
		expect( knownRowIds( [ 3, 9001 ] ) ).toEqual( [ 3 ] );

		// Some known: only those are selected.
		act( () => {
			expect( selectRows( [ 3, 9001 ] ) ).toBe( true );
		} );
		expect( result.current.selection ).toEqual( [ '3' ] );
	} );

	it( 'addRows keeps rows that are not on the page yet', () => {
		const { result } = renderHook( () => useSelection( page1, 'all' ) );
		const variation = normalizeVariation( { id: 501, name: 'Black' }, 1 );

		act( () => result.current.onPageSelectionChange( [ '1' ] ) );
		act( () => result.current.addRows( [ variation, page1[ 0 ]! ] ) );
		expect( result.current.selection ).toEqual( [ '1', '501' ] );
		expect( result.current.offPageCount ).toBe( 1 );
		expect( result.current.rows[ 1 ] ).toBe( variation );
	} );

	it( 'clears on a status tab change, and drops deleted rows', () => {
		const { result, rerender } = renderHook( ( { rows, tab } ) => useSelection( rows, tab ), { initialProps: { rows: page1, tab: 'all' } } );

		act( () => result.current.onPageSelectionChange( [ '1', '2', '3' ] ) );
		act( () => {
			doAction( ACTIONS.saved, { updated: [ { id: 1 } ], errors: [ { id: 2, message: 'x' } ], batchId: 'b' }, { source: 'quick' } );
		} );
		expect( result.current.selection ).toEqual( [ '1', '2', '3' ] );

		act( () => {
			doAction( ACTIONS.deleted, [ 3 ], { action: 'trash', batchId: 'b' } );
		} );
		expect( result.current.selection ).toEqual( [ '1', '2' ] );

		rerender( { rows: page1, tab: 'trash' } );
		expect( result.current.selection ).toEqual( [] );
	} );

	it( 'drops rows the list removed for any reason, on the page or elsewhere', () => {
		const { result, rerender } = renderHook( ( { rows, tab } ) => useSelection( rows, tab ), { initialProps: { rows: page1, tab: 'all' } } );

		act( () => result.current.onPageSelectionChange( [ '1', '3' ] ) );
		rerender( { rows: page2, tab: 'all' } );
		act( () => result.current.onPageSelectionChange( [ '4' ] ) );
		expect( result.current.offPageCount ).toBe( 2 );

		// An editor found 3 (on another page) trashed meanwhile and 4 deleted: it drops them from the list as it closes.
		act( () => removeItems( [ 3, 4 ] ) );
		expect( result.current.selection ).toEqual( [ '1' ] );
		expect( result.current.offPageCount ).toBe( 1 );
	} );

	it( 'selectAllMatching walks every page of the list query with trimmed fields and reports progress', async () => {
		const all = Array.from( { length: 250 }, ( _, i ) => product( i + 1 ) );
		const calls: Array< Record< string, unknown > > = [];
		const fetchPage: FetchPage = async ( query ) => {
			calls.push( query );
			const page = Number( query.page );
			const perPage = Number( query.per_page );
			const items = all.slice( ( page - 1 ) * perPage, page * perPage );

			return { items, total: all.length, totalPages: Math.ceil( all.length / perPage ) };
		};
		const { result } = renderHook( () => useSelection( page1, 'all', { fetchPage } ) );

		act( () => result.current.onPageSelectionChange( [ '2' ] ) );

		let count = 0;
		await act( async () => {
			count = await result.current.selectAllMatching( { tab: 'all', include_status: 'publish', per_page: 20, page: 3, _fields: 'id,name,price' }, 250 );
		} );

		expect( count ).toBe( 250 );
		expect( calls.map( ( c ) => c.page ) ).toEqual( [ 1, 2, 3 ] );
		expect( calls[ 0 ] ).toMatchObject( { tab: 'all', include_status: 'publish', per_page: 100, _fields: Array.from( new Set( SELECT_ALL_FIELDS ) ).sort().join( ',' ) } );
		expect( result.current.selection ).toHaveLength( 250 );
		expect( result.current.selectAllProgress ).toBeNull();
		expect( result.current.offPageCount ).toBe( 250 - 3 );
		// The page's rows are used for the ids on the page.
		expect( result.current.rows[ 0 ] ).toBe( page1[ 0 ] );
	} );

	it( 'selectAllMatching can be cancelled and refuses lists above the cap', async () => {
		let release: ( () => void ) | undefined;
		const signals: AbortSignal[] = [];
		const fetchPage: FetchPage = ( _query, { signal } ) => {
			signals.push( signal );

			return new Promise( ( resolve, reject ) => {
				release = () => resolve( { items: [ product( 1 ) ], total: 1, totalPages: 1 } );
				signal.addEventListener( 'abort', () => reject( Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ) ) );
			} );
		};
		const { result } = renderHook( () => useSelection( page1, 'all', { fetchPage, maxSelectAll: 10 } ) );

		let pending: Promise< number > | undefined;
		act( () => {
			pending = result.current.selectAllMatching( { page: 1 }, 5 );
		} );
		expect( result.current.selectAllProgress ).toEqual( { loaded: 0, total: 5 } );

		act( () => result.current.cancelSelectAll() );
		expect( signals[ 0 ]?.aborted ).toBe( true );
		expect( await pending ).toBe( 0 );
		expect( result.current.selectAllProgress ).toBeNull();
		expect( result.current.selection ).toEqual( [] );
		release?.();

		let count = -1;
		await act( async () => {
			count = await result.current.selectAllMatching( { page: 1 }, 11 );
		} );
		expect( count ).toBe( 0 );
		expect( result.current.selectAllError ).toMatch( /up to 10 products; this list has 11/ );
		expect( signals ).toHaveLength( 1 );
		expect( MAX_SELECT_ALL ).toBeGreaterThan( 1000 );
	} );
} );

describe( 'useSelection after a server action', () => {
	beforeEach( () => setSettings( sampleSettings() ) );
	afterEach( () => setSettings( undefined ) );

	it( 'keeps the rows a declarative action processed; those the refetch filtered out count as not in this view', () => {
		const { result, rerender } = renderHook( ( { rows } ) => useSelection( rows, 'all' ), { initialProps: { rows: page1 } } );

		act( () => result.current.onPageSelectionChange( [ '1', '2', '3' ] ) );
		act( () => {
			doAction( ACTIONS.actionPerformed, { action: 'i18n_copy', ids: [ 1, 2 ], batchId: 'b', items: [] } );
		} );
		expect( result.current.selection ).toEqual( [ '1', '2', '3' ] );

		rerender( { rows: [ product( 3 ) ] } );
		expect( result.current.offPageCount ).toBe( 2 );
	} );
} );
