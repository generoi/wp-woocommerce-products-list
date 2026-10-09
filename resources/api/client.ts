/**
 * Every request the app makes goes through here: one apiFetch middleware
 * marks them as list-mode requests (docs/contracts.md §1), every error
 * becomes an ApiError, and list responses carry their totals.
 */
import apiFetch from '@wordpress/api-fetch';
import type { APIFetchOptions } from '@wordpress/api-fetch';
import { applyFilters } from '@wordpress/hooks';
import { addQueryArgs } from '@wordpress/url';
import { FILTERS } from '../extensions/hooks';
import { normalizeProduct, normalizeVariation } from '../hierarchy/normalize';
import { getSettings } from '../settings';
import type {
	BatchResponse,
	ProductListItem,
	ProductUpdate,
	QueryParams,
	RawProduct,
	RawVariation,
	VariationUpdate,
} from '../types';
import { ApiError, isAbortError, toApiError } from './errors';
import { recordBootRequest, takePrefetched } from './prefetch';

export { ApiError } from './errors';

export const LIST_HEADER = 'X-WC-Products-List';
export const BATCH_HEADER = 'X-WC-Products-List-Batch';
export const SOURCE_HEADER = 'X-WC-Products-List-Source';

export type WriteSource = 'quick' | 'bulk' | 'action' | 'extension';

export interface ListResult< Item > {
	items: Item[];
	total: number;
	totalPages: number;
}

export interface RequestOptions {
	signal?: AbortSignal;
	/** One id per user gesture; generated per call when missing on a write. */
	batchId?: string;
	source?: WriteSource;
}

export interface Term {
	id: number;
	name: string;
	slug: string;
	parent: number;
	count: number;
}

export interface ActionResult {
	id: number;
	ok: boolean;
	code?: string;
	message?: string;
	/** On an ok result: how many fields the handler changed (0 for a no-op). */
	changed?: number;
	data?: Record< string, unknown >;
	/** On a revert `conflict`: the fields changed again since the batch. */
	fields?: string[];
	/** On a revert `conflict`: the object, for a readable report. */
	object_type?: 'product' | 'variation';
	parent_id?: number;
	name?: string;
	/** The conflicting fields' labels ("Stock quantity"), in `fields` order. */
	labels?: string[];
	/** Field => value now. */
	current?: Record< string, unknown >;
	/** Field => the value the batch left. */
	batch?: Record< string, unknown >;
	/** Field => the value a revert would restore. */
	expected?: Record< string, unknown >;
	/** The conflicting fields can be reverted relatively (take the batch's change off the current value). */
	relative?: boolean;
	/** On a revert `conflict`: fields an earlier revert of the batch already put back (never adjusted relatively). */
	already_reverted?: string[];
}

export interface ActionResponse {
	batch_id: string;
	results: ActionResult[];
	items: ProductListItem[];
}

export interface LogRow {
	id: number;
	batch_id: string;
	created_at: string;
	created_at_gmt: string;
	user: { id: number; name: string };
	source: 'quick' | 'bulk' | 'action' | 'extension' | 'revert';
	action: string;
	object_type: 'product' | 'variation';
	object_id: number;
	parent_id: number;
	object_name: string;
	edit_link: string | null;
	field: string;
	old_value: string | null;
	new_value: string | null;
	/** `skipped`: the item was left out of the batch (the message says why). */
	status: 'ok' | 'error' | 'skipped';
	message: string;
	/** The copy a `duplicate` row created, while it still exists. */
	related?: { id: number; name: string; edit_link: string | null } | null;
	/** The batch this row's revert put back (rows written by a revert), or null. */
	reverts?: string | null;
	/** The latest revert of this row's batch, or null. */
	reverted_by?: RevertedBy | null;
	/** A skipped row without a `field`: the fields it left out (its context's `fields`). */
	skipped_fields?: string[];
}

/** Who reverted a batch, and when (`reverted_by` on log rows, batches and plans). */
export interface RevertedBy {
	batch_id: string;
	created_at: string;
	created_at_gmt: string;
	user: { id: number; name: string };
}

