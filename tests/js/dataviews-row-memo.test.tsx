/**
 * The patch in patches/@wordpress__dataviews@20.0.0.patch (see
 * docs/dataviews-patch.md): a table row re-renders only when its own props
 * change, not on every selection change. The test runs against the patched
 * `build-wp` bundle, the one `resources/dataviews.ts` imports (vitest aliases
 * `@wordpress/dataviews/wp` to the unpatched module build for everything else).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from '@wordpress/element';
import { describe, expect, it, vi } from 'vitest';
import type { DataViews as DataViewsComponent, View } from '@wordpress/dataviews';
// A relative path: the package's `exports` map hides build-wp from bare imports; the types are the package's.
// @ts-expect-error -- no declaration file next to the bundle
import * as bundle from '../../node_modules/@wordpress/dataviews/build-wp/index.js';

const { DataViews } = bundle as unknown as { DataViews: typeof DataViewsComponent };

type Item = { id: number; name: string; qty: number };

const items: Item[] = Array.from( { length: 12 }, ( _, i ) => ( { id: i + 1, name: `Item ${ i + 1 }`, qty: i } ) );

const renders = vi.fn< ( id: number ) => void >();

const fields = [
	{ id: 'name', label: 'Name', getValue: ( { item }: { item: Item } ) => item.name },
	{
		id: 'qty',
		label: 'Quantity',
		// Not memoised on purpose: a call means the row rendered.
		render: ( { item }: { item: Item } ) => {
			renders( item.id );

			return <span>{ item.qty }</span>;
		},
	},
];

const actions = [ { id: 'bulk', label: 'Bulk', supportsBulk: true, callback: () => {} } ];

// Stable, as the app's `getItemId` is; an inline arrow would change every row's props on every render.
const getItemId = ( item: Item ) => String( item.id );

function Harness( { data = items }: { data?: Item[] } ) {
	const [ selection, setSelection ] = useState< string[] >( [] );
	const [ view, setView ] = useState< View >( { type: 'table', fields: [ 'qty' ], titleField: 'name', perPage: 20, page: 1 } );

	return (
		<>
			<output data-testid="selection">{ selection.join( ',' ) }</output>
			<DataViews
				data={ data }
				fields={ fields }
				view={ view }
				onChangeView={ setView }
				actions={ actions }
				selection={ selection }
				onChangeSelection={ setSelection }
				getItemId={ getItemId }
				paginationInfo={ { totalItems: data.length, totalPages: 1 } }
				defaultLayouts={ { table: {} } }
			/>
		</>
	);
}

function rowCheckbox( name: string ): HTMLElement {
	return screen.getByRole( 'checkbox', { name } );
}

describe( 'patched DataViews table rows', () => {
	it( 'toggling a row re-renders that row only, and the toggles accumulate', () => {
		render( <Harness /> );
		// Mount renders every row (twice: the sticky-column measurement lands after the first paint).
		expect( new Set( renders.mock.calls.map( ( [ id ] ) => id ) ).size ).toBe( items.length );
		renders.mockClear();

		fireEvent.click( rowCheckbox( 'Item 3' ) );
		expect( screen.getByTestId( 'selection' ) ).toHaveTextContent( '3' );
		expect( renders.mock.calls.map( ( [ id ] ) => id ) ).toEqual( [ 3 ] );

		renders.mockClear();
		fireEvent.click( rowCheckbox( 'Item 7' ) );
		// Functional update: row 7 was last rendered with an empty selection and must not drop row 3.
		expect( screen.getByTestId( 'selection' ) ).toHaveTextContent( '3,7' );
		expect( renders.mock.calls.map( ( [ id ] ) => id ) ).toEqual( [ 7 ] );

		renders.mockClear();
		fireEvent.click( rowCheckbox( 'Item 3' ) );
		expect( screen.getByTestId( 'selection' ) ).toHaveTextContent( '7' );
		expect( renders.mock.calls.map( ( [ id ] ) => id ) ).toEqual( [ 3 ] );
	} );

	it( 'the header checkbox selects and clears every row', () => {
		render( <Harness /> );
		renders.mockClear();

		// The header checkbox; the bulk-actions footer repeats it.
		fireEvent.click( screen.getAllByRole( 'checkbox', { name: 'Select all' } )[ 0 ]! );
		expect( screen.getByTestId( 'selection' ) ).toHaveTextContent( items.map( ( item ) => item.id ).join( ',' ) );
		expect( renders ).toHaveBeenCalledTimes( items.length );

		renders.mockClear();
		fireEvent.click( screen.getAllByRole( 'checkbox', { name: 'Deselect all' } )[ 0 ]! );
		expect( screen.getByTestId( 'selection' ) ).toHaveTextContent( '' );
		expect( renders ).toHaveBeenCalledTimes( items.length );
	} );

	it( 'a changed item re-renders its row alone', () => {
		const { rerender } = render( <Harness /> );
		renders.mockClear();

		const changed = items.map( ( item ) => ( item.id === 5 ? { ...item, qty: 99 } : item ) );
		rerender( <Harness data={ changed } /> );

		expect( renders.mock.calls.map( ( [ id ] ) => id ) ).toEqual( [ 5 ] );
		expect( screen.getByText( '99' ) ).toBeInTheDocument();
	} );

	it( 'shift-click selects the range from the last toggled row with the live selection', () => {
		render( <Harness /> );

		fireEvent.click( rowCheckbox( 'Item 2' ) );
		fireEvent.click( rowCheckbox( 'Item 9' ) );
		// Row 5's handlers date from its first render (empty selection); the range must still be built on the current one.
		fireEvent.click( rowCheckbox( 'Item 5' ), { shiftKey: true } );

		expect( screen.getByTestId( 'selection' ) ).toHaveTextContent( '2,9,5,6,7,8' );
	} );
} );
