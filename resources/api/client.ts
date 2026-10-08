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
import { ApiError, toApiError } from './errors';

export { ApiError } from './errors';

export const LIST_HEADER = 'X-WC-Products-List';
export const BATCH_HEADER = 'X-WC-Products-List-Batch';
export const SOURCE_HEADER = 'X-WC-Products-List-Source';

export type WriteSource = 'quick' | 'bulk' | 'extension';

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
	data?: Record< string, unknown >;
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
	status: 'ok' | 'error';
	message: string;
}

export interface LogBatch {
	batch_id: string;
	created_at: string;
	user: { id: number; name: string };
	source: LogRow[ 'source' ];
	rows: number;
	objects: number;
	fields: string[];
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

/** A GET that keeps the X-WP-Total headers. */
async function list< Raw >( path: string, options?: RequestOptions ): Promise< ListResult< Raw > > {
	const response = await request( { path, parse: false, ...listMode( options ) } );
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
	const result = await list< RawProduct >( addQueryArgs( PRODUCTS, query ), options );

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

/** `products/batch` in sequential chunks of `limits.batchSize`, one batch id. */
export async function batchProducts( update: ProductUpdate[], options?: RequestOptions ): Promise< BatchResponse< RawProduct > > {
	const batchId = options?.batchId ?? newBatchId();
	let result: BatchResponse< RawProduct > = { update: [] };

	for ( const part of chunk( update, getSettings().limits.batchSize ) ) {
		const response = await request< BatchResponse< RawProduct > >( {
			path: `${ PRODUCTS }/batch`,
			method: 'POST',
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
	options?: RequestOptions
): Promise< BatchResponse< RawVariation > > {
	const batchId = options?.batchId ?? newBatchId();
	let result: BatchResponse< RawVariation > = { update: [] };

	for ( const part of chunk( update, getSettings().limits.batchSize ) ) {
		const response = await request< BatchResponse< RawVariation > >( {
			path: `${ PRODUCTS }/${ parentId }/variations/batch`,
			method: 'POST',
			data: { update: part },
			...listMode( { ...options, batchId } ),
		} );
		result = mergeBatch( result, response );
	}

	return result;
}

/** `POST /actions/{action}` in chunks of `limits.actionBatchSize`, one batch id. */
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

	for ( const part of chunk( ids, getSettings().limits.actionBatchSize ) ) {
		const response = await request< ActionResponse >( {
			path,
			method: 'POST',
			data: { ids: part, args },
			...listMode( { ...options, batchId } ),
		} );
		result.results.push( ...( response.results ?? [] ) );
		result.items.push( ...( response.items ?? [] ).map( ( raw ) => toRow( raw as RawProduct ) ) );
	}

	return result;
}

export async function getCounts( options?: RequestOptions ): Promise< Record< string, number > > {
	return request< Record< string, number > >( { path: `${ OWN }/counts`, ...listMode( options ) } );
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

export async function getLogBatches( params: { page?: number; perPage?: number } = {} ): Promise< ListResult< LogBatch > > {
	const response = await request< { items: LogBatch[]; total: number; totalPages: number } >( {
		path: addQueryArgs( `${ OWN }/log/batches`, { page: params.page ?? 1, per_page: params.perPage ?? 20 } ),
	} );

	return { items: response.items ?? [], total: response.total ?? 0, totalPages: response.totalPages ?? 1 };
}

export async function revertBatch( batchId: string, options?: RequestOptions & { fields?: string[] } ): Promise< ActionResponse > {
	const response = await request< ActionResponse >( {
		path: addQueryArgs( `${ OWN }/log/batch/${ encodeURIComponent( batchId ) }/revert`, options?.fields?.length ? { fields: options.fields.join( ',' ) } : {} ),
		method: 'POST',
		...listMode( { ...options, source: options?.source ?? 'quick' } ),
	} );

	return { ...response, items: ( response.items ?? [] ).map( ( raw ) => toRow( raw as RawProduct ) ) };
}
