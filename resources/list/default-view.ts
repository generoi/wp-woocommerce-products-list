/**
 * What a first-time user sees: a table with the name as title, the first
 * image as media, and the columns a shop manager scans a catalog by.
 * Extensions change it through `wcProductsList.defaultView` (gds-woo-i18n
 * adds a "Name (Svenska)" column, for instance).
 */
import { applyFilters } from '@wordpress/hooks';
import type { SupportedLayouts, View } from '../dataviews';
import { FILTERS } from '../extensions/hooks';
import type { Settings } from '../types';

export const PER_PAGE_SIZES = [ 20, 50, 100 ];

export const DEFAULT_PER_PAGE = 20;

export const DEFAULT_TABLE_FIELDS = [ 'status', 'type', 'sku', 'stock_status', 'categories', 'price', 'date_created' ];

export const DEFAULT_LAYOUTS: SupportedLayouts = {
	table: {
		titleField: 'name',
		mediaField: 'images',
		showMedia: true,
		layout: {
			density: 'balanced',
			styles: {
				name: { minWidth: 280 },
				images: { width: 56 },
				status: { width: 110 },
				type: { width: 100 },
				sku: { width: 140 },
				stock_status: { width: 120 },
				price: { width: 130, align: 'end' },
				date_created: { width: 130 },
			},
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

export function createDefaultView( settings: Settings ): View {
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
		layout: DEFAULT_LAYOUTS.table && DEFAULT_LAYOUTS.table !== true ? DEFAULT_LAYOUTS.table.layout : undefined,
	};

	return applyFilters( FILTERS.defaultView, view, settings ) as View;
}

/** The status tabs, in WordPress order; `all` first, `trash` last. */
export const STATUS_TAB_IDS = [ 'all', 'publish', 'future', 'draft', 'pending', 'private', 'trash' ] as const;

export type StatusTabId = ( typeof STATUS_TAB_IDS )[ number ];

export function isStatusTab( value: unknown ): value is StatusTabId {
	return typeof value === 'string' && ( STATUS_TAB_IDS as readonly string[] ).includes( value );
}
