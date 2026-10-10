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
 * A load that asks for `description` or `short_description` is made in
 * wc/v3's edit context (`context=edit`, `EDIT_CONTEXT_KEYS`): the texts
 * come back raw, as stored (view context runs wpautop and the shortcodes),
 * so the form edits the stored text and the save sends it as the expected
 * value (docs/contracts.md §3.6). The other fields of that request come in
 * edit context too, which is the stored form `_wcpl_expect` compares. The
 * list's own reads stay in view context.
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
import { getVariationsByIds } from './variations-read';

/** Texts wc/v3 answers rendered in view context and raw in edit context: a load that asks for one is made in edit context. */
export const EDIT_CONTEXT_KEYS: ReadonlySet< string > = new Set( [ 'description', 'short_description' ] );

/** `edit` when these `_fields` ask for a text the editor must load raw, else undefined (view, the default). */
export function readContextOf( fields: string[] ): 'edit' | undefined {
	return fields.some( ( field ) => EDIT_CONTEXT_KEYS.has( field.split( '.' )[ 0 ] ?? field ) ) ? 'edit' : undefined;
}

/**
 * Whether a row a save answered with (view context) carries one of the
 * texts the editor loads raw: the editor drops such a row from its loaded
 * set and loads it again, rather than taking the rendered text as the base.
 */
export function carriesViewText( row: Record< string, unknown > ): boolean {
	return Array.from( EDIT_CONTEXT_KEYS ).some( ( key ) => row[ key ] !== undefined );
}

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

/**
 * A re-read row without the identity keys its request did not answer for:
 * `type`, `name` and `parent_id` unless `fields` asked for them, and the
 * hierarchy meta (`_kind`, `_hasChildren`, `_childCount`...) always, which
 * the client derives from those defaults (a read of `id,status` says
 * `type: 'simple'`, no children). With `cached`, only the keys that row
 * holds are dropped (the fetched value fills a key the row lacks). Every
 * re-read that is merged or patched over a list row goes through this, so
 * a refused status change or a conflicted save never turns a variable
 * parent into a simple product without its variations.
 */
export function withoutUnaskedIdentity< Row extends Record< string, unknown > >( row: Row, fields: string[], cached?: Record< string, unknown > ): Row {
	const asked = rootKeysOf( fields );
	const copy: Record< string, unknown > = { ...row };

	for ( const key of IDENTITY_KEYS ) {
		if ( ( key.startsWith( '_' ) || ! asked.has( key ) ) && ( ! cached || cached[ key ] !== undefined ) ) {
			delete copy[ key ];
		}
	}

	return copy as Row;
}

/** The projected sale < regular check reads both prices whichever one is edited. */
export const PRICE_SIBLING_FIELDS = [ 'price', 'regular_price', 'sale_price', 'on_sale', 'date_on_sale_from', 'date_on_sale_to', 'manage_stock' ] as const;

/**
 * The image size every list read asks for (api/query.ts). A re-read merged over a list row asks for it too: wc/v3
 * answers `full` otherwise, and a row re-read after a refused save would load the original image.
 */
export const LIST_IMAGE_SIZE = 'thumbnail';

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
	const market = marketPriceFetchFields( fields, tab.id );

	if ( own.length === 0 && market.length === 0 ) {
		return [];
	}

	const keys = new Set< string >( [ 'id', ...market ] );

	for ( const field of own ) {
		for ( const key of field.rest?.fields ?? [] ) {
			keys.add( key );
		}
	}

	return Array.from( keys ).sort();
}

/**
 * A language tab's market prices (`{tab}.regular_price`, `{tab}.sale_price`):
 * loaded with the tab even where they are no form field (bulk edit), so
 * "Adjust market prices" previews from the prices the server checks, the
 * sale price included (a regular price lowered to the sale is refused).
 */
