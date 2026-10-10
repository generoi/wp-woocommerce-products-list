/**
 * The editor session the screen owns (edit/editor-session.ts): which row a
 * quick edit targets, which view changes swap the rows under the panel,
 * where focus returns, and how the panel is named.
 */
import { describe, expect, it } from 'vitest';
import { editorRegionLabel } from '../../resources/edit/editor-context';
import { findEditedRow, viewChangesRows } from '../../resources/edit/editor-session';
import { isActionableRow, withoutPlaceholderIds } from '../../resources/hierarchy/hierarchical-dataviews';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { focusOriginForRow } from '../../resources/list/products-screen';
import { getCurrentRows, resetCurrentRows, setCurrentRows } from '../../resources/store/rows';
import type { ProductListItem } from '../../resources/types';
import { placeholder, simple, variation } from './edit-fixtures';

const rows: ProductListItem[] = [ simple( 1 ), simple( 5, { type: 'variable', _hasChildren: true } ), variation( 11, 5 ), placeholder( 5 ), simple( 2 ) ];

describe( 'findEditedRow', () => {
	it( 'finds the edited row only when it is on screen, never a placeholder', () => {
		expect( findEditedRow( rows, 999 ) ).toBeUndefined();
		// A placeholder row shares the parent's (negated) id space: never a target.
		expect( findEditedRow( rows, -5 ) ).toBeUndefined();
		expect( findEditedRow( rows, 5 ) ).toBe( rows[ 1 ] );
		expect( findEditedRow( rows, 11 ) ).toBe( rows[ 2 ] );
	} );

	it( 'keeps placeholders out of the selection, the actions and getItems()', () => {
		expect( withoutPlaceholderIds( [ '1', '5:loading', '2' ] ) ).toEqual( [ '1', '2' ] );
		expect( isActionableRow( rows[ 3 ]! ) ).toBe( false );
		expect( isActionableRow( rows[ 0 ]! ) ).toBe( true );

		setCurrentRows( rows );
		expect( getCurrentRows().map( ( row ) => row.id ) ).toEqual( [ 1, 5, 11, 2 ] );
		resetCurrentRows();
	} );
} );

describe( 'viewChangesRows', () => {
	const base = { page: 1, perPage: 20, search: '', sort: { field: 'name', direction: 'asc' }, filters: [] };

	it( 'is true for page, page size, search, sort and filters; false for columns, density and the layout', () => {
		expect( viewChangesRows( base, { ...base, page: 2 } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, perPage: 50 } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, search: 'boot' } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, sort: { field: 'sku', direction: 'asc' } } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, sort: { field: 'name', direction: 'desc' } } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, filters: [ { field: 'status', value: 'draft' } ] } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, fields: [ 'sku' ], layout: { density: 'compact' } } as typeof base ) ).toBe( false );
		expect( viewChangesRows( { ...base, search: undefined }, { ...base, search: '' } ) ).toBe( false );
		// The panel sits beside any layout: switching to Grid or List keeps it open.
		expect( viewChangesRows( { ...base, type: 'table' }, { ...base, type: 'grid' } ) ).toBe( false );
		expect( viewChangesRows( { ...base, type: 'table' }, { ...base, type: 'list' } ) ).toBe( false );
	} );
} );

describe( 'editorRegionLabel', () => {
	it( 'labels a quick edit with the row\'s name and a bulk edit with its count', () => {
		const row = normalizeProduct( { id: 3, name: 'Blue boots' } );

		expect( editorRegionLabel( { session: { mode: 'quick', id: 3, origin: null }, items: [ row ] } ) ).toBe( 'Quick edit: Blue boots' );
		expect( editorRegionLabel( { session: { mode: 'bulk', origin: null }, items: [ row ] } ) ).toBe( 'Bulk edit: 1 item' );
	} );

	it( 'reads a stored title with entities as the heading shows it ("&", not "&amp;")', () => {
		const row = normalizeProduct( { id: 4, name: 'QA Tom &amp; Jerry' } );

		expect( editorRegionLabel( { session: { mode: 'quick', id: 4, origin: null }, items: [ row ] } ) ).toBe( 'Quick edit: QA Tom & Jerry' );
	} );
} );

describe( 'focusOriginForRow', () => {
	it( 'remembers the row\'s position in the table body, so focus can return to its actions button', () => {
		document.body.innerHTML = '<table class="dataviews-view-table"><tbody><tr><td><div id="wc-pl-row-1"></div></td></tr><tr><td><div id="wc-pl-row-7"></div><button>Actions</button></td></tr></tbody></table>';

		expect( focusOriginForRow( simple( 7 ) ) ).toMatchObject( { rowIndex: 1, label: null } );
		expect( focusOriginForRow( simple( 99 ) ).rowIndex ).toBeNull();
		document.body.innerHTML = '';
	} );
} );