export interface LogBatch {
	batch_id: string;
	created_at: string;
	created_at_gmt?: string;
	user: { id: number; name: string };
	source: LogRow[ 'source' ];
	rows: number;
	objects: number;
	fields: string[];
	/** The distinct actions of the batch's rows (update, trash, i18n_copy…). */
	actions?: string[];
	/** Distinct products (not variations) the batch touched. */
	products?: number;
	variations?: number;
	/** Distinct parents of the variations. */
	parents?: number;
	/** Rows that failed. */
	errors?: number;
	/** Distinct items the batch left unwritten (status `skipped` rows). */
	skipped?: number;
	/** Why items were left unwritten (`unchanged`: they already had the value, …). */
	skipped_reasons?: string[];
	/** A readable name for an action batch ("Moved to trash", "Copy translations (Suomi → Svenska): Name"); null for field edits. */
	summary?: string | null;
	/** Fields of the batch's own update/create rows (not those an action wrote). */
	update_fields?: string[];
	/** The name of the batch's action when it has one ("Mark as featured"); `summary` joins it with the field labels for a mixed batch. */
	action_summary?: string | null;
	/** The batch this one reverted, when it is a revert. */
	reverts?: string | null;
	/** The latest revert of this batch. */
	reverted_by?: RevertedBy | null;
	/** Distinct users with rows in the batch; a batch shared by more than one is not revertable. */
	users?: number;
	revertable: boolean;
}

export interface LogQuery {
	object_id?: number;
	batch?: string;
	user?: number;
	field?: string;
	source?: string;
	action?: string;
	since?: string;
	until?: string;
	/** Matches values and product, variation and parent names. */
	search?: string;
	page?: number;
	per_page?: number;
}

/** The extra keys the middleware reads off an apiFetch call. */
interface ListModeOptions {
	wcProductsList?: { batchId?: string; source?: WriteSource };
}

type Options< Parse extends boolean = boolean > = APIFetchOptions< Parse > & ListModeOptions;

const WRITE_METHODS = new Set( [ 'POST', 'PUT', 'PATCH', 'DELETE' ] );

export function newBatchId(): string {
	if ( typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ) {
		return crypto.randomUUID();
	}

	// Fallback for insecure contexts: 32 hex chars in the v4 layout.
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace( /[xy]/g, ( c ) => {
		const r = ( Math.random() * 16 ) | 0;
		const v = c === 'x' ? r : ( r & 0x3 ) | 0x8;
		return v.toString( 16 );
	} );
}

function isWrite( options: APIFetchOptions ): boolean {
	return WRITE_METHODS.has( ( options.method ?? 'GET' ).toUpperCase() );
}

/**
 * The headers list mode needs on an apiFetch options object: the marker on
 * every request, the batch id and source on writes.
 */
export function withListHeaders< T extends Options >( options: T ): T {
	const headers: Record< string, string > = { ...( options.headers ?? {} ), [ LIST_HEADER ]: '1' };

	if ( isWrite( options ) ) {
		headers[ BATCH_HEADER ] = options.wcProductsList?.batchId ?? newBatchId();
		headers[ SOURCE_HEADER ] = options.wcProductsList?.source ?? 'quick';
	}

	return { ...options, headers };
}

let middlewareInstalled = false;

/** Idempotent; the module installs it on import, tests may call it explicitly. */
export function installListModeMiddleware(): void {
	if ( middlewareInstalled ) {
		return;
	}

	middlewareInstalled = true;
	apiFetch.use( ( options, next ) => next( withListHeaders( options as Options ) ) );
}

installListModeMiddleware();

/** apiFetch with ApiError errors and the list-mode keys attached. */
export async function request< T >( options: Options< true > & { parse?: true } ): Promise< T >;
export async function request( options: Options< false > & { parse: false } ): Promise< Response >;
export async function request( options: Options ): Promise< unknown > {
	try {
		return await apiFetch( options as APIFetchOptions );
	} catch ( error ) {
		throw await toApiError( error );
	}
}

function listMode( options: RequestOptions | undefined ): ListModeOptions & { signal?: AbortSignal } {
	return {
		signal: options?.signal,
		wcProductsList: { batchId: options?.batchId, source: options?.source },
	};
}

function header( response: Response, name: string ): number {
	const value = Number( response.headers.get( name ) );

	return Number.isFinite( value ) ? value : 0;
}