export function marketPriceFetchFields( fields: ProductField[], tabId: string ): string[] {
	if ( ! tabId.includes( ':' ) ) {
		return [];
	}

	const keys = new Set< string >();

	for ( const price of [ 'regular_price', 'sale_price' ] ) {
		fields.find( ( field ) => field.id === `${ tabId }.${ price }` )?.rest?.fields.forEach( ( key ) => keys.add( key ) );
	}

	return Array.from( keys );
}

export interface HydrateDeps {
	listProducts: typeof listProducts;
	getVariations: typeof getVariations;
	/** Variations of any parents in one request (variations-read.ts); null when the server has no such route. Per parent when missing. */
	getVariationsByIds?: typeof getVariationsByIds;
}

/** Read when called, not on import: a module that imports this file for one helper never touches the client. */
function defaultDeps(): HydrateDeps {
	return { listProducts, getVariations, getVariationsByIds };
}

export interface HydratedSelection {
	/** The rows with the fetched values merged in, row order and hierarchy keys kept; missing rows left as they were. */
	items: ProductListItem[];
	/** Ids the server no longer returned (deleted since the list loaded). */
	missing: number[];
	/** Ids whose row was not in the trash when the list loaded but is now (trashed since). */
	trashed: number[];
	/**
	 * With `date_modified_gmt` among the fields: the stamp of every parent of
	 * a hydrated variation, read in the same round. WooCommerce stamps a parent
	 * whenever one of its variations saves, so it is the baseline the pre-save
	 * check compares a variation against (one request per hundred parents
	 * instead of one per parent).
	 */
	parentStamps: Map< number, string >;
}

/** The top-level keys a `_fields` list asks for (`i18n.se.name` → `i18n`). */
export function rootKeysOf( fields: string[] ): Set< string > {
	return new Set( fields.map( ( field ) => field.split( '.' )[ 0 ] ?? field ) );
}

/** An extension's value entry: the stored value with what the server derives from it, sent whole. */
function isValueEntry( value: Record< string, unknown > ): boolean {
	return 'value' in value;
}

/**
 * The cached row with the fetched values on top. Plain objects (an
 * extension's `i18n`, `dimensions`) merge key by key, so a partial fetch
 * keeps what the row already carried; arrays, scalars and value entries
 * (an object with a `value`, sent whole) are replaced.
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

		// A value entry (`{ value, source, same, copiedFrom, … }`, a translated text) is one value: what it no longer says
		// (a "copied" flag the new text does not have) must not survive from the cached one.
		result[ key ] = isPlainObject( current ) && isPlainObject( value ) && ! isValueEntry( value ) ? mergeHydrated( current, value ) : value;
	}

	return result as Row;
}

/**
 * The same rows with the fetched values merged in (row order and the
 * hierarchy keys kept). Rows the server no longer returns stay as they
 * are; `hydrateSelection` also names them.
 */
export async function hydrateItems( items: ProductListItem[], fields: string[], deps: HydrateDeps = defaultDeps(), chunk = 100 ): Promise< ProductListItem[] > {
	return ( await hydrateSelection( items, fields, deps, chunk ) ).items;
}

