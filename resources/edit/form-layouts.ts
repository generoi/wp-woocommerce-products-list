/**
 * The inline edit form: a tab strip (General, one tab per extension group
 * such as a language) with labelled groups per field `edit.group`, laid
 * out in up to three columns like WooCommerce's quick edit, derived from
 * the fields themselves so extension fields land in the right place without
 * code. `wcProductsList.quickEdit.tabs` and `.layout` can reshape both.
 */
import { applyFilters } from '@wordpress/hooks';
import { __ } from '@wordpress/i18n';
import type { Form, FormField } from '../dataviews';
import { getQuickEditTabs } from '../extensions/api';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, ProductListItem, QuickEditTab, Settings } from '../types';
import { SCHEDULE_SALE_FIELD_ID } from './payload';

export const GENERAL_TAB_ID = 'general';

export const GROUP_LABELS: Record< string, string > = {
	general: __( 'General', 'wp-woocommerce-products-list' ),
	pricing: __( 'Pricing', 'wp-woocommerce-products-list' ),
	price: __( 'Pricing', 'wp-woocommerce-products-list' ),
	inventory: __( 'Inventory', 'wp-woocommerce-products-list' ),
	organization: __( 'Organization', 'wp-woocommerce-products-list' ),
	visibility: __( 'Visibility', 'wp-woocommerce-products-list' ),
	shipping: __( 'Shipping', 'wp-woocommerce-products-list' ),
	tax: __( 'Tax', 'wp-woocommerce-products-list' ),
	external: __( 'Buy button', 'wp-woocommerce-products-list' ),
	linked: __( 'Linked products', 'wp-woocommerce-products-list' ),
	content: __( 'Content', 'wp-woocommerce-products-list' ),
	downloads: __( 'Downloads', 'wp-woocommerce-products-list' ),
	advanced: __( 'Advanced', 'wp-woocommerce-products-list' ),
};

/** Card order on the General tab; groups not listed follow in first-seen order. */
export const GROUP_ORDER: readonly string[] = [ 'general', 'pricing', 'price', 'inventory', 'organization', 'visibility', 'shipping', 'tax', 'external', 'linked', 'content', 'downloads', 'advanced' ];

export function groupOf( field: ProductField ): string {
	return field.edit ? field.edit.group || 'general' : 'general';
}

/** The tab a field belongs to: its `edit.tab`, else its group when that is an extension group (`i18n:se`), else General. */
export function tabOf( field: ProductField ): string {
	if ( ! field.edit ) {
		return GENERAL_TAB_ID;
	}

	if ( field.edit.tab ) {
		return field.edit.tab;
	}

	const group = groupOf( field );

	return group.includes( ':' ) ? group : GENERAL_TAB_ID;
}

export function groupLabel( group: string, settings: Settings ): string {
	if ( GROUP_LABELS[ group ] ) {
		return GROUP_LABELS[ group ];
	}

	if ( group.startsWith( 'i18n:' ) ) {
		const lang = group.slice( 'i18n:'.length );

		return settings.languages?.labels[ lang ] ?? lang.toUpperCase();
	}

	return group.charAt( 0 ).toUpperCase() + group.slice( 1 ).replace( /[_-]+/g, ' ' );
}

function orderOf( field: ProductField ): number {
	return field.edit && typeof field.edit.order === 'number' ? field.edit.order : 100;
}

function groupRank( group: string, seen: string[] ): number {
	const index = GROUP_ORDER.indexOf( group );

	return index === -1 ? GROUP_ORDER.length + seen.indexOf( group ) : index;
}

/**
 * The schedule-sale toggle: a virtual boolean beside the sale dates. When
 * the registry does not define one, synthesise it from the date fields so
 * the form can hide the dates until the user asks for a schedule.
 */
