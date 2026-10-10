/**
 * DataViews fields over LogRow, shared by the History screen and the
 * per-row history modal. Filtering and sorting happen on the server
 * (`GET /log`), so fields only declare which operators map to a param.
 */
import { __ } from '@wordpress/i18n';
import type { Field } from '../dataviews';
import { formatPrice } from '../fields/currency';
import { formatSiteDate } from '../fields/site-date';
import { logFieldLabel } from '../fields/log-labels';
import type { LogFieldOption } from '../fields/log-labels';
import type { Settings } from '../types';
import type { LogQuery, LogRow } from './use-log';

export const SOURCE_OPTIONS = [
	{ value: 'quick', label: __( 'Quick edit', 'wp-woocommerce-products-list' ) },
	{ value: 'bulk', label: __( 'Bulk edit', 'wp-woocommerce-products-list' ) },
	{ value: 'action', label: __( 'Action', 'wp-woocommerce-products-list' ) },
	{ value: 'extension', label: __( 'Extension', 'wp-woocommerce-products-list' ) },
	{ value: 'revert', label: __( 'Revert', 'wp-woocommerce-products-list' ) },
	{ value: 'i18n', label: __( 'Translations', 'wp-woocommerce-products-list' ) },
];

export const ACTION_OPTIONS = [
	{ value: 'update', label: __( 'Update', 'wp-woocommerce-products-list' ) },
	{ value: 'trash', label: __( 'Trash', 'wp-woocommerce-products-list' ) },
	{ value: 'restore', label: __( 'Restore', 'wp-woocommerce-products-list' ) },
	{ value: 'delete', label: __( 'Delete', 'wp-woocommerce-products-list' ) },
	{ value: 'duplicate', label: __( 'Duplicate', 'wp-woocommerce-products-list' ) },
	{ value: 'translate_term', label: __( 'Translate attribute term', 'wp-woocommerce-products-list' ) },
];

/**
 * The actions History names: the core ones, then the extension actions the
 * server declares (gds-woo-i18n's `i18n_transform` is "Edit translated text"),
 * so the log never shows an action's key.
 */
export function actionOptions( settings?: Pick< Settings, 'actions' > | null ): Array< { value: string; label: string } > {
	const known = new Set( ACTION_OPTIONS.map( ( option ) => option.value ) );
	const declared = ( settings?.actions ?? [] ).filter( ( def ) => def.id && ! known.has( def.id ) ).map( ( def ) => ( { value: def.id, label: def.label || humanizeKey( def.id ) } ) );

	return [ ...ACTION_OPTIONS, ...declared ];
}

/** `i18n_transform` → "I18n transform": the last resort for an action nothing declares any more. */
function humanizeKey( key: string ): string {
	const words = key.replace( /[_-]+/g, ' ' ).trim();

	return words ? words.charAt( 0 ).toUpperCase() + words.slice( 1 ) : key;
}

/** The label of a logged action key. */
export function actionLabel( action: string, settings?: Pick< Settings, 'actions' > | null ): string {
	return actionOptions( settings ).find( ( option ) => option.value === action )?.label ?? humanizeKey( action );
}

/** The `/log` params; `search` matches product names, values and messages. */
export type LogQueryWithSearch = LogQuery;

function text( value: string | null ): string {
	if ( value === null || value === undefined ) {
		return '—';
	}

	if ( value === '' ) {
		return __( '(empty)', 'wp-woocommerce-products-list' );
	}

	// Values are JSON-encoded when they were not scalar.
	if ( value.startsWith( '[' ) || value.startsWith( '{' ) ) {
		try {
			const parsed: unknown = JSON.parse( value );

			if ( Array.isArray( parsed ) ) {
				return parsed.map( ( entry ) => ( typeof entry === 'object' && entry !== null && 'name' in entry ? String( ( entry as { name: unknown } ).name ) : String( entry ) ) ).join( ', ' ) || __( '(none)', 'wp-woocommerce-products-list' );
			}
		} catch {
			// Not JSON after all; show as is.
		}
	}

	return value;
}

const PRICE_KEY = /^(?:i18n\.([A-Za-z_-]+)\.)?(?:regular_price|sale_price|price)$/;
const DATE_KEY = /^date_on_sale_(?:from|to)(?:_gmt)?$/;

/**
 * A logged value as the shop shows it: prices in the shop's format, or in
 * the language's own currency for `i18n.<lang>.*_price` (kr, not €), sale
 * dates in the site's date format. Anything else as text().
 */