/**
 * A stale REST nonce (the session was renewed in another tab, or the nonce
 * rotated after a day): core's apiFetch refreshes it and retries on its own,
 * but only when the error it sees is a parsed `rest_cookie_invalid_nonce`
 * body. `list()` reads the raw response for its headers (`parse: false`),
 * so the 403 reaches it as a Response and core's retry never runs; the same
 * refresh is done here. Resolves to false when there is nothing to refresh
 * with (no nonce middleware: tests, a logged-out page).
 */
export async function refreshNonce(): Promise< boolean > {
	const api = apiFetch as typeof apiFetch & { nonceEndpoint?: string; nonceMiddleware?: { nonce: string } };

	if ( ! api.nonceEndpoint || ! api.nonceMiddleware ) {
		return false;
	}

	try {
		const response = await globalThis.fetch( api.nonceEndpoint );

		if ( ! response.ok ) {
			return false;
		}

		api.nonceMiddleware.nonce = await response.text();

		return true;
	} catch {
		return false;
	}
}

function isStaleNonce( error: unknown ): boolean {
	return error instanceof ApiError && error.code === 'rest_cookie_invalid_nonce';
}

function abortedError(): ApiError {
	return new ApiError( 'Request aborted', 'abort', 0 );
}

/**
 * The response the page's inline prefetch script started for this path
 * (api/prefetch.ts), as a list result; null when there is none, it failed
 * or it is not a list, so the caller asks the server itself.
 */
async function prefetchedList< Raw >( path: string, signal?: AbortSignal ): Promise< ListResult< Raw > | null > {
	const pending = takePrefetched( path );

	if ( ! pending ) {
		return null;
	}

	const response = await pending.catch( () => null );

	if ( signal?.aborted ) {
		throw abortedError();
	}

	if ( ! response?.ok || ! Array.isArray( response.data ) ) {
		return null;
	}

	const items = response.data as Raw[];
	const total = Number( response.headers?.total );
	const totalPages = Number( response.headers?.totalPages );

	return { items, total: Number.isFinite( total ) && total > 0 ? total : items.length, totalPages: Number.isFinite( totalPages ) && totalPages > 0 ? totalPages : 1 };
}

/** A GET that keeps the X-WP-Total headers. */
async function list< Raw >( path: string, options?: RequestOptions, retried = false ): Promise< ListResult< Raw > > {
	if ( ! retried ) {
		const prefetched = await prefetchedList< Raw >( path, options?.signal );

		if ( prefetched ) {
			return prefetched;
		}
	}

	let response: Response;

	try {
		response = await request( { path, parse: false, ...listMode( options ) } );

		// Older apiFetch builds resolve a failed unparsed request with the Response.
		if ( ! response.ok ) {
			throw await toApiError( response );
		}
	} catch ( error ) {
		if ( ! retried && isStaleNonce( error ) && ( await refreshNonce() ) ) {
			return list< Raw >( path, options, true );
		}

		throw error;
	}

	let items: Raw[];

	try {
		items = ( await response.json() ) as Raw[];
	} catch {
		throw new ApiError( 'Invalid JSON in the response.', 'invalid_json', response.status );
	}

	if ( ! Array.isArray( items ) ) {
		throw new ApiError( 'Unexpected response shape.', 'invalid_response', response.status );
	}

	return {
		items,
		total: header( response, 'X-WP-Total' ) || items.length,
		totalPages: header( response, 'X-WP-TotalPages' ) || 1,
	};
}

/** The `wcProductsList.item` filter, applied to every row before it reaches the cache. */
export function filterItem( item: ProductListItem ): ProductListItem {
	return applyFilters( FILTERS.item, item ) as ProductListItem;
}

export function toProductRow( raw: RawProduct ): ProductListItem {
	return filterItem( normalizeProduct( raw ) );
}

export function toVariationRow( raw: RawVariation, parentId: number ): ProductListItem {
	return filterItem( normalizeVariation( raw, parentId ) );
}

/** Normalise any wc/v3 object a write returned: variations carry `parent_id`. */
export function toRow( raw: RawProduct | RawVariation, parentId?: number ): ProductListItem {
	const parent = parentId ?? ( raw as RawVariation ).wc_products_list?.parent_id ?? ( raw as RawVariation ).parent_id ?? 0;

	if ( parent > 0 && ( raw as RawProduct ).type === undefined ) {
		return toVariationRow( raw as RawVariation, parent );
	}

	if ( ( raw as RawProduct ).type === 'variation' ) {
		return toVariationRow( raw as RawVariation, parent );
	}

	return toProductRow( raw as RawProduct );
}