export function withScheduleSale( fields: ProductField[] ): ProductField[] {
	if ( fields.some( ( field ) => field.id === SCHEDULE_SALE_FIELD_ID ) ) {
		return fields;
	}

	const from = fields.find( ( field ) => field.id === 'date_on_sale_from' );
	const to = fields.find( ( field ) => field.id === 'date_on_sale_to' );
	const anchor = from ?? to;

	if ( ! anchor || anchor.edit === false ) {
		return fields;
	}

	const toggle: ProductField = {
		id: SCHEDULE_SALE_FIELD_ID,
		label: __( 'Schedule sale', 'wp-woocommerce-products-list' ),
		type: 'boolean',
		productTypes: anchor.productTypes,
		edit: { group: groupOf( anchor ), tab: anchor.edit.tab, bulk: 'default', order: orderOf( anchor ) - 0.5 },
		source: 'core',
		rest: {
			fields: [ 'date_on_sale_from', 'date_on_sale_to' ],
			applies: anchor.rest.applies,
			read: ( item ) => {
				const row = item as { date_on_sale_from?: string | null; date_on_sale_to?: string | null };

				return Boolean( row.date_on_sale_from || row.date_on_sale_to );
			},
		},
	};

	const index = fields.indexOf( anchor );

	return [ ...fields.slice( 0, index ), toggle, ...fields.slice( index ) ];
}

/** Fields of a tab, sorted by group rank then `edit.order`, then registry order. */
export function fieldsOfTab( fields: ProductField[], tab: QuickEditTab ): ProductField[] {
	const explicit = new Set( tab.fields ?? [] );
	const seen: string[] = [];

	fields.forEach( ( field ) => {
		const group = groupOf( field );

		if ( ! seen.includes( group ) ) {
			seen.push( group );
		}
	} );

	return fields
		.map( ( field, index ) => ( { field, index } ) )
		.filter( ( { field } ) => explicit.has( field.id ) || tabOf( field ) === tab.id )
		.sort( ( a, b ) => groupRank( groupOf( a.field ), seen ) - groupRank( groupOf( b.field ), seen ) || orderOf( a.field ) - orderOf( b.field ) || a.index - b.index )
		.map( ( { field } ) => field );
}

/**
 * The tabs for a selection: General first, then one per extension group
 * found on the fields (languages), then registered tabs; empty tabs are
 * dropped; `wcProductsList.quickEdit.tabs` runs last.
 */
export function buildTabs( fields: ProductField[], items: ProductListItem[], settings: Settings ): QuickEditTab[] {
	const tabs = new Map< string, QuickEditTab >();

	tabs.set( GENERAL_TAB_ID, { id: GENERAL_TAB_ID, label: __( 'General', 'wp-woocommerce-products-list' ), order: 0 } );

	for ( const field of fields ) {
		const id = tabOf( field );

		if ( ! tabs.has( id ) ) {
			tabs.set( id, { id, label: groupLabel( id, settings ), order: 100 } );
		}
	}

	for ( const registered of getQuickEditTabs() ) {
		tabs.set( registered.id, { ...tabs.get( registered.id ), ...registered } );
	}

	const list = Array.from( tabs.values() )
		.sort( ( a, b ) => ( a.order ?? 100 ) - ( b.order ?? 100 ) )
		.filter( ( tab ) => tab.id === GENERAL_TAB_ID || fieldsOfTab( fields, tab ).length > 0 );

	const filtered = applyFilters( FILTERS.quickEditTabs, list, items );

	return Array.isArray( filtered ) ? ( filtered as QuickEditTab[] ) : list;
}

export interface LayoutOptions {
	/** Omit the group header when the tab holds a single group (a language tab). */
	collapseSingleGroup?: boolean;
}

/**
 * The General tab's columns, as WooCommerce lays its quick edit out: 1 the
 * product itself (name, slug, status, visibility, featured, menu order,
 * content), 2 how it is organised (terms, shipping class, tax), 3 what it
 * sells for and how it is stocked (SKU, prices, sale schedule, stock,
 * weight and dimensions). Groups not listed go to column 2.
 */
export const COLUMN_OF_GROUP: Record< string, 1 | 2 | 3 > = {
	general: 1,
	visibility: 1,
	content: 1,
	external: 1,
	linked: 1,
	advanced: 1,
	downloads: 1,
	organization: 2,
	tax: 2,
	pricing: 3,
	price: 3,
	inventory: 3,
	shipping: 3,
};

/** Fields whose column differs from their group's. */
export const COLUMN_OF_FIELD: Record< string, 1 | 2 | 3 > = {
	sku: 3,
	global_unique_id: 3,
	shipping_class: 2,
	virtual: 3,
	downloadable: 3,
};

/** The group a column-moved field is shown under (its own group's heading would be out of place in the new column). */
export const LAYOUT_GROUP_OF_FIELD: Record< string, string > = {
	sku: 'inventory',
	global_unique_id: 'inventory',
	virtual: 'inventory',
	downloadable: 'inventory',
	shipping_class: 'shipping',
};