export function formatLogValue( field: string, value: string | null, settings: Settings | null ): string {
	if ( ! settings || value === null || value === undefined || value === '' || ! field ) {
		return text( value );
	}

	const price = PRICE_KEY.exec( field );

	if ( price && /^-?\d+(\.\d+)?$/.test( value ) ) {
		const lang = price[ 1 ];
		const code = lang ? settings.languages?.currencies?.[ lang ] : undefined;

		if ( code ) {
			try {
				return new Intl.NumberFormat( ( settings.locale || 'en' ).replace( '_', '-' ), { style: 'currency', currency: code } ).format( Number( value ) );
			} catch {
				return `${ value } ${ code }`;
			}
		}

		return formatPrice( value, settings ) || value;
	}

	if ( DATE_KEY.test( field ) && /^\d{4}-\d{2}-\d{2}/.test( value ) ) {
		try {
			// Logged in site wall-clock time (wc/v3 input shape): shown as the site's time, never shifted by the browser's zone.
			return formatSiteDate( `${ settings.dateFormat } ${ settings.timeFormat }`, value.replace( ' ', 'T' ).replace( /([+-]\d{2}:\d{2}|Z)$/, '' ), undefined, settings );
		} catch {
			return value;
		}
	}

	return text( value );
}

/** Settings for the change cell's formatting; set by createLogFields (the cell is a plain render function). */
let cellSettings: Settings | null = null;

export function ChangeCell( { item }: { item: LogRow } ) {
	if ( item.action === 'duplicate' ) {
		const copy = item.related;
		const label = copy ? copy.name || `#${ copy.id }` : item.new_value ? `#${ item.new_value }` : null;

		return (
			<span className="wc-pl-history__change">
				{ __( 'Copied to', 'wp-woocommerce-products-list' ) }{ ' ' }
				{ copy?.edit_link ? <a href={ copy.edit_link }>{ label }</a> : label ? <span>{ label }</span> : <span>{ __( '(the copy no longer exists)', 'wp-woocommerce-products-list' ) }</span> }
			</span>
		);
	}

	// A failed write with several fields keeps what it tried in context; one field keeps it in old/new.
	if ( item.action !== 'update' && ! item.field ) {
		return <span className="wc-pl-history__change">{ item.message || actionLabel( item.action, cellSettings ) }</span>;
	}

	if ( ( item.status === 'skipped' || ( ! item.field && item.status === 'error' ) ) && item.old_value === null && item.new_value === null ) {
		return <span className="wc-pl-history__change">—</span>;
	}

	const before = formatLogValue( item.field, item.old_value, cellSettings );
	const after = formatLogValue( item.field, item.new_value, cellSettings );

	return (
		<span className="wc-pl-history__change" title={ `${ before } → ${ after }` }>
			<del className="wc-pl-history__value">{ before }</del>
			<span aria-hidden="true">→</span>
			<ins className="wc-pl-history__value" style={ { textDecoration: 'none' } }>
				{ after }
			</ins>
			{ item.status === 'error' ? <span className="screen-reader-text">{ __( '(attempted, not saved)', 'wp-woocommerce-products-list' ) }</span> : null }
		</span>
	);
}

export interface LogFieldOptions {
	withObject?: boolean;
	/** The users with log rows (`GET /log/users`); when given, the User column filters by them. */
	users?: Array< { id: number; name: string } >;
	/** Labels of the logged field keys (fields/log-labels.ts); the Field column shows and filters by them. */
	fieldOptions?: LogFieldOption[];
}