const PRODUCTS = '/wc/v3/products';
const OWN = '/wc-products-list/v1';

export async function listProducts( query: QueryParams, options?: RequestOptions ): Promise< ListResult< ProductListItem > > {
	const path = addQueryArgs( PRODUCTS, query );
	const result = await list< RawProduct >( path, options );

	// The next load of this admin URL can start the same request before the bundle runs.
	recordBootRequest( 'list', path );

	return { ...result, items: result.items.map( toProductRow ) };
}

export async function getVariations(
	parentId: number,
	page = 1,
	options?: RequestOptions & { perPage?: number; fields?: string[]; params?: QueryParams }
): Promise< ListResult< ProductListItem > > {
	const perPage = Math.min( options?.perPage ?? 100, getSettings().limits.perPageMax );
	const query: QueryParams = {
		page,
		per_page: perPage,
		image_size: 'thumbnail',
		...( options?.fields?.length ? { _fields: options.fields.join( ',' ) } : {} ),
		...( options?.params ?? {} ),
	};
	const result = await list< RawVariation >( addQueryArgs( `${ PRODUCTS }/${ parentId }/variations`, query ), options );

	return { ...result, items: result.items.map( ( raw ) => toVariationRow( raw, parentId ) ) };
}

/** The cross-parent variations read (docs/contracts.md, "Cross-parent variation reads"). */
export const VARIATIONS_ACROSS_ROUTE = `${ OWN }/variations`;

/** Null until a request says; false once the server answered that it has no such route. */
let acrossSupported: boolean | null = null;

/** Tests: forget (or force) what the server said about the cross-parent route. */
export function resetVariationsAcrossSupport( value: boolean | null = null ): void {
	acrossSupported = value;
}

export function variationsAcrossSupported(): boolean | null {
	return acrossSupported;
}

function parentOfRawVariation( raw: RawVariation ): number {
	const own = ( raw as { parent_id?: unknown } ).parent_id;
	const enriched = ( raw as { wc_products_list?: { parent_id?: unknown } } ).wc_products_list?.parent_id;

	return Number( own ?? enriched ?? 0 ) || 0;
}

/**
 * One page of every variation of these parents (at most 100 parents, the
 * route's limit), ordered parent by parent, as list rows under their own
 * parent. `X-WP-Total` counts the variations of all of them. Null when the
 * server has no cross-parent route (an older plugin build): the caller
 * reads per parent. `params` are the variation-level filters, as the
 * per-parent route takes them.
 */
export async function getVariationsAcross(
	parentIds: number[],
	page = 1,
	options?: RequestOptions & { perPage?: number; fields?: string[]; params?: QueryParams }
): Promise< ListResult< ProductListItem > | null > {
	if ( acrossSupported === false ) {
		return null;
	}

	const perPage = Math.min( options?.perPage ?? 100, getSettings().limits.perPageMax );
	const fields = options?.fields?.length ? Array.from( new Set( [ ...options.fields, 'id', 'parent_id' ] ) ) : [];
	const query: QueryParams = {
		parent: parentIds.join( ',' ),
		page,
		per_page: perPage,
		image_size: 'thumbnail',
		...( fields.length ? { _fields: fields.join( ',' ) } : {} ),
		...( options?.params ?? {} ),
	};
	let result: ListResult< RawVariation >;

	try {
		result = await list< RawVariation >( addQueryArgs( VARIATIONS_ACROSS_ROUTE, query ), options );
	} catch ( error ) {
		if ( acrossSupported !== true && ! isAbortError( error ) && error instanceof ApiError && ( error.code === 'rest_no_route' || error.status === 404 ) ) {
			acrossSupported = false;

			return null;
		}

		throw error;
	}

	acrossSupported = true;

	return { ...result, items: result.items.map( ( raw ) => toVariationRow( raw, parentOfRawVariation( raw ) ) ) };
}

export async function getProduct( id: number, fields?: string[] ): Promise< ProductListItem > {
	const raw = await request< RawProduct >( {
		path: addQueryArgs( `${ PRODUCTS }/${ id }`, fields?.length ? { _fields: fields.join( ',' ) } : {} ),
	} );

	return toRow( raw );
}

