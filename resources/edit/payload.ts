/**
 * Turn the edits of one row into its wc/v3 request body.
 *
 * Numeric ops are resolved against the row, integer fields are sent as
 * numbers, `schedule_sale` off clears both sale dates, extension fields write
 * through their `rest.write`, and the result passes `wcProductsList.savePayload`.
 */
import { dateI18n } from '@wordpress/date';
import { applyFilters } from '@wordpress/hooks';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, ProductListItem, Settings } from '../types';
import { isPlainObject, mergeFragments, readFieldValue } from './field-value';
import { isNumericOp, numericKindOf, projectEdits } from './bulk-numeric';
import { leafOf } from './visibility';

/** The virtual "schedule sale" toggle: not a wc/v3 key, it only clears the dates when turned off. */
export const SCHEDULE_SALE_FIELD_ID = 'schedule_sale';

const ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A date as wc/v3 wants it on the non-GMT keys: the site's wall-clock time,
 * `Y-m-d\TH:i:s`, no zone. DataForm's datetime control emits the instant as
 * a UTC ISO string with milliseconds (`2026-10-31T22:00:00.000Z` for 1 Nov
 * 00:00 in Helsinki); WooCommerce's `set_date_prop` does not recognise that
 * form and reads it as site-local time, shifting the sale by the UTC offset.
 * `dateI18n` formats in the site timezone (wp.date carries it), so what was
 * typed is what the shop runs. Empty strings become null (clear the date).
 */
export function toSiteDateTime( value: unknown, type: 'date' | 'datetime' = 'datetime' ): unknown {
	if ( value === '' ) {
		return null;
	}

	if ( typeof value !== 'string' || ! ZONED_DATETIME.test( value ) ) {
		return value;
	}

	return dateI18n( type === 'date' ? 'Y-m-d' : 'Y-m-d\\TH:i:s', value );
}

function sameAsCurrent( field: ProductField, item: ProductListItem, value: unknown ): boolean {
	const current = readFieldValue( field, item );

	if ( current === undefined ) {
		return false;
	}

	if ( typeof current === 'number' && typeof value === 'string' ) {
		return String( current ) === value;
	}

	if ( typeof current === 'string' && typeof value === 'number' ) {
		return current === String( value );
	}

	return JSON.stringify( current ) === JSON.stringify( value );
}

export function buildPayload( item: ProductListItem, edits: Record< string, unknown >, fields: ProductField[], settings: Settings ): Record< string, unknown > {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const projected = projectEdits( item, edits, fields, settings );
	let payload: Record< string, unknown > = {};

	for ( const [ id, value ] of Object.entries( projected ) ) {
		if ( id === SCHEDULE_SALE_FIELD_ID || leafOf( id ) === SCHEDULE_SALE_FIELD_ID ) {
			if ( value === false ) {
				const prefix = id.slice( 0, id.length - SCHEDULE_SALE_FIELD_ID.length );
				const from = byId.get( `${ prefix }date_on_sale_from` );
				const to = byId.get( `${ prefix }date_on_sale_to` );

				payload = mergeFragments( payload, from?.rest?.write ? from.rest.write( null, item ) : { [ `${ prefix }date_on_sale_from` ]: null } );
				payload = mergeFragments( payload, to?.rest?.write ? to.rest.write( null, item ) : { [ `${ prefix }date_on_sale_to` ]: null } );
			}

			continue;
		}

		const field = byId.get( id );

		if ( ! field ) {
			continue;
		}

		let next: unknown = value;

		if ( field.type === 'datetime' || field.type === 'date' ) {
			next = toSiteDateTime( next, field.type );
		}

		// A numeric op always changes something or was dropped by projectEdits;
		// a plain value equal to the row's is a no-op the server would log nothing for.
		if ( ! isNumericOp( edits[ id ] ) && sameAsCurrent( field, item, next ) ) {
			continue;
		}

		if ( numericKindOf( field ) === 'integer' && typeof next === 'string' ) {
			next = next === '' ? null : Number( next );
		}

		const fragment = field.rest?.write ? field.rest.write( next, item ) : { [ id ]: next };

		if ( isPlainObject( fragment ) ) {
			payload = mergeFragments( payload, fragment );
		}
	}

	const filtered = applyFilters( FILTERS.savePayload, payload, item, edits );

	return isPlainObject( filtered ) ? filtered : payload;
}

/** Whether a payload carries anything to send. */
export function hasPayload( payload: Record< string, unknown > ): boolean {
	return Object.keys( payload ).length > 0;
}
