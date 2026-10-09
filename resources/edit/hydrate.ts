/**
 * Rows reach the modal as the list loaded them: only the visible columns'
 * fields (the list asks for nothing else, that is what keeps it fast). The
 * form shows every editable field and the relative numeric ops read the
 * current values, so the selection is reloaded with the full edit field
 * set when the modal opens: one request per hundred products, one per
 * parent for variations, four at a time.
 *
 * The reload is per tab: the General tab's fields come with the modal, a
 * language tab's fields on the first visit to that tab (a page of 100
 * products with six languages of descriptions is over a megabyte; the
 * General tab alone is a few hundred kilobytes).
 *
 * The fetched values are merged *into* the cached row, object by object:
 * a request for `i18n.se.meta_title` answers with `i18n: {se: {meta_title}}`
 * and must not replace the `i18n.se.name` the list shows.
 */
import { getVariations, listProducts } from '../api/client';
import { createLimiter } from '../hierarchy/use-hierarchy';
import type { ProductField, ProductListItem, QuickEditTab } from '../types';
import { isPlainObject } from './field-value';
import { fieldsOfTab, GENERAL_TAB_ID, tabOf } from './form-layouts';
import { isVariation, parentIdOf } from './field-value';
import { visibleEditFields } from './visibility';

/** Always fetched: what the row identity, the actions and the summary need. */
/** `date_modified_gmt` is the baseline a save compares against: a row saved by someone else meanwhile has a newer one. */
export const EDIT_BASE_FIELDS = [ 'id', 'type', 'status', 'parent_id', 'wc_products_list', 'name', 'sku', 'permalink', 'date_modified_gmt' ] as const;

/**
 * What a partial (per-tab) load must never change on a row: the hierarchy
 * and identity keys. The API client normalises every row it returns, so a
 * request without `type` answers `type: 'simple'` and one without `name`
 * answers `name: '#id'`; merged over the row, a variable parent would turn
 * into a simple product and a variation chip into "#221".
 */
export const IDENTITY_KEYS: ReadonlySet< string > = new Set( [ 'type', 'name', 'parent_id', '_kind', '_level', '_parentId', '_parentName', '_hasChildren', '_childCount', '_placeholder' ] );

/** The projected sale < regular check reads both prices whichever one is edited. */
export const PRICE_SIBLING_FIELDS = [ 'price', 'regular_price', 'sale_price', 'on_sale', 'date_on_sale_from', 'date_on_sale_to', 'manage_stock' ] as const;

/** Every status, trash included: a selection may hold rows of any tab. */
export const ANY_STATUS = 'publish,future,draft,pending,private,trash';

export interface EditFetchOptions {
	/** Only the fields of this tab (plus the base keys); every tab when missing. */
	tab?: string;
}

/**
 * The `_fields` the modal needs for a selection: the base keys plus the
 * fields the form could show for these rows (with "apply to variations"
 * on, so the sellable fields of variable parents are there too). With a
 * `tab`, only that tab's fields: the base keys and the price siblings are
 * part of the General tab's load.
 */
export function editFetchFields( fields: ProductField[], items: ProductListItem[], mode: 'quick' | 'bulk', options: EditFetchOptions = {} ): string[] {
	const general = options.tab === undefined || options.tab === GENERAL_TAB_ID;
	const keys = new Set< string >( general ? [ ...EDIT_BASE_FIELDS, ...PRICE_SIBLING_FIELDS ] : [ ...EDIT_BASE_FIELDS ] );

	for ( const field of visibleEditFields( fields, items, { mode, applyToVariations: true } ) ) {
		if ( options.tab !== undefined && tabOf( field ) !== options.tab ) {
			continue;
		}

		for ( const key of field.rest?.fields ?? [] ) {
			keys.add( key );
		}
	}

	return Array.from( keys ).sort();
}