export async function updateProduct( id: number, data: Record< string, unknown >, options?: RequestOptions ): Promise< ProductListItem > {
	const raw = await request< RawProduct >( { path: `${ PRODUCTS }/${ id }`, method: 'POST', data, ...listMode( options ) } );

	return toRow( raw );
}

function chunk< T >( items: T[], size: number ): T[][] {
	const out: T[][] = [];

	for ( let i = 0; i < items.length; i += Math.max( 1, size ) ) {
		out.push( items.slice( i, i + size ) );
	}

	return out;
}

function mergeBatch< Item >( into: BatchResponse< Item >, part: BatchResponse< Item > ): BatchResponse< Item > {
	return {
		create: [ ...( into.create ?? [] ), ...( part.create ?? [] ) ],
		update: [ ...( into.update ?? [] ), ...( part.update ?? [] ) ],
		delete: [ ...( into.delete ?? [] ), ...( part.delete ?? [] ) ],
	};
}

export interface BatchOptions extends RequestOptions {
	/**
	 * The wc/v3 fields each returned row is trimmed to (`?fields=`, read by
	 * Rows::trimBatchItem on list-mode batch writes). Not `_fields`: core
	 * would trim `{update: [...]}` itself and the app would get `{}`.
	 */
	fields?: string[];
}

function batchPath( path: string, options?: BatchOptions ): string {
	return addQueryArgs( path, options?.fields?.length ? { fields: options.fields.join( ',' ) } : {} );
}

/**
 * wc/v3's batch routes need `edit_others_products` (woocommerce_rest_cannot_batch)
 * even for one row. A user who may only edit their own products saves a
 * single row through `POST products/{id}` instead; the result is shaped as a
 * batch response so callers never notice.
 */
async function singleWrite< Raw extends { id: number } >( path: string, body: { id: number } & Record< string, unknown >, options?: BatchOptions ): Promise< BatchResponse< Raw > > {
	const { id, ...data } = body;

	try {
		const row = await request< Raw >( {
			path: addQueryArgs( path, options?.fields?.length ? { _fields: options.fields.join( ',' ) } : {} ),
			method: 'POST',
			data,
			...listMode( options ),
		} );

		return { update: [ { ...row, id: row.id ?? id } ] };
	} catch ( error ) {
		const apiError = error instanceof ApiError ? error : null;

		return { update: [ { id, error: { code: apiError?.code ?? 'request_failed', message: error instanceof Error ? error.message : String( error ), data: {} } } ] };
	}
}

function singleWritesOnly(): boolean {
	return getSettings().caps.editOthers === false;
}

/** `products/batch` in sequential chunks of `limits.batchSize`, one batch id. */
export async function batchProducts( update: ProductUpdate[], options?: BatchOptions ): Promise< BatchResponse< RawProduct > > {
	const batchId = options?.batchId ?? newBatchId();
	let result: BatchResponse< RawProduct > = { update: [] };

	if ( update.length === 1 && update[ 0 ] && singleWritesOnly() ) {
		return singleWrite< RawProduct >( `${ PRODUCTS }/${ update[ 0 ].id }`, update[ 0 ], { ...options, batchId } );
	}

	for ( const part of chunk( update, getSettings().limits.batchSize ) ) {
		const response = await request< BatchResponse< RawProduct > >( {
			path: batchPath( `${ PRODUCTS }/batch`, options ),
			method: 'POST',
			data: { update: part },
			...listMode( { ...options, batchId } ),
		} );
		result = mergeBatch( result, response );
	}

	return result;
}

/** A variation row for the cross-parent batch: its parent is only needed for the single-write fallback. */
export type VariationUpdateAcross = VariationUpdate & { parent_id: number };

/**
 * `POST /wc-products-list/v1/variations/batch`: variations of any number
 * of parents in one request (chunks of `limits.actionBatchSize`, one batch
 * id), the server grouping them by parent (docs/contracts.md §3.4b). The
 * response has wc/v3's `{update: [...]}` shape in request order. A user
 * without `edit_others_products` writes each row on its own route instead.
 */
