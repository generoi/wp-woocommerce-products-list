import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { SelectionBar, selectionLabel } from '../../resources/list/selection-bar';
import type { SelectionApi } from '../../resources/list/selection';
import type { ProductAction, ProductListItem } from '../../resources/types';

function product( id: number ): ProductListItem {
	return normalizeProduct( { id, type: 'simple', name: `P${ id }` } );
}

function api( overrides: Partial< SelectionApi > = {} ): SelectionApi {
	return {
		selection: [],
		rows: [],
		offPageCount: 0,
		onPageSelectionChange: vi.fn(),
		set: vi.fn(),
		clear: vi.fn(),
		selectAllMatching: vi.fn( async () => 0 ),
		cancelSelectAll: vi.fn(),
		selectAllProgress: null,
		selectAllError: null,
		...overrides,
	};
}

const RenderModal = vi.fn( ( { items }: { items: ProductListItem[] } ) => <p data-testid="modal-items">{ items.map( ( item ) => item.id ).join( ',' ) }</p> );

const actions: ProductAction[] = [
	{ id: 'quick-edit', label: 'Quick edit', supportsBulk: true, RenderModal, modalHeader: ( items ) => `Edit ${ items.length } items`, modalSize: 'large' },
	{ id: 'trash', label: 'Trash', supportsBulk: true, callback: vi.fn() },
];

describe( 'selectionLabel', () => {
	it( 'counts the rows on other pages', () => {
		expect( selectionLabel( 1, 0 ) ).toBe( '1 selected' );
		expect( selectionLabel( 12, 1 ) ).toBe( '12 selected (1 on another page)' );
		expect( selectionLabel( 12, 4 ) ).toBe( '12 selected (4 on other pages)' );
	} );
} );

describe( 'SelectionBar', () => {
	it( 'renders nothing without a selection on a one-page list', () => {
		const { container } = render( <SelectionBar selection={ api() } total={ 3 } pageProducts={ 3 } query={ {} } actions={ actions } /> );

		expect( container ).toBeEmptyDOMElement();
	} );

	it( 'offers "Select all N" for a list longer than the page and runs it with the list query', () => {
		const selection = api( { selection: [ '1' ], rows: [ product( 1 ) ] } );
		const query = { tab: 'all', per_page: 20 };
		render( <SelectionBar selection={ selection } total={ 853 } pageProducts={ 100 } query={ query } actions={ actions } /> );

		fireEvent.click( screen.getByRole( 'button', { name: 'Select all 853 products' } ) );
		expect( selection.selectAllMatching ).toHaveBeenCalledWith( query, 853 );
	} );

	it( 'shows progress with a cancel, and the error', () => {
		const selection = api( { selectAllProgress: { loaded: 300, total: 853 } } );
		render( <SelectionBar selection={ selection } total={ 853 } pageProducts={ 100 } query={ {} } actions={ actions } /> );

		expect( screen.getByRole( 'status' ) ).toHaveTextContent( 'Selecting 300 of 853…' );
		expect( screen.queryByRole( 'button', { name: /Select all/ } ) ).toBeNull();
		fireEvent.click( screen.getByRole( 'button', { name: 'Cancel' } ) );
		expect( selection.cancelSelectAll ).toHaveBeenCalled();

		render( <SelectionBar selection={ api( { selectAllError: 'Too many.' } ) } total={ 3 } pageProducts={ 3 } query={ {} } actions={ actions } /> );
		expect( screen.getByRole( 'alert' ) ).toHaveTextContent( 'Too many.' );
	} );

	it( 'opens the quick-edit modal over every selected row, and clears', () => {
		const rows = [ product( 1 ), product( 7 ), product( 8 ) ];
		const selection = api( { selection: [ '1', '7', '8' ], rows, offPageCount: 2 } );
		render( <SelectionBar selection={ selection } total={ 3 } pageProducts={ 3 } query={ {} } actions={ actions } /> );

		expect( screen.getByText( '3 selected (2 on other pages)' ) ).toBeInTheDocument();
		fireEvent.click( screen.getByRole( 'button', { name: 'Clear selection' } ) );
		expect( selection.clear ).toHaveBeenCalled();

		fireEvent.click( screen.getByRole( 'button', { name: 'Bulk edit' } ) );
		expect( screen.getByRole( 'dialog', { name: 'Edit 3 items' } ) ).toBeInTheDocument();
		expect( screen.getByTestId( 'modal-items' ) ).toHaveTextContent( '1,7,8' );
		expect( RenderModal.mock.calls[ 0 ]?.[ 0 ].items ).toBe( rows );
	} );
} );
