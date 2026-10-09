import { fireEvent, render, screen } from '@testing-library/react';
import { getSettings as getDateSettings, setSettings as setDateSettings } from '@wordpress/date';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDateTimeControl, fromInputDateTime, readDateTimeInputs, toInputDateTime } from '../../resources/edit/datetime-control';
import { toFormFields } from '../../resources/edit/form-fields';
import { mergeItems } from '../../resources/edit/merge';
import { buildPayload } from '../../resources/edit/payload';
import type { DataFormControlProps } from '../../resources/dataviews';
import { coreFields, editSettings, simple } from './edit-fixtures';

const settings = editSettings();

describe( 'toInputDateTime / fromInputDateTime', () => {
	const dateSettings = getDateSettings();

	beforeAll( () => setDateSettings( { ...dateSettings, timezone: { offset: 2, offsetFormatted: '2', string: 'Europe/Helsinki', abbr: 'EET' } } ) );
	afterAll( () => setDateSettings( dateSettings ) );

	it( 'shows a stored site-time value as is and a zoned instant in site time', () => {
		expect( toInputDateTime( '2026-10-12T00:00:00' ) ).toBe( '2026-10-12T00:00' );
		expect( toInputDateTime( '2026-10-12 08:30:00' ) ).toBe( '2026-10-12T08:30' );
		expect( toInputDateTime( '2026-10-31T22:00:00.000Z' ) ).toBe( '2026-11-01T00:00' );
		expect( toInputDateTime( '' ) ).toBe( '' );
		expect( toInputDateTime( null ) ).toBe( '' );
		expect( toInputDateTime( 'nope' ) ).toBe( '' );
	} );

	it( 'emits the wc/v3 site-time form with seconds, and an empty string to clear', () => {
		expect( fromInputDateTime( '2026-10-12T00:00' ) ).toBe( '2026-10-12T00:00:00' );
		expect( fromInputDateTime( '' ) ).toBe( '' );
		// What the control emits goes to the request untouched (no zone shift).
		expect( buildPayload( simple( 1, { date_on_sale_from: null } ), { date_on_sale_from: fromInputDateTime( '2026-10-12T00:00' ) }, coreFields(), settings ) ).toEqual( { date_on_sale_from: '2026-10-12T00:00:00' } );
	} );
} );

describe( 'date-only sale dates', () => {
	it( 'reads a date without a time as the whole day: from 00:00, to 23:59', () => {
		expect( fromInputDateTime( '2026-10-12' ) ).toBe( '2026-10-12T00:00:00' );
		expect( fromInputDateTime( '2026-10-18', true ) ).toBe( '2026-10-18T23:59:59' );
		expect( fromInputDateTime( '2026-10-18T10:15', true ) ).toBe( '2026-10-18T10:15:00' );
		expect( readDateTimeInputs( { value: '2026-10-18' }, { value: '' }, true ) ).toBe( '2026-10-18T23:59:59' );
		expect( readDateTimeInputs( { value: '2026-10-18' }, { value: '08:30' } ) ).toBe( '2026-10-18T08:30:00' );
		expect( readDateTimeInputs( { value: '' }, { value: '' } ) ).toBe( '' );
		expect( readDateTimeInputs( { value: '' }, { value: '08:30' } ) ).toMatch( /^invalid-date:/ );
		expect( readDateTimeInputs( { value: '', validity: { badInput: true } }, { value: '' } ) ).toMatch( /^invalid-date:/ );
	} );
} );

describe( 'DateTimeControl', () => {
	it( 'is a datetime-local input named after the field, in site time', () => {
		const Control = createDateTimeControl( settings );
		const onChange = vi.fn();
		const fields = coreFields();
		const from = fields.find( ( entry ) => entry.id === 'date_on_sale_from' )!;
		const item = simple( 1, { date_on_sale_from: '2026-10-12T00:00:00' } );
		const merged = mergeItems( [ item ], fields );
		const formField = toFormFields( [ { ...from, label: 'Sale from' } ], { bulk: false, items: [ item ], base: merged.data, mixed: merged.mixed, settings } )[ 0 ]!;

		expect( typeof formField.Edit ).toBe( 'function' );

		render( <Control data={ merged.data } field={ formField as DataFormControlProps< Record< string, unknown > >[ 'field' ] } onChange={ onChange } hideLabelFromVision={ false } /> );

		const input = screen.getByLabelText( 'Sale from' ) as HTMLInputElement;
		const time = screen.getByLabelText( 'Sale from, time (optional)' ) as HTMLInputElement;

		expect( input.type ).toBe( 'date' );
		expect( input.value ).toBe( '2026-10-12' );
		expect( time.type ).toBe( 'time' );
		expect( time.value ).toBe( '00:00' );
		expect( screen.getByText( /Europe\/Helsinki/ ) ).toBeInTheDocument();
		expect( screen.getByText( /starts at 00:00/ ) ).toBeInTheDocument();

		fireEvent.change( time, { target: { value: '23:59' } } );
		expect( onChange ).toHaveBeenLastCalledWith( { date_on_sale_from: '2026-10-12T23:59:00' } );

		fireEvent.change( input, { target: { value: '2026-10-18' } } );
		fireEvent.change( time, { target: { value: '' } } );
		expect( onChange ).toHaveBeenLastCalledWith( { date_on_sale_from: '2026-10-18T00:00:00' } );

		fireEvent.change( input, { target: { value: '' } } );
		expect( onChange ).toHaveBeenLastCalledWith( { date_on_sale_from: '' } );
	} );
} );