export async function batchVariationsAcross( update: VariationUpdateAcross[], options?: BatchOptions ): Promise< BatchResponse< RawVariation > > {
	const batchId = options?.batchId ?? newBatchId();
	let result: BatchResponse< RawVariation > = { update: [] };

	if ( singleWritesOnly() ) {
		for ( const row of update ) {
			const { parent_id: parentId, ...body } = row;

			result = mergeBatch( result, await singleWrite< RawVariation >( `${ PRODUCTS }/${ parentId }/variations/${ row.id }`, body, { ...options, batchId } ) );
		}

		return result;
	}

	for ( const part of chunk( update, getSettings().limits.actionBatchSize ) ) {
		const response = await request< BatchResponse< RawVariation > >( {
			path: batchPath( `${ OWN }/variations/batch`, options ),
			method: 'POST',
			// The server addresses each row by its own parent; the one sent along
			// only names the parent in the log row of a variation deleted meanwhile.
			data: { update: part },
			...listMode( { ...options, batchId } ),
		} );
		result = mergeBatch( result, response );
	}

	return result;
}

export async function batchVariations(
	parentId: number,
	update: VariationUpdate[],
	options?: BatchOptions
): Promise< BatchResponse< RawVariation > > {
	const batchId = options?.batchId ?? newBatchId();
	let result: BatchResponse< RawVariation > = { update: [] };

	if ( update.length === 1 && update[ 0 ] && singleWritesOnly() ) {
		return singleWrite< RawVariation >( `${ PRODUCTS }/${ parentId }/variations/${ update[ 0 ].id }`, update[ 0 ], { ...options, batchId } );
	}

	for ( const part of chunk( update, getSettings().limits.batchSize ) ) {
		const response = await request< BatchResponse< RawVariation > >( {
			path: batchPath( `${ PRODUCTS }/${ parentId }/variations/batch`, options ),
			method: 'POST',
			data: { update: part },
			...listMode( { ...options, batchId } ),
		} );
		result = mergeBatch( result, response );
	}

	return result;
}

/** Ids per `POST /actions/{action}` request: the action's own limit (`limits.actionBatchSizes`), else `limits.actionBatchSize`. */
export function actionBatchSizeOf( action: string ): number {
	const limits = getSettings().limits;
	const own = limits.actionBatchSizes?.[ action ];

	return typeof own === 'number' && own > 0 ? own : limits.actionBatchSize;
}

/** The `data.max` of a 400 `wc_products_list_too_many_ids`, or null. */
function tooManyIdsMax( error: unknown ): number | null {
	if ( typeof error !== 'object' || error === null || ( error as { code?: unknown } ).code !== 'wc_products_list_too_many_ids' ) {
		return null;
	}

	const max = Number( ( error as { data?: { max?: unknown } } ).data?.max );

	return Number.isInteger( max ) && max > 0 ? max : null;
}

/** `POST /actions/{action}` in chunks of the action's batch size, one batch id. */
export async function runAction(
	action: string,
	ids: number[],
	args: Record< string, unknown > = {},
	options?: RequestOptions & { fields?: string[] }
): Promise< ActionResponse > {
	const batchId = options?.batchId ?? newBatchId();
	// `fields`, not `_fields`: core would trim the whole response to those
	// keys and the action payload has none of them at the top level.
	const path = addQueryArgs( `${ OWN }/actions/${ action }`, options?.fields?.length ? { fields: options.fields.join( ',' ) } : {} );
	const result: ActionResponse = { batch_id: batchId, results: [], items: [] };

	const queue = chunk( ids, actionBatchSizeOf( action ) );

	while ( queue.length ) {
		const part = queue.shift() as number[];
		let response: ActionResponse;

		try {
			response = await request< ActionResponse >( {
				path,
				method: 'POST',
				data: { ids: part, args },
				...listMode( { ...options, batchId } ),
			} );
		} catch ( error ) {
			// The server's limit is lower than ours (a filter changed it): re-chunk to it.
			const max = tooManyIdsMax( error );

			if ( max !== null && max < part.length ) {
				queue.unshift( ...chunk( part, max ) );
				continue;
			}

			throw error;
		}
		result.results.push( ...( response.results ?? [] ) );
		result.items.push( ...( response.items ?? [] ).map( ( raw ) => toRow( raw as RawProduct ) ) );
	}

	return result;
}

