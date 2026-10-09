/**
 * A search the screen refuses (the editor's discard guard answered "Keep
 * editing") goes back out of DataViews' search box, which otherwise keeps
 * the typed text while the list shows the old query.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from '@wordpress/element';
import { describe, expect, it } from 'vitest';
import type { DataViews as DataViewsComponent, View } from '@wordpress/dataviews';
// @ts-expect-error -- no declaration file next to the bundle
import * as bundle from '../../node_modules/@wordpress/dataviews/build-wp/index.js';
import { useSearchEcho } from '../../resources/list/search-echo';

const { DataViews } = bundle as unknown as { DataViews: typeof DataViewsComponent };

type Item = { id: number; name: string };

const items: Item[] = [ { id: 1, name: 'Scrambler' } ];
const fields = [ { id: 'name', label: 'Name', getValue: ( { item }: { item: Item } ) => item.name, enableGlobalSearch: true } ];
const getItemId = ( item: Item ) => String( item.id );

function Harness( { allow }: { allow: { current: boolean } } ) {
	const [ view, setView ] = useState< View >( { type: 'table', fields: [], titleField: 'name', search: 'Scrambler', perPage: 20, page: 1 } );
	const { shownView, reject } = useSearchEcho( view );
	const onChangeView = useCallback(
		( next: View ) => {
			// The guard answers asynchronously, as the discard confirm does.
			void Promise.resolve().then( () => ( allow.current ? setView( next ) : reject( next ) ) );
		},
		[ allow, reject ]
	);

	return (
		<>
			<output data-testid="applied">{ view.search }</output>
			<DataViews data={ items } fields={ fields } view={ shownView } onChangeView={ onChangeView } getItemId={ getItemId } paginationInfo={ { totalItems: 1, totalPages: 1 } } defaultLayouts={ { table: {} } } />
		</>
	);
}

function searchBox(): HTMLInputElement {
	return screen.getByRole( 'searchbox' ) as HTMLInputElement;
}

describe( 'useSearchEcho', () => {
	it( 'puts a refused search back to the applied one', async () => {
		const allow = { current: false };
		render( <Harness allow={ allow } /> );

		expect( searchBox().value ).toBe( 'Scrambler' );
		fireEvent.change( searchBox(), { target: { value: 'Scrambler Mid' } } );
		expect( searchBox().value ).toBe( 'Scrambler Mid' );

		await waitFor( () => expect( searchBox().value ).toBe( 'Scrambler' ), { timeout: 2000 } );
		expect( screen.getByTestId( 'applied' ) ).toHaveTextContent( 'Scrambler' );

		// The box settles: no second change is sent with the refused text.
		await act( () => new Promise( ( resolve ) => setTimeout( resolve, 400 ) ) );
		expect( searchBox().value ).toBe( 'Scrambler' );
	} );

	it( 'leaves an accepted search alone', async () => {
		const allow = { current: true };
		render( <Harness allow={ allow } /> );

		fireEvent.change( searchBox(), { target: { value: 'Scrambler Mid' } } );

		await waitFor( () => expect( screen.getByTestId( 'applied' ) ).toHaveTextContent( 'Scrambler Mid' ), { timeout: 2000 } );
		expect( searchBox().value ).toBe( 'Scrambler Mid' );
	} );
} );
