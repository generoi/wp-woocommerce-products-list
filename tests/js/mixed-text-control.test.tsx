import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataFormControlProps } from '../../resources/dataviews';
import { CLEAR_VALUE } from '../../resources/edit/merge';
import { createMixedTextControl } from '../../resources/edit/mixed-text-control';

const Control = createMixedTextControl();
const field = { id: 'weight', label: 'Weight' } as DataFormControlProps< Record< string, unknown > >[ 'field' ];

describe( 'MixedTextControl', () => {
	it( 'shows Mixed, emits what is typed, and turns "Clear on all rows" into the clear sentinel', () => {
		const onChange = vi.fn();
		const { rerender } = render( <Control data={ { weight: '' } } field={ field } onChange={ onChange } hideLabelFromVision={ false } /> );

		const input = screen.getByLabelText( 'Weight' ) as HTMLInputElement;

		expect( input.placeholder ).toBe( 'Mixed' );
		expect( input.value ).toBe( '' );

		fireEvent.change( input, { target: { value: '1.5' } } );
		expect( onChange ).toHaveBeenLastCalledWith( { weight: '1.5' } );

		fireEvent.click( screen.getByLabelText( 'Clear Weight on all rows' ) );
		expect( onChange ).toHaveBeenLastCalledWith( { weight: CLEAR_VALUE } );

		rerender( <Control data={ { weight: CLEAR_VALUE } } field={ field } onChange={ onChange } hideLabelFromVision={ false } /> );
		expect( ( screen.getByLabelText( 'Clear Weight on all rows' ) as HTMLInputElement ).checked ).toBe( true );
		expect( ( screen.getByLabelText( 'Weight' ) as HTMLInputElement ).disabled ).toBe( true );

		fireEvent.click( screen.getByLabelText( 'Clear Weight on all rows' ) );
		expect( onChange ).toHaveBeenLastCalledWith( { weight: undefined } );
	} );
} );