export async function getCounts( options?: RequestOptions ): Promise< Record< string, number > > {
	const path = `${ OWN }/counts`;
	const pending = takePrefetched( path );
	const prefetched = pending ? await pending.catch( () => null ) : null;

	if ( options?.signal?.aborted ) {
		throw abortedError();
	}

	if ( prefetched?.ok && prefetched.data && typeof prefetched.data === 'object' && ! Array.isArray( prefetched.data ) ) {
		return prefetched.data as Record< string, number >;
	}

	const counts = await request< Record< string, number > >( { path, ...listMode( options ) } );

	recordBootRequest( 'counts', path );

	return counts;
}

export async function getTerms(
	taxonomy: string,
	params: { search?: string; include?: number[]; page?: number; perPage?: number } = {},
	options?: RequestOptions
): Promise< ListResult< Term > > {
	const query: QueryParams = {
		search: params.search || undefined,
		include: params.include?.length ? params.include.join( ',' ) : undefined,
		page: params.page ?? 1,
		per_page: params.perPage ?? 50,
	};
	const response = await request< { items: Term[]; total: number; totalPages: number } >( {
		path: addQueryArgs( `${ OWN }/terms/${ taxonomy }`, query ),
		...listMode( options ),
	} );

	return { items: response.items ?? [], total: response.total ?? 0, totalPages: response.totalPages ?? 1 };
}

export async function getLog( params: LogQuery, options?: RequestOptions ): Promise< ListResult< LogRow > > {
	const response = await request< { items: LogRow[]; total: number; totalPages: number } >( {
		path: addQueryArgs( `${ OWN }/log`, params as QueryParams ),
		...listMode( options ),
	} );

	return { items: response.items ?? [], total: response.total ?? 0, totalPages: response.totalPages ?? 1 };
}

/** `GET /log/users`: who has log rows, for the History screen's User filter. */
export async function getLogUsers( options?: RequestOptions ): Promise< Array< { id: number; name: string } > > {
	const users = await request< Array< { id: number; name: string } > >( { path: `${ OWN }/log/users`, ...listMode( options ) } );

	return Array.isArray( users ) ? users : [];
}

export async function getLogBatches( params: { page?: number; perPage?: number; batch?: string; user?: number; source?: string; since?: string; until?: string; search?: string } = {}, options?: RequestOptions ): Promise< ListResult< LogBatch > > {
	const { page, perPage, ...filters } = params;
	const response = await request< { items: LogBatch[]; total: number; totalPages: number } >( {
		path: addQueryArgs( `${ OWN }/log/batches`, { page: page ?? 1, per_page: perPage ?? 20, ...Object.fromEntries( Object.entries( filters ).filter( ( [ , value ] ) => value !== undefined && value !== '' ) ) } ),
		...listMode( options ),
	} );

	return { items: response.items ?? [], total: response.total ?? 0, totalPages: response.totalPages ?? 1 };
}

/** `GET /log/batch/{id}`: what a revert of the batch would write, cut into the chunks to post (docs/contracts.md §3.5). */
export interface RevertPlan {
	batch_id: string;
	/** Log rows in the batch. */
	rows: number;
	/** Objects a revert writes. */
	objects: number;
	chunk: number;
	/** Object ids in write order, `chunk` per entry; one POST each. */
	chunks: number[][];
	/** Rows that are not reverted (trash, delete, duplicate, masked values; `action: 'failed'` for rows that failed when made). */
	skipped: Array< { id: number; object_type: 'product' | 'variation'; action: string } >;
	/** Rows of the batch that failed when they were made: nothing to put back. */
	failed?: number;
	/** Items the batch left unwritten (status `skipped`): nothing to put back. */
	left_out?: number;
	/** `left_out` by reason: `{ unchanged: 5 }`. */
	left_out_reasons?: Record< string, number >;
	/** The latest revert of this batch, or null. */
	reverted_by?: RevertedBy | null;
	/** Distinct users with rows in the batch; more than one makes it not revertable (409 wc_products_list_batch_shared). */
	users?: number;
	revertable: boolean;
}

export async function getRevertPlan( batchId: string, options?: RequestOptions ): Promise< RevertPlan > {
	const plan = await request< RevertPlan >( { path: `${ OWN }/log/batch/${ encodeURIComponent( batchId ) }`, ...listMode( options ) } );

	return { ...plan, chunks: Array.isArray( plan.chunks ) ? plan.chunks : [], skipped: Array.isArray( plan.skipped ) ? plan.skipped : [] };
}

