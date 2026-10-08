/**
 * A sale date the browser could not read must block Update, never become
 * "no date" (a scheduled −20 % went live at once with no end when Chrome's
 * year segment took six digits).
 */
import { describe, expect, it } from 'vitest';
import { fromInputDateTime, readDateInput, toInputDateTime } from '../../resources/edit/datetime-control';
import { DATE_INPUT_MAX, invalidDate, isInvalidDate, saleDateProblem, saleScheduleProblems } from '../../resources/edit/sale-schedule';
import { toFormFields } from '../../resources/edit/form-fields';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { validateFormData } from '../../resources/edit/validity';
import type { ValidatedField } from '../../resources/edit/validity';
import { coreFields, editSettings, simple } from './edit-fixtures';

const ids = [ 'schedule_sale', 'date_on_sale_from', 'date_on_sale_to' ];

describe( 'the date input', () => {
	it( 'turns a six-digit year or a half-typed date into the invalid marker, never into "no date"', () => {
		expect( fromInputDateTime( '2026-10-12T00:00' ) ).toBe( '2026-10-12T00:00:00' );
		expect( fromInputDateTime( '' ) ).toBe( '' );
		expect( isInvalidDate( fromInputDateTime( '202623-10-18T05:09' ) ) ).toBe( true );
		expect( isInvalidDate( readDateInput( { value: '', validity: { badInput: true } } ) ) ).toBe( true );
		expect( readDateInput( { value: '', validity: { badInput: false } } ) ).toBe( '' );
		// What was typed stays in the input.
		expect( toInputDateTime( invalidDate( '202623-10-18T05:09' ) ) ).toBe( '202623-10-18T05:09' );
		expect( DATE_INPUT_MAX.startsWith( '9999-' ) ).toBe( true );
	} );
} );

describe( 'saleScheduleProblems', () => {
	it( 'names an unreadable date while the schedule is on', () => {
		const problems = saleScheduleProblems( { schedule_sale: true, date_on_sale_from: invalidDate( '' ), date_on_sale_to: '2026-10-18T23:59:00' }, ids );

		expect( problems ).toEqual( [ { field: 'date_on_sale_from', message: expect.stringMatching( /complete date/ ) } ] );
	} );

	it( 'wants the end after the start', () => {
		expect( saleScheduleProblems( { schedule_sale: true, date_on_sale_from: '2026-10-18T00:00:00', date_on_sale_to: '2026-10-12T23:59:00' }, ids ) ).toEqual( [
			{ field: 'date_on_sale_to', message: expect.stringMatching( /end after it starts/ ) },
		] );
		expect( saleScheduleProblems( { schedule_sale: true, date_on_sale_from: '2026-10-12T00:00:00', date_on_sale_to: '2026-10-18T23:59:00' }, ids ) ).toEqual( [] );
	} );

	it( 'ignores the dates while the schedule is off, and checks a language prefix of its own', () => {
		expect( saleScheduleProblems( { schedule_sale: false, date_on_sale_from: invalidDate( 'x' ) }, ids ) ).toEqual( [] );
		expect( saleDateProblem( { 'i18n:se.schedule_sale': true, 'i18n:se.date_on_sale_to': invalidDate( '' ) }, 'i18n:se.date_on_sale_to', [ 'i18n:se.schedule_sale', 'i18n:se.date_on_sale_to' ] ) ).toMatch( /complete date/ );
	} );

	it( 'is a rule of the form: Update is blocked in quick and bulk edit alike', () => {
		const settings = editSettings();
		const fields = withScheduleSale( coreFields() ).filter( ( field ) => ids.includes( field.id ) );

		for ( const bulk of [ false, true ] ) {
			const formFields = toFormFields( fields, { bulk, items: [ simple( 1 ), simple( 2 ) ], base: {}, mixed: {}, settings } );
			const invalid = validateFormData( { schedule_sale: true, date_on_sale_from: invalidDate( '' ), date_on_sale_to: '' }, formFields as unknown as ValidatedField[] );

			expect( invalid.map( ( entry ) => entry.field ) ).toEqual( [ 'date_on_sale_from' ] );
		}
	} );
} );
