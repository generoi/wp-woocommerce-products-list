import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataForm } from '../../resources/dataviews';
import { toFormFields } from '../../resources/edit/form-fields';
import { mergeItems } from '../../resources/edit/merge';
import { coreFields, editSettings, simple } from './edit-fixtures';

const settings = editSettings();

describe( 'a bulk price field holding an operation while its rows are read again', () => {
	it( 'shows the operation as text (read-only) instead of crashing the editor', () => {
		const fields = coreFields().filter( ( entry ) => entry.id === 'regular_price' );
		const items = [ simple( 1, { regular_price: '10' } ), simple( 2, { regular_price: '12' } ) ];
		const merged = mergeItems( items, fields );
		const formFields = toFormFields( fields, { bulk: true, items, base: merged.data, mixed: merged.mixed, settings, pending: new Set( [ 'regular_price' ] ) } );
		const data = { ...merged.data, regular_price: { operation: 'increase', value: '1' } };

		expect( formFields[ 0 ]?.readOnly ).toBe( true );
		expect( () =>
			render( <DataForm data={ data } fields={ formFields } form={ { layout: { type: 'regular' }, fields: [ 'regular_price' ] } } onChange={ () => undefined } /> )
		).not.toThrow();
		expect( screen.getByText( '+ 1,00 €' ) ).toBeInTheDocument();
	} );
} );