/** `GET /log/batch/{id}/check`: a dry run of the revert's conflict check (nothing written). */
export interface RevertCheck {
	batch_id: string;
	checked: number;
	objects: number;
	/** Whether every object of the batch was checked (false: only the first chunk, or the given ids). */
	complete: boolean;
	/** Objects changed again since the batch: a revert leaves them as they are. */
	changed: number;
	/** Of those, the ones an earlier revert of this batch already put back. */
	already_reverted: number;
	items: ActionResult[];
}

export async function checkRevert( batchId: string, options?: RequestOptions & { ids?: number[] } ): Promise< RevertCheck > {
	const response = await request< RevertCheck >( {
		path: addQueryArgs( `${ OWN }/log/batch/${ encodeURIComponent( batchId ) }/check`, options?.ids?.length ? { ids: options.ids } : {} ),
		...listMode( options ),
	} );

	return { ...response, items: Array.isArray( response.items ) ? response.items : [] };
}

export interface RevertOptions extends RequestOptions {
	fields?: string[];
	/** One chunk of `RevertPlan.chunks`; without it the whole batch, which the server refuses above `chunk` objects. */
	ids?: number[];
	/** The batch id every chunk of one revert is logged under (`revert_batch_id`). */
	revertBatchId?: string;
	/** Also put back fields changed again since the batch (otherwise reported as `conflict`). */
	force?: boolean;
	/** Take the batch's change off the current value for relative fields (stock), keeping changes made since. */
	relative?: boolean;
}

/** `POST /log/batch/{id}/revert`: the whole batch, or one chunk of it (`ids`). Conflicting objects come back as results with `code: 'conflict'`. */
export async function revertBatch( batchId: string, options?: RevertOptions ): Promise< ActionResponse > {
	const data: Record< string, unknown > = {};

	if ( options?.ids?.length ) {
		data.ids = options.ids;
	}

	if ( options?.revertBatchId ) {
		data.revert_batch_id = options.revertBatchId;
	}

	if ( options?.force ) {
		data.force = true;
	}

	if ( options?.relative ) {
		data.relative = true;
	}

	const response = await request< ActionResponse >( {
		path: addQueryArgs( `${ OWN }/log/batch/${ encodeURIComponent( batchId ) }/revert`, options?.fields?.length ? { fields: options.fields.join( ',' ) } : {} ),
		method: 'POST',
		data,
		...listMode( { ...options, source: options?.source ?? 'quick' } ),
	} );

	return { ...response, items: ( response.items ?? [] ).map( ( raw ) => toRow( raw as RawProduct ) ) };
}

/** Why the app left an item out of a save (POST /log/skipped `reason`). */
export type SkipReason = 'trashed' | 'deleted' | 'conflict' | 'no_stock_management' | 'has_sale' | 'no_sale_price' | 'below_zero' | 'not_applicable' | 'unchanged' | 'other';

export interface SkippedItem {
	id: number;
	reason: SkipReason;
	/** The write paths the item would have changed. */
	fields?: string[];
	message?: string;
}

/** Items one POST /log/skipped takes. */
export const SKIPPED_CHUNK = 100;

/**
 * `POST /log/skipped`: record the items a save left out as `skipped` rows
 * of its batch, so History says why they kept their value. Chunked by 100;
 * never throws (the audit trail must not break a save that worked).
 */
export async function logSkipped( batchId: string, source: WriteSource | 'revert', items: SkippedItem[] ): Promise< void > {
	for ( let index = 0; index < items.length; index += SKIPPED_CHUNK ) {
		const chunk = items.slice( index, index + SKIPPED_CHUNK ).map( ( item ) => ( {
			id: item.id,
			reason: item.reason,
			...( item.fields?.length ? { fields: item.fields.slice( 0, 50 ) } : {} ),
			...( item.message ? { message: item.message.slice( 0, 500 ) } : {} ),
		} ) );

		try {
			await request( { path: `${ OWN }/log/skipped`, method: 'POST', data: { batch_id: batchId, source, items: chunk } } );
		} catch ( error ) {
			console.warn( '[wc-products-list] log/skipped', error );
		}
	}
}
