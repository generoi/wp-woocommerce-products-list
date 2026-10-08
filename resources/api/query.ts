/**
 * View → wc/v3 query params. Pure: tests cover it, nothing here touches
 * the network. docs/contracts.md §3.1 lists the params the server maps.
 */
import { applyFilters } from '@wordpress/hooks';
import type { Filter, View } from '../dataviews';
import { getQueryParamCallbacks } from '../extensions/api';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, QueryParams, Settings } from '../types';

/** Always requested: the row meta the hierarchy and actions need. */
export const CORE_REQUEST_FIELDS = [ 'id', 'type', 'status', 'parent_id', 'wc_products_list' ] as const;

/** Statuses the "All" tab shows (never trash). */
export const ALL_STATUSES = [ 'publish', 'draft', 'pending', 'private', 'future' ] as const;

/** wc/v3 `orderby` values the server accepts out of the box or through `Rest\ListQuery`. */
const SORT_PARAMS: Record< string, string > = {
	id: 'id',
	name: 'title',
	title: 'title',
	slug: 'slug',
	date_created: 'date',
	date_modified: 'modified',
	price: 'price',
	menu_order: 'menu_order',
	sku: 'sku',
	stock_quantity: 'stock_quantity',
};

/** `isNot`/`isNone` counterparts of the include params. */
const EXCLUDE_PARAMS: Record< string, string > = {
	category: 'exclude_category',
	tag: 'exclude_tag',
	include_types: 'exclude_types',
	type: 'exclude_types',
	include_status: 'exclude_status',
	status: 'exclude_status',
	include: 'exclude',
};

/** `min_`/`max_` twins of the range params. */
const RANGE_PARAMS: Record< string, [ string, string ] > = {
	price: [ 'min_price', 'max_price' ],
	stock_quantity: [ 'min_stock_quantity', 'max_stock_quantity' ],
	date_created: [ 'after', 'before' ],
	date_modified: [ 'modified_after', 'modified_before' ],
};

type ElementWithParams = { value: unknown; params?: Record< string, unknown > };

/** Declarative fields carry their own mapping (extensions/declarative.ts). */
type WithToParams = { rest: { toParams?: ( value: unknown, operator: Filter[ 'operator' ] ) => QueryParams } };

function csv( value: unknown ): string | undefined {
	const list = ( Array.isArray( value ) ? value : [ value ] ).filter( ( v ) => v !== undefined && v !== null && v !== '' );

	return list.length ? list.map( String ).join( ',' ) : undefined;
}

function scalar( value: unknown ): string | number | boolean | undefined {
	if ( Array.isArray( value ) ) {
		return value.length ? String( value[ 0 ] ) : undefined;
	}

	if ( value === undefined || value === null || value === '' ) {
		return undefined;
	}

	return value as string | number | boolean;
}

/** Elements may carry their own params (declarative filters); those win over `{[param]: value}`. */
function elementParams( field: ProductField, value: unknown ): Record< string, unknown > | undefined {
	const elements = ( field.elements ?? [] ) as ElementWithParams[];
	const values = Array.isArray( value ) ? value : [ value ];
	const merged: Record< string, unknown > = {};
	let found = false;

	for ( const v of values ) {
		const element = elements.find( ( e ) => e.value === v || String( e.value ) === String( v ) );

		if ( element?.params ) {
			found = true;
			Object.assign( merged, element.params );
		}
	}

	return found ? merged : undefined;
}

/** The params one DataViews filter becomes. */
export function filterToParams( filter: Filter, field: ProductField | undefined ): QueryParams {
	if ( ! field ) {
		return {};
	}

	const toParams = ( field as unknown as WithToParams ).rest.toParams;

	if ( typeof toParams === 'function' ) {
		return toParams( filter.value, filter.operator );
	}

	const fromElements = elementParams( field, filter.value );

	if ( fromElements ) {
		return fromElements as QueryParams;
	}

	const param = field.rest.param;

	if ( ! param ) {
		return {};
	}

	switch ( filter.operator ) {
		case 'is':
		case 'isAny':
		case 'isAll':
		case 'contains':
		case 'startsWith': {
			if ( field.type === 'boolean' ) {
				const v = scalar( filter.value );

				return v === undefined ? {} : { [ param ]: v === true || v === 'true' || v === '1' || v === 1 };
			}

			const v = csv( filter.value );

			return v === undefined ? {} : { [ param ]: v };
		}
		case 'isNot':
		case 'isNone':
		case 'isNotAll':
		case 'notContains': {
			if ( field.type === 'boolean' ) {
				const v = scalar( filter.value );

				return v === undefined ? {} : { [ param ]: ! ( v === true || v === 'true' || v === '1' || v === 1 ) };
			}

			const exclude = EXCLUDE_PARAMS[ param ];
			const v = csv( filter.value );

			return exclude && v !== undefined ? { [ exclude ]: v } : {};
		}
		case 'greaterThan':
		case 'greaterThanOrEqual':
		case 'after':
		case 'afterInc': {
			const [ min ] = RANGE_PARAMS[ param ] ?? [ `min_${ param }` ];
			const v = scalar( filter.value );

			return v === undefined ? {} : { [ min ]: v };
		}
		case 'lessThan':
		case 'lessThanOrEqual':
		case 'before':
		case 'beforeInc': {
			const [ , max ] = RANGE_PARAMS[ param ] ?? [ `min_${ param }`, `max_${ param }` ];
			const v = scalar( filter.value );

			return v === undefined ? {} : { [ max ]: v };
		}
		case 'between': {
			const [ min, max ] = RANGE_PARAMS[ param ] ?? [ `min_${ param }`, `max_${ param }` ];
			const [ from, to ] = Array.isArray( filter.value ) ? filter.value : [ undefined, undefined ];
			const out: QueryParams = {};

			if ( from !== undefined && from !== '' ) {
				out[ min ] = from;
			}

			if ( to !== undefined && to !== '' ) {
				out[ max ] = to;
			}

			return out;
		}
		default: {
			const v = csv( filter.value );

			return v === undefined ? {} : { [ param ]: v };
		}
	}
}

