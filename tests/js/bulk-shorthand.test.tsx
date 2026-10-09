import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { DataFormControlProps } from '../../resources/dataviews';
import { DONT_CHANGE, parseShorthand } from '../../resources/edit/bulk-numeric';
import type { NumericOp } from '../../resources/edit/bulk-numeric';
import { createBulkNumericControl, opFromInput } from '../../resources/edit/bulk-numeric-control';
import { editSettings } from './edit-fixtures';

describe( 'parseShorthand', () => {
	it( 'reads signs and percent into the operation', () => {
		expect( parseShorthand( '+5%', 'money' ) ).toEqual( { operation: 'increase', value: '5', percent: true } );
		expect( parseShorthand( '-10 %', 'money' ) ).toEqual( { operation: 'decrease', value: '10', percent: true } );
		expect( parseShorthand( '+2', 'money' ) ).toEqual( { operation: 'increase', value: '2' } );
		expect( parseShorthand( '-2,50', 'money' ) ).toEqual( { operation: 'decrease', value: '2,50' } );
		expect( parseShorthand( '=49.90', 'money' ) ).toEqual( { operation: 'set', value: '49.90' } );
		expect( parseShorthand( '−3', 'integer' ) ).toEqual( { operation: 'decrease', value: '3' } );
	} );

	it( 'reads "regular price minus" on a sale price only', () => {
		expect( parseShorthand( 'r-20%', 'money', true ) ).toEqual( { operation: 'regular_minus', value: '20', percent: true } );
		expect( parseShorthand( '-20% of regular', 'money', true ) ).toEqual( { operation: 'regular_minus', value: '20', percent: true } );
		expect( parseShorthand( 'regular -5', 'money', true ) ).toEqual( { operation: 'regular_minus', value: '5' } );
		expect( parseShorthand( 'r-20%', 'money', false ) ).toBeNull();
		expect( parseShorthand( 'r+5', 'money', true ) ).toBeNull();
	} );

	it( 'leaves a bare number and anything the field cannot do to the caller', () => {
		expect( parseShorthand( '49.90', 'money' ) ).toBeNull();
		expect( parseShorthand( '+5%', 'integer' ) ).toBeNull();
		expect( parseShorthand( 'abc', 'money' ) ).toBeNull();
	} );
} );

describe( 'opFromInput', () => {
	const increase: NumericOp = { operation: 'increase', value: '3', round: '95' };

	it( 'makes a bare number "change to" when no operation was chosen, and keeps a chosen one', () => {
		expect( opFromInput( '12', DONT_CHANGE, 'money', false, false ) ).toEqual( { operation: 'set', value: '12' } );
		expect( opFromInput( '12', increase, 'money', false, true ) ).toEqual( { ...increase, value: '12' } );
	} );

	it( 'switches the operation on shorthand and keeps the rounding of a relative op', () => {
		expect( opFromInput( '-10%', increase, 'money', false, true ) ).toEqual( { operation: 'decrease', value: '10', percent: true, round: '95' } );
		expect( opFromInput( '=9', increase, 'money', false, true ) ).toEqual( { operation: 'set', value: '9' } );
	} );

	it( 'empties to "no change" unless the operation was picked in the select', () => {
		expect( opFromInput( '', { operation: 'set', value: '1' }, 'money', false, false ) ).toEqual( DONT_CHANGE );
		expect( opFromInput( '', increase, 'money', false, true ) ).toEqual( { ...increase, value: '' } );
	} );
} );

describe( 'BulkNumericControl shorthand', () => {
	const Control = createBulkNumericControl( { kind: 'money', settings: editSettings(), placeholder: 'Mixed' } );
	const field = { id: 'regular_price', label: 'Regular price' } as DataFormControlProps< Record< string, unknown > >[ 'field' ];

	function Harness() {
		const [ data, setData ] = useState< Record< string, unknown > >( {} );

		return <Control data={ data } field={ field } onChange={ ( changes ) => setData( ( current ) => ( { ...current, ...changes } ) ) } hideLabelFromVision={ false } />;
	}

	it( 'takes "+5%" in the value box without touching the operation select first', () => {
		render( <Harness /> );

		const input = screen.getByLabelText( 'Regular price: value' ) as HTMLInputElement;
		const select = screen.getByLabelText( 'Regular price: operation' ) as HTMLSelectElement;

		expect( input.disabled ).toBe( false );
		expect( input.placeholder ).toBe( 'Mixed' );

		fireEvent.change( input, { target: { value: '+5%' } } );

		expect( select.value ).toBe( 'increase_percent' );
		// What was typed stays in the box.
		expect( input.value ).toBe( '+5%' );

		fireEvent.change( select, { target: { value: 'decrease_percent' } } );
		expect( input.value ).toBe( '5' );
	} );
} );