export function createLogFields( settings: Settings, options: LogFieldOptions = {} ): Field< LogRow >[] {
	const users = options.users ?? [];
	const fieldOptions = options.fieldOptions ?? [];
	cellSettings = settings;
	const fields: Field< LogRow >[] = [
		{
			id: 'created_at',
			type: 'datetime',
			label: __( 'Time', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			enableHiding: false,
			filterBy: { operators: [ 'after', 'before' ] },
			format: { datetime: `${ settings.dateFormat } ${ settings.timeFormat }` },
		},
		{
			id: 'user',
			type: 'text',
			label: __( 'User', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			// The id is the filter value (the `user` param); the name is what the cell shows.
			getValue: ( { item } ) => ( users.length ? String( item.user?.id ?? '' ) : item.user?.name ?? '' ),
			render: ( { item } ) => <span>{ item.user?.name || ( item.user?.id ? `#${ item.user.id }` : '—' ) }</span>,
			...( users.length
				? {
						elements: users.map( ( user ) => ( { value: String( user.id ), label: user.name || `#${ user.id }` } ) ),
						filterBy: { operators: [ 'is' ] },
				  }
				: { filterBy: false } ),
		},
	];

	if ( options.withObject !== false ) {
		fields.push(
			{
				id: 'object',
				type: 'text',
				label: __( 'Item', 'wp-woocommerce-products-list' ),
				enableSorting: false,
				enableHiding: false,
				filterBy: false,
				getValue: ( { item } ) => item.object_name || `#${ item.object_id }`,
				render: ( { item } ) => {
					const label = item.object_name || `#${ item.object_id }`;
					const kind =
						item.object_type === 'variation'
							? ` (${ __( 'variation', 'wp-woocommerce-products-list' ) })`
							: item.object_type === 'term'
							? ` (${ __( 'attribute term', 'wp-woocommerce-products-list' ) })`
							: '';

					return item.edit_link ? (
						<a href={ item.edit_link }>
							{ label }
							{ kind }
						</a>
					) : (
						<span>
							{ label }
							{ kind }
						</span>
					);
				},
			},
			{
				id: 'object_id',
				type: 'integer',
				label: __( 'Item ID', 'wp-woocommerce-products-list' ),
				enableSorting: false,
				filterBy: { operators: [ 'is' ] },
				// An id, not a quantity: 40561, never 40,561.
				render: ( { item } ) => <span>{ String( item.object_id ) }</span>,
			}
		);
	}

	fields.push(
		{
			id: 'source',
			type: 'text',
			label: __( 'Source', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			elements: SOURCE_OPTIONS,
			filterBy: { operators: [ 'is' ] },
		},
		{
			id: 'action',
			type: 'text',
			label: __( 'Action', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			elements: actionOptions( settings ),
			filterBy: { operators: [ 'is' ] },
			getValue: ( { item } ) => item.action,
			render: ( { item } ) => <span>{ actionLabel( item.action, settings ) }</span>,
		},
		{
			id: 'field',
			type: 'text',
			label: __( 'Field', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			...( fieldOptions.length ? { elements: fieldOptions } : {} ),
			filterBy: { operators: [ 'is' ] },
			getValue: ( { item } ) => item.field ?? '',
			render: ( { item } ) => {
				const keys = item.field ? [ item.field ] : item.skipped_fields ?? [];
				const labels = keys.map( ( key ) => logFieldLabel( key, fieldOptions ) || key );

				return <span title={ keys.join( ', ' ) }>{ labels.join( ', ' ) || '—' }</span>;
			},
		},
		{
			id: 'change',
			type: 'text',
			label: __( 'Change', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			enableHiding: false,
			filterBy: false,
			getValue: ( { item } ) => item.new_value ?? '',
			render: ChangeCell,
		},
		{
			id: 'status',
			type: 'text',
			label: __( 'Result', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			getValue: ( { item } ) => item.status,
			// The reason is text in the cell, not a tooltip: readable without a mouse.
			render: ( { item } ) =>
				item.status === 'ok' ? (
					<span>{ __( 'OK', 'wp-woocommerce-products-list' ) }</span>
				) : item.status === 'skipped' ? (
					<span className="wc-pl-history__skipped">{ item.message || __( 'Skipped.', 'wp-woocommerce-products-list' ) }</span>
				) : (
					<span className="wc-pl-history__error">
						<strong>{ __( 'Error', 'wp-woocommerce-products-list' ) }</strong>
						{ item.message ? `: ${ item.message }` : '' }
					</span>
				),
		},
		{
			id: 'batch_id',
			type: 'text',
			label: __( 'Batch', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: { operators: [ 'is' ] },
			getValue: ( { item } ) => item.batch_id,
			render: ( { item } ) => <code title={ item.batch_id }>{ item.batch_id.slice( 0, 8 ) }</code>,
		}
	);

	return fields;
}

/** Translate the DataViews view (filters, page) into the `/log` params. */
export function logQueryFromView(
	view: { page?: number; perPage?: number; search?: string; filters?: Array< { field: string; operator: string; value: unknown } > },
	base: Partial< LogQuery > = {}
): LogQueryWithSearch {
	const query: LogQueryWithSearch = { ...base, page: view.page ?? 1, per_page: view.perPage ?? 50 };

	// A product name (or a value, a message): the server matches the names of the products the rows are about.
	if ( view.search && view.search.trim() !== '' ) {
		query.search = view.search.trim();
	}

	for ( const filter of view.filters ?? [] ) {
		const value = Array.isArray( filter.value ) ? filter.value[ 0 ] : filter.value;

		if ( value === undefined || value === null || value === '' ) {
			continue;
		}

		switch ( filter.field ) {
			case 'created_at':
				if ( filter.operator === 'after' ) {
					query.since = String( value );
				} else if ( filter.operator === 'before' ) {
					query.until = String( value );
				}
				break;
			case 'object_id':
				query.object_id = Number( value );
				break;
			case 'source':
				query.source = String( value );
				break;
			case 'action':
				query.action = String( value );
				break;
			case 'field':
				query.field = String( value );
				break;
			case 'batch_id':
				query.batch = String( value );
				break;
			case 'user':
				query.user = Number( value );
				break;
			default:
				break;
		}
	}

	return query;
}