export async function hydrateSelection( items: ProductListItem[], fields: string[], deps: HydrateDeps = defaultDeps(), chunk = 100 ): Promise< HydratedSelection > {
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
	const parentStamps = new Map< number, string >();
	const wantsStamps = wanted.includes( 'date_modified_gmt' );
	const context = readContextOf( wanted );
	const contextParam = context ? { context } : {};

	for ( let i = 0; i < products.length; i += chunk ) {
		const ids = products.slice( i, i + chunk );

		jobs.push(
			limit( async () => {
				const result = await deps.listProducts( { include: ids.join( ',' ), per_page: ids.length, include_status: ANY_STATUS, _fields, image_size: LIST_IMAGE_SIZE, ...contextParam } );

				result.items.forEach( ( row ) => byId.set( row.id, row ) );
			} )
		);
	}

	// The parents' stamps (the pre-save check's baseline for their variations): those not hydrated above, light.
	const selectedProducts = new Set( products );
	const stampOnly = wantsStamps ? Array.from( variations.keys() ).filter( ( id ) => ! selectedProducts.has( id ) ) : [];

	for ( let i = 0; i < stampOnly.length; i += chunk ) {
		const ids = stampOnly.slice( i, i + chunk );

		jobs.push(
			limit( async () => {
				const result = await deps.listProducts( { include: ids.join( ',' ), per_page: ids.length, include_status: ANY_STATUS, _fields: 'id,date_modified_gmt' } );

				result.items.forEach( ( row ) => {
					const stamp = ( row as { date_modified_gmt?: unknown } ).date_modified_gmt;

					if ( typeof stamp === 'string' && stamp !== '' ) {
						parentStamps.set( row.id, stamp );
					}
				} );
			} )
		);
	}

	const perParent = ( entries: Iterable< [ number, number[] ] > ) => {
		for ( const [ parentId, ids ] of entries ) {
			for ( let i = 0; i < ids.length; i += chunk ) {
				const slice = ids.slice( i, i + chunk );

				jobs.push(
					limit( async () => {
						const result = await deps.getVariations( parentId, 1, { perPage: slice.length, fields: wanted, params: { include: slice.join( ',' ), ...contextParam } } );

						result.items.forEach( ( row ) => byId.set( row.id, row ) );
					} )
				);
			}
		}
	};

	if ( variations.size && deps.getVariationsByIds ) {
		// Across parents: a page of 100 expanded parents is a handful of requests, not one per parent.
		const parentOf = new Map< number, number >();

		for ( const [ parentId, ids ] of variations ) {
			ids.forEach( ( id ) => parentOf.set( id, parentId ) );
		}

		const across = deps.getVariationsByIds;

		jobs.push(
			( async () => {
				// A failed cross-parent read falls back to the per-parent one (an older server, a proxy that blocks the route).
				const rows = await across( Array.from( parentOf.keys() ), parentOf, { fields: wanted, context } ).catch( () => null );

				if ( rows === null ) {
					// No cross-parent route on this server: one read per parent, as before.
					const fallback: Array< Promise< void > > = [];
					const start = jobs.length;

					perParent( variations );
					fallback.push( ...jobs.slice( start ) );
					await Promise.all( fallback );

					return;
				}

				rows.forEach( ( row ) => byId.set( row.id, row ) );
			} )()
		);
	} else {
		perParent( variations );
	}

	await Promise.all( jobs );

	if ( wantsStamps ) {
		for ( const parentId of variations.keys() ) {
			const stamp = ( byId.get( parentId ) as { date_modified_gmt?: unknown } | undefined )?.date_modified_gmt;

			if ( typeof stamp === 'string' && stamp !== '' ) {
				parentStamps.set( parentId, stamp );
			}
		}
	}

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

		// The identity keys the request did not ask for are the client's defaults, not data: the row keeps its own.
		return full ? ( mergeHydrated( item as Record< string, unknown >, withoutUnaskedIdentity( full as Record< string, unknown >, wanted, item as Record< string, unknown > ) ) as ProductListItem ) : item;
	} );

	return { items: merged, missing, trashed, parentStamps };
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
export async function recheckStatuses( items: ProductListItem[], deps: Pick< HydrateDeps, 'listProducts' > = defaultDeps(), chunk = 100 ): Promise< StatusChanges > {
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

export interface SettledDeletions extends StatusChanges {
	/** Products still there after the last check. */
	present: number[];
}

/**
 * Waits for deletions that may be under way. WordPress deletes a product's terms and meta first, then WooCommerce
 * deletes its variations one by one, and the product itself goes last: for a few seconds (a product with hundreds
 * of variations) a read finds it still there, without its categories, tags, brands or prices. A save that found a
 * product's variations deleted checks the product this way, up to `tries` times `interval` ms apart, until it is
 * gone (or trashed); those still there afterwards are `present`.
 */
export async function settleDeletions(
	items: ProductListItem[],
	{ tries = 8, interval = 1000, deps = defaultDeps(), sleep = ( ms: number ) => new Promise< void >( ( resolve ) => setTimeout( resolve, ms ) ) }: { tries?: number; interval?: number; deps?: Pick< HydrateDeps, 'listProducts' >; sleep?: ( ms: number ) => Promise< void > } = {}
): Promise< SettledDeletions > {
	let pending = items.filter( ( item ) => ! item._placeholder && ! isVariation( item ) );
	const missing: number[] = [];
	const trashed: number[] = [];

	for ( let attempt = 0; attempt < tries && pending.length > 0; attempt++ ) {
		if ( attempt > 0 ) {
			await sleep( interval );
		}

		const check = await recheckStatuses( pending, deps );
		const done = new Set( [ ...check.missing, ...check.trashed ] );

		missing.push( ...check.missing );
		trashed.push( ...check.trashed );
		pending = pending.filter( ( item ) => ! done.has( item.id ) );
	}

	return { missing, trashed, present: pending.map( ( item ) => item.id ) };
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

export interface BaseCheck extends StatusChanges {
	/** Rows saved by someone else since the editor loaded them (a variation: its parent was). */
	stale: ProductListItem[];
}

/**
 * The check before a save that holds a relative op: which products were
 * trashed or deleted meanwhile, and which rows someone else saved since the
 * editor loaded them. One `_fields=id,status,date_modified_gmt` request per
 * hundred products, the parents of the variations included: WooCommerce
 * stamps a parent whenever one of its variations saves, so a variation is
 * stale when its parent's stamp moved from the one read with it
 * (`parentStamps`, from `hydrateSelection`). No per-parent variation reads:
 * a 600-variation save no longer pays fifty round trips before its first
 * write. A row whose baseline is unknown is never reported.
 */
export async function recheckBases( items: ProductListItem[], parentStamps: ReadonlyMap< number, string >, deps: Pick< HydrateDeps, 'listProducts' > = defaultDeps(), chunk = 100 ): Promise< BaseCheck > {
	const rows = items.filter( ( item ) => ! item._placeholder );
	const products = rows.filter( ( item ) => ! isVariation( item ) );
	const ids = new Set< number >( products.map( ( item ) => item.id ) );

	for ( const item of rows ) {
		if ( isVariation( item ) && parentIdOf( item ) > 0 ) {
			ids.add( parentIdOf( item ) );
		}
	}

	const list = Array.from( ids );
	const seen = new Map< number, { status?: string; stamp?: string } >();
	const limit = createLimiter( 4 );

	await Promise.all(
		Array.from( { length: Math.ceil( list.length / chunk ) }, ( _, index ) => list.slice( index * chunk, ( index + 1 ) * chunk ) ).map( ( slice ) =>
			limit( async () => {
				const result = await deps.listProducts( { include: slice.join( ',' ), per_page: slice.length, include_status: ANY_STATUS, _fields: 'id,status,date_modified_gmt' } );

				result.items.forEach( ( row ) => {
					const stamp = ( row as { date_modified_gmt?: unknown } ).date_modified_gmt;

					seen.set( row.id, { status: row.status, stamp: typeof stamp === 'string' ? stamp : undefined } );
				} );
			} )
		)
	);

	const live = products.filter( ( item ) => item.status !== 'trash' );
	const trashed = live.filter( ( item ) => seen.get( item.id )?.status === 'trash' ).map( ( item ) => item.id );
	const missing = live.filter( ( item ) => ! seen.has( item.id ) ).map( ( item ) => item.id );
	const gone = new Set( [ ...trashed, ...missing ] );
	const moved = ( before: unknown, now: string | undefined ) => typeof before === 'string' && before !== '' && typeof now === 'string' && now !== '' && now !== before;
	const stale = rows.filter( ( item ) => {
		if ( gone.has( item.id ) ) {
			return false;
		}

		if ( isVariation( item ) ) {
			const parentId = parentIdOf( item );

			return moved( parentStamps.get( parentId ), seen.get( parentId )?.stamp );
		}

		return moved( ( item as { date_modified_gmt?: unknown } ).date_modified_gmt, seen.get( item.id )?.stamp );
	} );

	return { trashed, missing, stale };
}
