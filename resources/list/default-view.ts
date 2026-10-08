/**
 * What a first-time user sees: a table with the name as title, the first
 * image as media, and the columns a shop manager scans a catalog by.
 * Extensions change it through `wcProductsList.defaultView` (gds-woo-i18n
 * adds a "Name (Svenska)" column, for instance).
 */
import { applyFilters } from '@wordpress/hooks';
import type { SupportedLayouts, View } from '../dataviews';
import { FILTERS } from '../extensions/hooks';
import type { ColumnStyle, ProductField, Settings } from '../types';

export const PER_PAGE_SIZES = [ 20, 50, 100 ];

export const DEFAULT_PER_PAGE = 20;

/**
 * Money and stock before the wide taxonomy column, so they stay on screen at
 * laptop widths. The type is a filter and a chevron away (a variable product
 * shows its count); it is not a default column, so the table with one
 * translation column fits 1366–1568 px without a horizontal scrollbar.
 */
export const DEFAULT_TABLE_FIELDS = [ 'sku', 'price', 'stock_status', 'status', 'categories', 'date_created' ];

/** The core columns' widths (`view.layout.styles`); extension columns bring their own (`ProductField.columnStyle`). */
export const CORE_COLUMN_STYLES: Record< string, ColumnStyle > = {
	name: { minWidth: 280 },
	images: { width: 56 },
	status: { width: 110 },
	type: { width: 100 },
	sku: { width: 120 },
	stock_status: { width: 130 },
	price: { width: 130, align: 'end' },
	categories: { maxWidth: 260 },
	tags: { maxWidth: 220 },
	brands: { maxWidth: 200 },
	date_created: { width: 110 },
	date_modified: { width: 110 },
};

/**
 * The column styles for a field list: the core widths plus every extension
 * field's `columnStyle`, so a translation column opened from the picker is
 * as wide as the name it translates instead of the hundred pixels DataViews
 * gives a column it knows nothing about.
 */
export function columnStyles( fields: ProductField[] ): Record< string, ColumnStyle > {
	const styles: Record< string, ColumnStyle > = { ...CORE_COLUMN_STYLES };

	for ( const field of fields ) {
		if ( field.columnStyle && ! styles[ field.id ] ) {
			styles[ field.id ] = field.columnStyle;
		}
	}

	return styles;
}

export const DEFAULT_LAYOUTS: SupportedLayouts = {
	table: {
		titleField: 'name',
		mediaField: 'images',
		showMedia: true,
		layout: {
			density: 'balanced',
			styles: CORE_COLUMN_STYLES,
		},
	},
	grid: {
		titleField: 'name',
		mediaField: 'images',
		showMedia: true,
		layout: { badgeFields: [ 'status', 'stock_status' ], previewSize: 160 },
	},
	list: {
		titleField: 'name',
		mediaField: 'images',
		descriptionField: 'sku',
		showMedia: true,
	},
};

/** @param fields The field list, for the extension columns' default widths. */
export function createDefaultView( settings: Settings, fields: ProductField[] = [] ): View {
	const table = DEFAULT_LAYOUTS.table && DEFAULT_LAYOUTS.table !== true ? DEFAULT_LAYOUTS.table.layout : undefined;
	const view: View = {
		type: 'table',
		page: 1,
		perPage: DEFAULT_PER_PAGE,
		search: '',
		filters: [],
		sort: { field: 'date_created', direction: 'desc' },
		titleField: 'name',
		mediaField: 'images',
		showMedia: true,
		showTitle: true,
		fields: [ ...DEFAULT_TABLE_FIELDS ],
		layout: table ? { ...table, styles: columnStyles( fields ) } : undefined,
	};

	return applyFilters( FILTERS.defaultView, view, settings ) as View;
}

/** The status tabs, in WordPress order; `all` first, `trash` last. */
export const STATUS_TAB_IDS = [ 'all', 'publish', 'future', 'draft', 'pending', 'private', 'trash' ] as const;

export type StatusTabId = ( typeof STATUS_TAB_IDS )[ number ];

export function isStatusTab( value: unknown ): value is StatusTabId {
	return typeof value === 'string' && ( STATUS_TAB_IDS as readonly string[] ).includes( value );
}
