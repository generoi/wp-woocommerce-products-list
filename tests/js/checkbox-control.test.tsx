/**
 * The editor's checkboxes never share an id with the list's: DataViews'
 * inlined components copy counts `inspector-checkbox-control-N` from zero
 * too, and a shared id sends a label click to the list's select-all box.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CheckboxControl } from '../../resources/ui/checkbox-control';

describe( 'CheckboxControl', () => {
	it( 'gets an id of its own, so its label ticks it and not the list\'s select-all checkbox', () => {
		const selectAll = vi.fn();
		const onChange = vi.fn();

		render(
			<>
				<input type="checkbox" id="inspector-checkbox-control-0" aria-label="Select all" onChange={ selectAll } />
				<CheckboxControl __nextHasNoMarginBottom label="Apply to all variations" checked={ false } onChange={ onChange } />
				<CheckboxControl __nextHasNoMarginBottom label="Other" checked={ false } onChange={ vi.fn() } />
			</>
		);

		const box = screen.getByRole( 'checkbox', { name: 'Apply to all variations' } );

		expect( box.id ).toMatch( /^wc-pl-checkbox-/ );
		expect( box.id ).not.toBe( screen.getByRole( 'checkbox', { name: 'Other' } ).id );

		fireEvent.click( screen.getByText( 'Apply to all variations' ) );
		expect( onChange ).toHaveBeenCalledWith( true );
		expect( selectAll ).not.toHaveBeenCalled();
	} );
} );