export function columnOf( field: ProductField ): 1 | 2 | 3 {
	return COLUMN_OF_FIELD[ field.id ] ?? COLUMN_OF_GROUP[ groupOf( field ) ] ?? 2;
}

/** The group a field is laid out under in the inline form. */
export function layoutGroupOf( field: ProductField ): string {
	return LAYOUT_GROUP_OF_FIELD[ field.id ] ?? groupOf( field );
}

/** A multi-line control (descriptions): on a language tab these take the second column. */
function isLongText( field: ProductField ): boolean {
	const edit = field.Edit as { control?: string } | undefined;

	return ( field.type as string ) === 'html' || ( typeof edit === 'object' && edit !== null && edit.control === 'textarea' );
}

/** The columns of a tab: the General tab by group and field, other tabs short controls left and long ones right. */
export function columnsOfTab( fields: ProductField[], tab: QuickEditTab ): ProductField[][] {
	const tabFields = fieldsOfTab( fields, tab );

	if ( tab.id === GENERAL_TAB_ID ) {
		const columns: ProductField[][] = [ [], [], [] ];

		for ( const field of tabFields ) {
			columns[ columnOf( field ) - 1 ]!.push( field );
		}

		return columns.filter( ( column ) => column.length > 0 );
	}

	const short = tabFields.filter( ( field ) => ! isLongText( field ) );
	const long = tabFields.filter( isLongText );

	return [ short, long ].filter( ( column ) => column.length > 0 );
}

/** One labelled group per `edit.group` in `column`, in the tab's order; the header is dropped when the tab has one group. */
function groupFields( column: ProductField[], settings: Settings, withHeaders: boolean ): FormField[] {
	const groups = new Map< string, string[] >();
	const seen = column.map( layoutGroupOf ).filter( ( group, index, all ) => all.indexOf( group ) === index );
	const ordered = [ ...column ].sort( ( a, b ) => groupRank( layoutGroupOf( a ), seen ) - groupRank( layoutGroupOf( b ), seen ) );

	for ( const field of ordered ) {
		const group = layoutGroupOf( field );
		const ids = groups.get( group ) ?? [];

		ids.push( field.id );
		groups.set( group, ids );
	}

	return Array.from( groups.entries() ).map( ( [ group, children ] ) => ( {
		id: `group:${ group }`,
		...( withHeaders ? { label: groupLabel( group, settings ) } : {} ),
		layout: { type: 'regular', labelPosition: 'top' },
		children,
	} ) );
}

/**
 * The DataForm layout of a tab for the inline editor: the groups of
 * `columnsOfTab` side by side (DataForm's row layout, each column a
 * regular group of its labelled groups), or a single column when the tab
 * has one. `wcProductsList.quickEdit.layout` runs last.
 */
export function buildInlineForm( fields: ProductField[], tab: QuickEditTab, items: ProductListItem[], settings: Settings, options: LayoutOptions = {} ): Form {
	const tabFields = fieldsOfTab( fields, tab );
	const groupCount = new Set( tabFields.map( groupOf ) ).size;
	const withHeaders = ! ( groupCount === 1 && options.collapseSingleGroup !== false && tab.id !== GENERAL_TAB_ID );
	const columns = columnsOfTab( fields, tab );

	let formFields: FormField[];

	if ( columns.length <= 1 ) {
		formFields = groupFields( columns[ 0 ] ?? [], settings, withHeaders );
	} else {
		const styles: Record< string, { flex?: string } > = {};
		const children: FormField[] = columns.map( ( column, index ) => {
			const id = `column:${ index + 1 }`;

			styles[ id ] = { flex: '1 1 0' };

			return { id, layout: { type: 'regular', labelPosition: 'top' }, children: groupFields( column, settings, withHeaders ) };
		} );

		formFields = [ { id: 'columns', layout: { type: 'row', alignment: 'start', styles }, children } ];
	}

	const form: Form = {
		layout: { type: 'regular', labelPosition: 'top' },
		fields: formFields,
	};

	const filtered = applyFilters( FILTERS.quickEditLayout, form, tab, items );

	return filtered && typeof filtered === 'object' ? ( filtered as Form ) : form;
}

