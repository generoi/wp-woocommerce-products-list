import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from '@wordpress/element';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPriceEdit, PriceEdit } from '../../resources/fields/components/price-edit';
import { setSettings } from '../../resources/settings';
import type { ProductListItem } from '../../resources/types';
import type { DataFormControlProps } from '../../resources/dataviews';
import { sampleSettings } from './settings.test';

type Props = DataFormControlProps< ProductListItem >;

const field = {
	id: 'regular_price',
	label: 'Regular price',
	getValue: ( { item }: { item: ProductListItem } ) => ( item as { regular_price?: string } ).regular_price ?? '',
	setValue: ( { value }: { item: ProductListItem; value: unknown } ) => ( { regular_price: value } ),
} as unknown as Props[ 'field' ];

/** The form around the control: every change lands in the data the control reads back. */
function Harness( { initial, message }: { initial: string; message?: string } ) {
	const [ data, setData ] = useState( { id: 1, regular_price: initial } as unknown as ProductListItem );
	const validity = message ? { custom: { type: 'invalid', message } } : undefined;

	return <PriceEdit data={ data } field={ field } onChange={ ( patch ) => setData( ( current ) => ( { ...current, ...patch } ) ) } validity={ validity as Props[ 'validity' ] } hideLabelFromVision={ false } />;
}

describe( 'PriceEdit', () => {
	beforeEach( () => setSettings( sampleSettings() ) );
	afterEach( () => setSettings( undefined ) );

	it( 'a market price shows its "Default: …" help (the converted price the shop shows now), and a problem in its place', () => {
		const MarketPriceEdit = createPriceEdit( { symbol: 'kr', decimals: 2 } );
		const described = { ...field, id: 'i18n:se.regular_price', description: 'Default: 85,00 kr' } as unknown as Props[ 'field' ];
		const data = { id: 1, regular_price: '' } as unknown as ProductListItem;
		const view = render( <MarketPriceEdit data={ data } field={ described } onChange={ () => undefined } hideLabelFromVision={ false } /> );

		expect( screen.getByText( 'Default: 85,00 kr' ) ).toBeInTheDocument();

		view.rerender( <MarketPriceEdit data={ data } field={ described } onChange={ () => undefined } validity={ { custom: { type: 'invalid', message: 'Not a price.' } } as Props[ 'validity' ] } hideLabelFromVision={ false } /> );
		expect( screen.getByText( 'Not a price.' ) ).toBeInTheDocument();
		expect( screen.queryByText( 'Default: 85,00 kr' ) ).toBeNull();
	} );

	it( 'keeps the typed text while focused and formats it on blur', () => {
		render( <Harness initial="" /> );
		const input = screen.getByLabelText( 'Regular price' ) as HTMLInputElement;

		fireEvent.focus( input );

		for ( const typed of [ '1', '14', '149' ] ) {
			fireEvent.change( input, { target: { value: typed } } );
			expect( input.value ).toBe( typed );
		}

		fireEvent.blur( input );
		expect( input.value ).toBe( '149,00' );
	} );

	it( 'accepts the shop notation and a trailing decimal mark while typing', () => {
		render( <Harness initial="10" /> );
		const input = screen.getByLabelText( 'Regular price' ) as HTMLInputElement;

		expect( input.value ).toBe( '10,00' );
		fireEvent.focus( input );
		fireEvent.change( input, { target: { value: '12,' } } );
		expect( input.value ).toBe( '12,' );
		fireEvent.change( input, { target: { value: '12,5' } } );
		expect( input.value ).toBe( '12,5' );
		fireEvent.blur( input );
		expect( input.value ).toBe( '12,50' );
	} );

	it( 'follows a stored value that changes while the input is not focused', () => {
		function Outer() {
			const [ value, setValue ] = useState( '5' );

			return (
				<>
					<button onClick={ () => setValue( '7' ) }>reset</button>
					<Harness key={ value } initial={ value } />
				</>
			);
		}

		render( <Outer /> );
		expect( ( screen.getByLabelText( 'Regular price' ) as HTMLInputElement ).value ).toBe( '5,00' );
		fireEvent.click( screen.getByText( 'reset' ) );
		expect( ( screen.getByLabelText( 'Regular price' ) as HTMLInputElement ).value ).toBe( '7,00' );
	} );

	/** A form whose base value changes from outside (the editor's load landing) while the user may have typed. */
	function LiveHarness( { base }: { base: string } ) {
		const [ edit, setEdit ] = useState< string | undefined >( undefined );
		const data = { id: 1, regular_price: edit ?? base } as unknown as ProductListItem;

		return <PriceEdit data={ data } field={ field } onChange={ ( patch ) => setEdit( String( ( patch as { regular_price: unknown } ).regular_price ) ) } hideLabelFromVision={ false } />;
	}

	it( 'shows a newer stored value at once while focused but untouched (never a price an edit would not be based on)', () => {
		const { rerender } = render( <LiveHarness base="14" /> );
		const input = screen.getByLabelText( 'Regular price' ) as HTMLInputElement;

		fireEvent.focus( input );
		expect( input.value ).toBe( '14,00' );
		rerender( <LiveHarness base="16" /> );
		expect( input.value ).toBe( '16,00' );
	} );

	it( 'keeps what the user typed when the stored value changes underneath', () => {
		const { rerender } = render( <LiveHarness base="14" /> );
		const input = screen.getByLabelText( 'Regular price' ) as HTMLInputElement;

		fireEvent.focus( input );
		fireEvent.change( input, { target: { value: '15' } } );
		rerender( <LiveHarness base="16" /> );
		expect( input.value ).toBe( '15' );
		fireEvent.blur( input );
		expect( input.value ).toBe( '15,00' );
	} );

	it( 'marks the input invalid when the form reports a problem', () => {
		render( <Harness initial="10" message="The sale price must be lower than the regular price." /> );
		const input = screen.getByLabelText( 'Regular price' );

		expect( input ).toHaveAttribute( 'aria-invalid', 'true' );
		expect( input ).toHaveAttribute( 'inputmode', 'decimal' );
	} );
} );