/** The `_fields` of one tab (with `id`), for the load on its first visit; empty when the tab has no fields of its own. */
export function tabFetchFields( fields: ProductField[], items: ProductListItem[], mode: 'quick' | 'bulk', tab: QuickEditTab ): string[] {
	const own = fieldsOfTab( visibleEditFields( fields, items, { mode, applyToVariations: true } ), tab );

	if ( own.length === 0 ) {
		return [];
	}

	const keys = new Set< string >( [ 'id' ] );

	for ( const field of own ) {
		for ( const key of field.rest?.fields ?? [] ) {
			keys.add( key );
		}
	}

	return Array.from( keys ).sort();
}

export interface HydrateDeps {
	listProducts: typeof listProducts;
	getVariations: typeof getVariations;
}

const DEFAULT_DEPS: HydrateDeps = { listProducts, getVariations };

export interface HydratedSelection {
	/** The rows with the fetched values merged in, row order and hierarchy keys kept; missing rows left as they were. */
	items: ProductListItem[];
	/** Ids the server no longer returned (deleted since the list loaded). */
	missing: number[];
	/** Ids whose row was not in the trash when the list loaded but is now (trashed since). */
	trashed: number[];
}

/** The top-level keys a `_fields` list asks for (`i18n.se.name` → `i18n`). */
export function rootKeysOf( fields: string[] ): Set< string > {
	return new Set( fields.map( ( field ) => field.split( '.' )[ 0 ] ?? field ) );
}

/**
 * The cached row with the fetched values on top. Plain objects (an
 * extension's `i18n`, `dimensions`) merge key by key, so a partial fetch
 * keeps what the row already carried; arrays and scalars are replaced.
 * `undefined` never replaces a value. With `only`, just those top-level
 * keys are taken from the fetched row (what the request asked for), and
 * the identity keys the cached row has are kept whatever the fetch says.
 */
export function mergeHydrated< Row extends Record< string, unknown > >( cached: Row, fetched: Record< string, unknown >, only?: ReadonlySet< string > ): Row {
	const result: Record< string, unknown > = { ...cached };

	for ( const [ key, value ] of Object.entries( fetched ) ) {
		if ( value === undefined ) {
			continue;
		}

		if ( only && ( ! only.has( key ) || ( IDENTITY_KEYS.has( key ) && cached[ key ] !== undefined ) ) ) {
			continue;
		}

		const current = result[ key ];

		// An empty list or null where the row holds an object (older servers sent `i18n: []` for "nothing applies") is no data, not a wipe.
		if ( isPlainObject( current ) && ( value === null || ( Array.isArray( value ) && value.length === 0 ) ) ) {
			continue;
		}

		result[ key ] = isPlainObject( current ) && isPlainObject( value ) ? mergeHydrated( current, value ) : value;
	}

	return result as Row;
}

/**
 * The same rows with the fetched values merged in (row order and the
 * hierarchy keys kept). Rows the server no longer returns stay as they
 * are; `hydrateSelection` also names them.
 */
export async function hydrateItems( items: ProductListItem[], fields: string[], deps: HydrateDeps = DEFAULT_DEPS, chunk = 100 ): Promise< ProductListItem[] > {
	return ( await hydrateSelection( items, fields, deps, chunk ) ).items;
}