/** The `_fields` for a view: the fixed core set plus what the visible columns read. */
export function fieldsParam( view: View, fields: ProductField[] ): string {
	const visible = new Set< string >( [ ...CORE_REQUEST_FIELDS ] );
	const ids = new Set< string >( [
		...( view.fields ?? [] ),
		...( view.titleField ? [ view.titleField ] : [] ),
		...( view.mediaField && view.showMedia !== false ? [ view.mediaField ] : [] ),
		...( view.descriptionField && view.showDescription !== false ? [ view.descriptionField ] : [] ),
		...( ( view as { layout?: { badgeFields?: string[] } } ).layout?.badgeFields ?? [] ),
	] );

	// The title column is always rendered; name is needed even when it is not the title field.
	visible.add( 'name' );

	for ( const field of fields ) {
		if ( ids.has( field.id ) ) {
			field.rest.fields.forEach( ( f ) => visible.add( f ) );
		}
	}

	return Array.from( visible ).sort().join( ',' );
}

/** The `tab` plus the core status params that mean the same thing (works before `Rest\ListQuery` maps `tab`). */
export function tabParams( tab: string ): QueryParams {
	if ( ! tab || tab === 'all' ) {
		return { tab: 'all', include_status: ALL_STATUSES.join( ',' ) };
	}

	return { tab, status: tab };
}

export function sortParams( view: View, fields: ProductField[] ): QueryParams {
	if ( ! view.sort?.field ) {
		return {};
	}

	const field = fields.find( ( f ) => f.id === view.sort?.field );
	const orderby = field?.rest.sortParam ?? SORT_PARAMS[ view.sort.field ];

	if ( ! orderby ) {
		return {};
	}

	return { orderby, order: view.sort.direction === 'asc' ? 'asc' : 'desc' };
}

function clean( params: QueryParams ): QueryParams {
	const out: QueryParams = {};

	for ( const [ key, value ] of Object.entries( params ) ) {
		if ( value !== undefined && value !== null && value !== '' ) {
			out[ key ] = value;
		}
	}

	return out;
}

/**
 * The wc/v3 products list request for a view and status tab. Extension
 * callbacks (`addQueryParams`) run first, then the `wcProductsList.query`
 * filter, both with `{ tab, view, fields }`.
 */
export function buildProductListQuery( view: View, tab: string, fields: ProductField[], settings: Settings ): QueryParams {
	const perPage = Math.max( 1, Math.min( view.perPage ?? 20, settings.limits.perPageMax ) );
	let params: QueryParams = {
		page: Math.max( 1, view.page ?? 1 ),
		per_page: perPage,
		_fields: fieldsParam( view, fields ),
		image_size: 'thumbnail',
		...tabParams( tab ),
		...sortParams( view, fields ),
	};

	if ( view.search?.trim() ) {
		params.search_name_or_sku = view.search.trim();
	}

	for ( const filter of view.filters ?? [] ) {
		Object.assign(
			params,
			filterToParams(
				filter,
				fields.find( ( f ) => f.id === filter.field )
			)
		);
	}

	const context = { tab, view, fields };

	for ( const callback of getQueryParamCallbacks() ) {
		params = callback( params, context );
	}

	return clean( applyFilters( FILTERS.query, params, context ) as QueryParams );
}

/** `_fields` for variation rows: the core set plus the visible fields that exist on variations. */
export function variationFieldsParam( view: View, fields: ProductField[] ): string {
	const ids = new Set< string >( [ ...( view.fields ?? [] ), ...( view.titleField ? [ view.titleField ] : [] ), ...( view.mediaField ? [ view.mediaField ] : [] ) ] );
	const out = new Set< string >( [ ...CORE_REQUEST_FIELDS, 'name', 'attributes', 'image' ] );

	for ( const field of fields ) {
		if ( ids.has( field.id ) && field.rest.applies.variation ) {
			field.rest.fields.forEach( ( f ) => out.add( f === 'images' ? 'image' : f ) );
		}
	}

	return Array.from( out ).sort().join( ',' );
}

export function buildVariationsQuery( parentId: number, page: number, fields: ProductField[], settings: Settings, view?: View ): QueryParams {
	const params: QueryParams = {
		page: Math.max( 1, page ),
		per_page: settings.limits.perPageMax,
		image_size: 'thumbnail',
		_fields: view ? variationFieldsParam( view, fields ) : Array.from( new Set( [ ...CORE_REQUEST_FIELDS, 'name', 'attributes', 'image', ...fields.filter( ( f ) => f.rest.applies.variation ).flatMap( ( f ) => f.rest.fields.map( ( x ) => ( x === 'images' ? 'image' : x ) ) ) ] ) ).sort().join( ',' ),
	};

	return clean( applyFilters( FILTERS.variationsQuery, params, { parentId, page } ) as QueryParams );
}
