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
import { isArrayOpFieldId } from './bulk-array';
import { isPlainObject, mergeFragments, readFieldValue } from './field-value';
import { isNumericOp, numericKindOf, parseNumeric, projectEdits } from './bulk-numeric';
import { resolveRowEdits } from './row-rules';
import type { RowEditOptions } from './row-rules';
import { leafOf } from './visibility';

/** The virtual "schedule sale" toggle: not a wc/v3 key, it only clears the dates when turned off. */
export const SCHEDULE_SALE_FIELD_ID = 'schedule_sale';

/**
 * WooCommerce's own relative stock key: wc/v3 products and variations add
 * `inventory_delta` to the stock as stored at write time when the request has
 * no `stock_quantity`, so an order placed while the editor was open is not
 * overwritten (classic bulk edit behaves the same). A relative stock op
 * (+N, -N, ±%) is sent this way instead of the projected absolute value;
 * the change log records it as a stock_quantity row, old to new. A decrease
 * the editor clamped at zero (a row without backorders) stays absolute (0);
 * a row on backorder moves by exactly the amount, below zero too. See docs/contracts.md.
 */
export const STOCK_DELTA_KEY = 'inventory_delta';

/**
 * The core sale date keys. WooCommerce's products and variations
 * controllers only read them when `isset()`, so a JSON `null` is skipped and
 * the stored date stays; an empty string is what clears them.
 */
const CORE_SALE_DATE_KEYS: ReadonlySet< string > = new Set( [ 'date_on_sale_from', 'date_on_sale_to' ] );

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

/** Whether `value` is what the row holds already (a plain value equal to the row's is not sent). */
export function sameAsCurrent( field: ProductField, item: ProductListItem, value: unknown ): boolean {
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

/** Whether a numeric op's result equals the row's stored number ("151.20" and "151.2" are the same price). */
export function sameNumberAsCurrent( field: ProductField, item: ProductListItem, value: unknown ): boolean {
	const current = parseNumeric( readFieldValue( field, item ) );
	const next = parseNumeric( value );

	return current !== undefined && next !== undefined && current === next;
}

export function buildPayload( item: ProductListItem, edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: RowEditOptions = {} ): Record< string, unknown > {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const own = resolveRowEdits( item, edits, options );
	const projected = projectEdits( item, own, fields, settings );
	let payload: Record< string, unknown > = {};

	for ( const [ id, value ] of Object.entries( projected ) ) {
		if ( isArrayOpFieldId( id ) ) {
			continue;
		}

		if ( id === SCHEDULE_SALE_FIELD_ID || leafOf( id ) === SCHEDULE_SALE_FIELD_ID ) {
			if ( value === false ) {
				const prefix = id.slice( 0, id.length - SCHEDULE_SALE_FIELD_ID.length );
				const from = byId.get( `${ prefix }date_on_sale_from` );
				const to = byId.get( `${ prefix }date_on_sale_to` );

				// A core key clears with '' (WooCommerce skips a null one); other prefixes keep null.
				const cleared = prefix === '' ? '' : null;

				payload = mergeFragments( payload, from?.rest?.write ? from.rest.write( null, item ) : { [ `${ prefix }date_on_sale_from` ]: cleared } );
				payload = mergeFragments( payload, to?.rest?.write ? to.rest.write( null, item ) : { [ `${ prefix }date_on_sale_to` ]: cleared } );
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

		// A value equal to the row's is a no-op the server would log nothing for; a numeric
		// op can land on the stored value too ("Change to" the same price, "regular − 20 %"
		// where the sale already is that, a rounded result), compared as numbers.
		if ( isNumericOp( own[ id ] ) ? sameNumberAsCurrent( field, item, next ) : sameAsCurrent( field, item, next ) ) {
			continue;
		}

		if ( numericKindOf( field ) === 'integer' && typeof next === 'string' ) {
			next = next === '' ? null : Number( next );
		}

		// A cleared core sale date goes as '' (WooCommerce skips a null one and keeps the stored date).
		if ( next === null && ! field.rest?.write && CORE_SALE_DATE_KEYS.has( id ) ) {
			next = '';
		}

		const delta = stockDeltaOf( field, item, own[ id ], next );

		if ( delta !== null ) {
			payload = mergeFragments( payload, { [ STOCK_DELTA_KEY ]: delta } );
			continue;
		}

		const fragment = field.rest?.write ? field.rest.write( next, item ) : { [ id ]: next };

		if ( isPlainObject( fragment ) ) {
			payload = mergeFragments( payload, fragment );
		}
	}

	const filtered = applyFilters( FILTERS.savePayload, payload, item, own );

	return isPlainObject( filtered ) ? filtered : payload;
}

/**
 * A relative op on the core stock quantity, as the signed delta the server
 * adds at write time; null for anything else (a "Change to", another field,
 * a row whose stock is not a number yet, a no-op, or a decrease that
 * lands on zero, which is written as the absolute 0: the projection clamps
 * there on rows without backorders). Below zero (a row on backorder) the
 * delta is the requested amount, exactly as classic bulk edit moves stock.
 */
export function stockDeltaOf( field: ProductField, item: ProductListItem, op: unknown, next: unknown ): number | null {
	if ( field.id !== 'stock_quantity' || field.rest?.write || ! isNumericOp( op ) || ( op.operation !== 'increase' && op.operation !== 'decrease' ) ) {
		return null;
	}

	const raw = readFieldValue( field, item );
	const expected = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number( raw ) : NaN;

	if ( ! Number.isInteger( expected ) || typeof next !== 'number' || ! Number.isInteger( next ) || next === expected ) {
		return null;
	}

	if ( op.operation === 'decrease' && next === 0 ) {
		return null;
	}

	return next - expected;
}

/** Whether a payload carries anything to send. */
export function hasPayload( payload: Record< string, unknown > ): boolean {
	return Object.keys( payload ).length > 0;
}
