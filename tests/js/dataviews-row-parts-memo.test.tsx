/**
 * The second half of patches/@wordpress__dataviews@20.0.0.patch (see
 * docs/dataviews-patch.md): a row that does re-render (its checkbox flipped,
 * the header "Select all") does not re-render its primary column or its
 * actions, and a row's actions menu mounts on first use, not with the row.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from '@wordpress/element';
import { describe, expect, it, vi } from 'vitest';
import type { DataViews as DataViewsComponent, View } from '@wordpress/dataviews';
// @ts-expect-error -- no declaration file next to the bundle
import * as bundle from '../../node_modules/@wordpress/dataviews/build-wp/index.js';

const { DataViews } = bundle as unknown as { DataViews: typeof DataViewsComponent };

type Item = { id: number; name: string };

const items: Item[] = Array.from( { length: 8 }, ( _, i ) => ( { id: i + 1, name: `Item ${ i + 1 }` } ) );

const titleRenders = vi.fn< ( id: number ) => void >();
const primaryLabels = vi.fn< ( id: number ) => void >();
const removed = vi.fn< ( ids: number[] ) => void >();

const fields = [
	{
		id: 'name',
		label: 'Name',
		getValue: ( { item }: { item: Item } ) => item.name,
		// Not memoised: a call means the primary column rendered.
		render: ( { item }: { item: Item } ) => {
			titleRenders( item.id );

			return <span>{ item.name }</span>;
		},
	},
];

const actions = [
	{
		id: 'open',
		isPrimary: true,
		label: ( rows: Item[] ) => {
			primaryLabels( rows[ 0 ]!.id );

			return 'Open';
		},
		callback: () => {},
	},
	{ id: 'bulk', label: 'Bulk', supportsBulk: true, callback: () => {} },
	{ id: 'remove', label: 'Remove', callback: ( rows: Item[] ) => removed( rows.map( ( row ) => row.id ) ) },
];

const getItemId = ( item: Item ) => String( item.id );

function Harness() {
	const [ selection, setSelection ] = useState< string[] >( [] );
	const [ view, setView ] = useState< View >( { type: 'table', fields: [], titleField: 'name', perPage: 20, page: 1 } );

	return (
		<DataViews
			data={ items }
			fields={ fields }
			view={ view }
			onChangeView={ setView }
			actions={ actions }
			selection={ selection }
			onChangeSelection={ setSelection }
			getItemId={ getItemId }
			paginationInfo={ { totalItems: items.length, totalPages: 1 } }
			defaultLayouts={ { table: {} } }
		/>
	);
}

describe( 'patched DataViews row parts', () => {
	it( 'a selection change re-renders neither the primary column nor the row actions', () => {
		render( <Harness /> );
		expect( titleRenders ).toHaveBeenCalled();
		titleRenders.mockClear();
		primaryLabels.mockClear();

		fireEvent.click( screen.getAllByRole( 'checkbox', { name: 'Select all' } )[ 0 ]! );
		fireEvent.click( screen.getAllByRole( 'checkbox', { name: 'Deselect all' } )[ 0 ]! );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Item 3' } ) );

		expect( titleRenders ).not.toHaveBeenCalled();
		expect( primaryLabels ).not.toHaveBeenCalled();
	} );

	it( 'the actions menu is a plain button until used, then opens on that first click', () => {
		render( <Harness /> );

		// No menu machinery per row: the trigger is a plain, labelled popup button.
		const trigger = screen.getAllByRole( 'button', { name: 'Actions' } )[ 1 ]!;
		expect( trigger ).toHaveAttribute( 'aria-haspopup', 'menu' );
		expect( trigger ).toHaveAttribute( 'aria-expanded', 'false' );
		expect( screen.queryByRole( 'menuitem', { name: 'Remove' } ) ).not.toBeInTheDocument();

		act( () => {
			fireEvent.click( trigger );
		} );

		const item = screen.getByRole( 'menuitem', { name: 'Remove' } );
		// The real trigger took the placeholder's place and focus.
		const real = screen.getAllByRole( 'button', { name: 'Actions' } ).find( ( button ) => button.getAttribute( 'aria-expanded' ) === 'true' );
		expect( real ).toBeDefined();

		fireEvent.click( item );
		expect( removed ).toHaveBeenCalledWith( [ 2 ] );
	} );

	it( 'ArrowDown on the plain button opens the menu too', () => {
		render( <Harness /> );
		const trigger = screen.getAllByRole( 'button', { name: 'Actions' } )[ 0 ]!;

		act( () => {
			fireEvent.keyDown( trigger, { key: 'ArrowDown' } );
		} );

		expect( screen.getByRole( 'menuitem', { name: 'Remove' } ) ).toBeInTheDocument();
	} );
} );
