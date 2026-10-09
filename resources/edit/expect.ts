/**
 * The expected values a write carries (`_wcpl_expect`, docs/contracts.md
 * §3.6): for each field the item changes, the value the editor based the
 * change on, as loaded. The server compares them with the stored values
 * under the object's lock and refuses the item with 409
 * `wc_products_list_conflict` when one differs, so an edit made in another
 * tab, by another user or outside the app meanwhile is never overwritten.
 *
 * Only fields whose loaded value has the stored form are sent:
 * - core scalar keys (`SCALAR_KEYS`), flags and texts included;
 * - term lists by id (`categories`, `tags`, `brands`);
 * - `dimensions` as `{length, width, height}` strings (the order and form
 *   `Recorder::read()` serialises);
 * - single-valued `meta_data.{key}`;
 * - translations and market prices `i18n.{lang}.{field}` (gds-woo-i18n: the
 *   row carries the stored meta `_i18n_{field}_{lang}` as
 *   `i18n.{lang}.{field}.value`, which the server's default reader reads).
 *
 * - the fields wc/v3 shows in another form than it stores, as loaded (the
 *   server also accepts the rendered form, `Concurrency::matches()`):
 *   `description` / `short_description` (view context runs wpautop and the
 *   shortcodes on them), a variation's `name` (the attribute summary; the
 *   stored title has the parent's name in front), `cost_of_goods_sold`
 *   (wc/v3's `{values, total_value}` object or a number, compared by
 *   number) and `images` (the row's list, which holds only the featured
 *   image as list rows drop the gallery; `[]` when the row has none).
 *
 * Not sent: the relative stock key (`inventory_delta` is applied to the
 * stock as stored, so an order meanwhile is not a conflict), `attributes`
 * and extension fields other than `i18n.*` (no stored form the client
 * knows). Those stay "last write wins" behind the server's lock and
 * fresh-state checks; the log's old value shows what was overwritten.
 * A description whose shortcode output changes between two renders is a
 * false conflict (409, nothing written; reload and apply again).
 */
import type { ProductListItem } from '../types';
import { isPlainObject } from './field-value';

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
	'manage_stock',
	'virtual',
	'downloadable',
	'sold_individually',
	'reviews_allowed',
	'external_url',
	'button_text',
	'slug',
] );

/** The request key of gds-woo-i18n's translations and market prices (`i18n: {se: {name}}`). */
const I18N_KEY = 'i18n';

/** Texts wc/v3 view context renders (wpautop, shortcodes): sent as loaded, the server accepts both forms. */
const RENDERED_TEXT_KEYS: ReadonlySet< string > = new Set( [ 'description', 'short_description' ] );

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

function dimensionsValue( value: unknown ): { length: string; width: string; height: string } | undefined {
	if ( ! isPlainObject( value ) ) {
		return undefined;
	}

	const axis = ( key: string ): string | undefined => {
		const entry = value[ key ];

		return entry === undefined || entry === null ? '' : typeof entry === 'string' || typeof entry === 'number' ? String( entry ) : undefined;
	};
	const length = axis( 'length' );
	const width = axis( 'width' );
	const height = axis( 'height' );

	return length === undefined || width === undefined || height === undefined ? undefined : { length, width, height };
}

/** `i18n.{lang}.{field}` => the stored value the row loaded, for each leaf of the payload's `i18n` object. */
function i18nValues( row: Record< string, unknown >, written: unknown, expect: Record< string, unknown > ): void {
	const loaded = row[ I18N_KEY ];

	if ( ! isPlainObject( written ) || ! isPlainObject( loaded ) ) {
		return;
	}

	for ( const [ lang, fields ] of Object.entries( written ) ) {
		const loadedLang = loaded[ lang ];

		if ( ! isPlainObject( fields ) || ! isPlainObject( loadedLang ) ) {
			continue;
		}

		for ( const field of Object.keys( fields ) ) {
			const entry = loadedLang[ field ];
			const value = isPlainObject( entry ) ? entry.value : undefined;

			// Only a loaded stored value: a pair the row did not carry (another tab's fields) says nothing.
			if ( typeof value === 'string' || typeof value === 'number' ) {
				expect[ `${ I18N_KEY }.${ lang }.${ field }` ] = String( value );
			}
		}
	}
}

/** The expected values of one row's payload, path => loaded value; null when there is none to send. */
export function expectedValues( item: ProductListItem, payload: Record< string, unknown > ): Record< string, unknown > | null {
	const row = item as Record< string, unknown >;
	const expect: Record< string, unknown > = {};

	for ( const [ key, value ] of Object.entries( payload ) ) {
		// A variation's `name` (the attribute summary wc/v3 returns) is accepted in that form too.
		if ( SCALAR_KEYS.has( key ) || RENDERED_TEXT_KEYS.has( key ) ) {
			if ( key in row && isScalar( row[ key ] ) ) {
				expect[ key ] = row[ key ];
			}

			continue;
		}

		if ( key === 'cost_of_goods_sold' ) {
			const loaded = key in row ? row[ key ] : undefined;

			if ( typeof loaded === 'number' || typeof loaded === 'string' || loaded === null || isPlainObject( loaded ) ) {
				expect[ key ] = loaded;
			}

			continue;
		}

		if ( key === 'images' ) {
			const ids = key in row ? ( row[ key ] === null ? [] : termIds( row[ key ] ) ) : undefined;

			if ( ids ) {
				expect[ key ] = ids;
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

		if ( key === 'dimensions' ) {
			const loaded = key in row ? dimensionsValue( row[ key ] ) : undefined;

			if ( loaded ) {
				expect[ key ] = loaded;
			}

			continue;
		}

		if ( key === I18N_KEY ) {
			i18nValues( row, value, expect );

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
