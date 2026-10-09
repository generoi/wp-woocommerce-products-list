/**
 * The expected values a write carries (`_wcpl_expect`, docs/contracts.md
 * §3.6): for each field the item changes, the value the editor based the
 * change on, as loaded. The server compares them with the stored values
 * under the object's lock and refuses the item with 409
 * `wc_products_list_conflict` when one differs, so an edit made in another
 * tab, by another user or outside the app meanwhile is never overwritten.
 *
 * Only fields whose loaded value has the stored form are sent: core scalar
 * keys, term lists (by id) and single-valued meta. Not sent: the relative
 * stock key (`inventory_delta` is applied to the stock as stored, so an
 * order meanwhile is not a conflict), objects whose list form differs from
 * the stored one (images, attributes, dimensions) and extension fields
 * (their row shape is the extension's). Those still get the server's lock
 * and fresh-state checks.
 */
import type { ProductListItem } from '../types';

/** The per-item request key. */
export const EXPECT_KEY = '_wcpl_expect';

/** wc/v3 keys whose list value is the stored form (scalars as wc/v3 returns them; term lists by id). */
const SCALAR_KEYS: ReadonlySet< string > = new Set( [
	'name',
	'sku',
	'status',
	'featured',
	'catalog_visibility',
	'regular_price',
	'sale_price',
	'date_on_sale_from',
	'date_on_sale_to',
	'stock_quantity',
	'stock_status',
	'backorders',
	'low_stock_amount',
	'tax_status',
	'tax_class',
	'shipping_class',
	'weight',
	'menu_order',
	'purchase_note',
] );

const TERM_KEYS: ReadonlySet< string > = new Set( [ 'categories', 'tags', 'brands' ] );

type Scalar = string | number | boolean | null;

function isScalar( value: unknown ): value is Scalar {
	return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function termIds( value: unknown ): Array< { id: number } > | undefined {
	if ( ! Array.isArray( value ) ) {
		return undefined;
	}

	const ids: Array< { id: number } > = [];

	for ( const entry of value ) {
		const id = typeof entry === 'object' && entry !== null && 'id' in entry ? Number( ( entry as { id: unknown } ).id ) : NaN;

		if ( ! Number.isInteger( id ) ) {
			return undefined;
		}

		ids.push( { id } );
	}

	return ids;
}

function metaValue( row: Record< string, unknown >, key: string ): Scalar | undefined {
	if ( ! Array.isArray( row.meta_data ) ) {
		return undefined;
	}

	const entries = ( row.meta_data as unknown[] ).filter( ( entry ): entry is { key: string; value: unknown } => typeof entry === 'object' && entry !== null && ( entry as { key?: unknown } ).key === key );

	// Absent from a row that lists its meta: the list may only carry some keys, so nothing is known.
	if ( entries.length !== 1 ) {
		return undefined;
	}

	const value = entries[ 0 ]!.value;

	return isScalar( value ) ? value : undefined;
}

/** The expected values of one row's payload, path => loaded value; null when there is none to send. */
export function expectedValues( item: ProductListItem, payload: Record< string, unknown > ): Record< string, unknown > | null {
	const row = item as Record< string, unknown >;
	const expect: Record< string, unknown > = {};

	for ( const [ key, value ] of Object.entries( payload ) ) {
		if ( SCALAR_KEYS.has( key ) ) {
			if ( key in row && isScalar( row[ key ] ) ) {
				expect[ key ] = row[ key ];
			}

			continue;
		}

		if ( TERM_KEYS.has( key ) ) {
			const ids = key in row ? termIds( row[ key ] ) : undefined;

			if ( ids ) {
				expect[ key ] = ids;
			}

			continue;
		}

		if ( key === 'meta_data' && Array.isArray( value ) ) {
			for ( const entry of value ) {
				const metaKey = typeof entry === 'object' && entry !== null ? ( entry as { key?: unknown } ).key : undefined;

				if ( typeof metaKey !== 'string' || metaKey === '' ) {
					continue;
				}

				const loaded = metaValue( row, metaKey );

				if ( loaded !== undefined ) {
					expect[ `meta_data.${ metaKey }` ] = loaded;
				}
			}
		}
	}

	return Object.keys( expect ).length ? expect : null;
}

/** A write's request item: id, payload and (when known) the expected values. */
export function writeItem( item: ProductListItem, payload: Record< string, unknown > ): { id: number } & Record< string, unknown > {
	const expect = expectedValues( item, payload );

	return { id: item.id, ...payload, ...( expect ? { [ EXPECT_KEY ]: expect } : {} ) };
}