export async function hydrateSelection( items: ProductListItem[], fields: string[], deps: HydrateDeps = DEFAULT_DEPS, chunk = 100 ): Promise< HydratedSelection > {
	const limit = createLimiter( 4 );
	const byId = new Map< number, ProductListItem >();
	const products: number[] = [];
	const variations = new Map< number, number[] >();

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		if ( isVariation( item ) ) {
			const parentId = parentIdOf( item );

			if ( parentId > 0 ) {
				variations.set( parentId, [ ...( variations.get( parentId ) ?? [] ), item.id ] );
			}
		} else {
			products.push( item.id );
		}
	}

	const jobs: Array< Promise< void > > = [];
	// `status` tells a row trashed since the list loaded apart from one picked on the Trash tab.
	const wanted = fields.includes( 'status' ) ? fields : [ ...fields, 'status' ];
	const _fields = wanted.join( ',' );

	for ( let i = 0; i < products.length; i += chunk ) {
		const ids = products.slice( i, i + chunk );

		jobs.push(
			limit( async () => {
				const result = await deps.listProducts( { include: ids.join( ',' ), per_page: ids.length, include_status: ANY_STATUS, _fields } );

				result.items.forEach( ( row ) => byId.set( row.id, row ) );
			} )
		);
	}

	for ( const [ parentId, ids ] of variations ) {
		for ( let i = 0; i < ids.length; i += chunk ) {
			const slice = ids.slice( i, i + chunk );

			jobs.push(
				limit( async () => {
					const result = await deps.getVariations( parentId, 1, { perPage: slice.length, fields: wanted, params: { include: slice.join( ',' ) } } );

					result.items.forEach( ( row ) => byId.set( row.id, row ) );
				} )
			);
		}
	}

	await Promise.all( jobs );

	const missing: number[] = [];
	const trashed: number[] = [];
	const merged = items.map( ( item ) => {
		const full = byId.get( item.id );

		if ( ! full && ! item._placeholder ) {
			missing.push( item.id );
		}

		if ( full && full.status === 'trash' && item.status !== undefined && item.status !== 'trash' ) {
			trashed.push( item.id );
		}

		return full ? ( mergeHydrated( item as Record< string, unknown >, full as Record< string, unknown > ) as ProductListItem ) : item;
	} );

	return { items: merged, missing, trashed };
}

export interface StatusChanges {
	/** Rows moved to the Trash since the editor loaded them. */
	trashed: number[];
	/** Rows deleted since. */
	missing: number[];
}

/**
 * Just before a bulk save: which of the products were trashed or deleted
 * since the editor loaded them (another tab, another user, WP-CLI). One
 * `_fields=id,status` request per hundred products, so a 100-row save
 * pays a few dozen milliseconds. Variations are left out: they have no
 * Trash of their own.
 */
export async function recheckStatuses( items: ProductListItem[], deps: Pick< HydrateDeps, 'listProducts' > = DEFAULT_DEPS, chunk = 100 ): Promise< StatusChanges > {
	const products = items.filter( ( item ) => ! item._placeholder && ! isVariation( item ) && item.status !== 'trash' );
	const seen = new Map< number, string | undefined >();
	const limit = createLimiter( 4 );

	await Promise.all(
		Array.from( { length: Math.ceil( products.length / chunk ) }, ( _, index ) => products.slice( index * chunk, ( index + 1 ) * chunk ) ).map( ( slice ) =>
			limit( async () => {
				const result = await deps.listProducts( { include: slice.map( ( item ) => item.id ).join( ',' ), per_page: slice.length, include_status: ANY_STATUS, _fields: 'id,status' } );

				result.items.forEach( ( row ) => seen.set( row.id, row.status ) );
			} )
		)
	);

	return {
		trashed: products.filter( ( item ) => seen.get( item.id ) === 'trash' ).map( ( item ) => item.id ),
		missing: products.filter( ( item ) => ! seen.has( item.id ) ).map( ( item ) => item.id ),
	};
}

/**
 * The rows saved by someone else since the editor loaded them: their
 * `date_modified_gmt` now differs from the one loaded. WooCommerce stamps a
 * product on every save, and a variable parent whenever one of its
 * variations saves (the deferred parent sync), so a newer parent means its
 * variations may have changed too. Rows whose baseline is unknown (the
 * load failed, the date was not fetched) are never reported.
 */
export function changedSinceLoaded( known: ProductListItem[], fresh: ReadonlyMap< number, ProductListItem > ): ProductListItem[] {
	return known.filter( ( item ) => {
		const before = ( item as { date_modified_gmt?: unknown } ).date_modified_gmt;
		const now = ( fresh.get( item.id ) as { date_modified_gmt?: unknown } | undefined )?.date_modified_gmt;

		return typeof before === 'string' && before !== '' && typeof now === 'string' && now !== '' && now !== before;
	} );
}
