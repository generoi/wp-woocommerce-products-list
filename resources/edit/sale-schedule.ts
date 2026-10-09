/**
 * The sale schedule's own rules. A `datetime-local` input that is only
 * partly filled (or holds a six-digit year) reports an empty value, which
 * the form used to read as "no date": a sale meant for 12–18 October went
 * live at once with no end. The date control now records such input as
 * an invalid marker, and Update is blocked until both dates parse and the
 * end comes after the start.
 */
import { __ } from '@wordpress/i18n';
import { SCHEDULE_SALE_FIELD_ID } from './payload';

/** What the date control stores for input the browser could not turn into a date. */
export const INVALID_DATE_PREFIX = 'invalid-date:';

/** The range the inputs accept: no six-digit years, nothing before the Unix epoch WooCommerce stores. */
export const DATE_INPUT_MIN = '1970-01-01T00:00';
export const DATE_INPUT_MAX = '9999-12-31T23:59';

const SITE_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function invalidDate( raw: string ): string {
	return `${ INVALID_DATE_PREFIX }${ raw }`;
}

export function isInvalidDate( value: unknown ): value is string {
	return typeof value === 'string' && value.startsWith( INVALID_DATE_PREFIX );
}

/** The text the user typed, for an invalid marker. */
export function invalidDateText( value: string ): string {
	return value.slice( INVALID_DATE_PREFIX.length );
}

/** A site-time date as a comparable number (minutes, wall clock); null when empty or not a date. */
export function siteDateValue( value: unknown ): number | null {
	if ( typeof value !== 'string' || value === '' || value.startsWith( INVALID_DATE_PREFIX ) ) {
		return null;
	}

	const match = SITE_DATE.exec( value.replace( ' ', 'T' ).slice( 0, 19 ) );

	if ( ! match ) {
		return null;
	}

	const [ , y, mo, d, h, mi ] = match.map( Number ) as number[];

	return ( ( ( ( y! * 12 + mo! ) * 31 + d! ) * 24 + h! ) * 60 ) + mi!;
}

export interface ScheduleProblem {
	field: string;
	message: string;
}

function prefixOf( id: string ): string | null {
	const match = /^(.*)(?:date_on_sale_from|date_on_sale_to|schedule_sale)$/.exec( id );

	return match ? match[ 1 ]! : null;
}

/**
 * Problems with the sale dates of a form record: input that is not a date,
 * and an end that is not after the start. Only while the schedule is on
 * (or for the date fields alone when the form has no toggle).
 */
export function saleScheduleProblems( data: Record< string, unknown >, fieldIds: Iterable< string > ): ScheduleProblem[] {
	const ids = new Set( fieldIds );
	const prefixes = new Set< string >();
	const problems: ScheduleProblem[] = [];

	for ( const id of ids ) {
		const prefix = prefixOf( id );

		if ( prefix !== null ) {
			prefixes.add( prefix );
		}
	}

	for ( const prefix of prefixes ) {
		const toggleId = `${ prefix }${ SCHEDULE_SALE_FIELD_ID }`;
		const fromId = `${ prefix }date_on_sale_from`;
		const toId = `${ prefix }date_on_sale_to`;

		if ( ids.has( toggleId ) && data[ toggleId ] !== true ) {
			continue;
		}

		let broken = false;

		for ( const id of [ fromId, toId ] ) {
			if ( ids.has( id ) && isInvalidDate( data[ id ] ) ) {
				broken = true;
				problems.push( { field: id, message: __( 'Enter a complete date (a four-digit year) and, if you want, a time, or clear the field.', 'wp-woocommerce-products-list' ) } );
			}
		}

		if ( broken ) {
			continue;
		}

		const from = siteDateValue( data[ fromId ] );
		const to = siteDateValue( data[ toId ] );

		if ( from !== null && to !== null && to <= from ) {
			problems.push( { field: toId, message: __( 'The sale must end after it starts.', 'wp-woocommerce-products-list' ) } );
		}
	}

	return problems;
}

/** The problem of one date field, for its control. */
export function saleDateProblem( data: Record< string, unknown >, fieldId: string, fieldIds: Iterable< string > ): string | null {
	return saleScheduleProblems( data, fieldIds ).find( ( problem ) => problem.field === fieldId )?.message ?? null;
}
