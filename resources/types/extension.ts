/**
 * The two extension layers share one field shape:
 *
 * 1. Declarative definitions serialised by PHP (src/Registry.php) into the
 *    settings payload; the JS core turns them into ProductFields.
 * 2. ProductField / ProductAction objects registered from JavaScript through
 *    `window.wcProductsList`.
 */
import type { Action, Field, View } from '@wordpress/dataviews';
import type { ProductListItem, ProductType, ProductUpdate, VariationUpdate } from './product';
import type { Settings } from './settings';

export type BulkMode = 'money' | 'integer' | 'default' | false;

export type DeclarativeFieldType =
	| 'text'
	| 'html'
	| 'price'
	| 'integer'
	| 'number'
	| 'boolean'
	| 'select'
	| 'date'
	| 'datetime'
	| 'media'
	| 'array';

export interface DeclarativeOption {
	value: string;
	label: string;
	/** Which objects the option exists on (action arg options only). */
	applies?: { product: boolean | string[]; variation: boolean };
}

/** `Registry::normaliseField()` output. */
export interface DeclarativeField {
	id: string;
	label: string;
	type: DeclarativeFieldType;
	description: string;
	/** Dot path into the row the value is read from; defaults to the id. */
	path: string;
	/** Dot path to a read-only companion value (e.g. the default-language name). */
	reference: string | null;
	/** Top-level request key the value is written under; `wc_products_list/save` fires when present. */
	writeKey: string | null;
	/** Dot path under the request body; defaults to `path`. */
	writePath: string | null;
	editable: boolean;
	bulk: BulkMode;
	readonly: boolean;
	applies: {
		/** Parent product types the field exists on, or true for all. */
		product: ProductType[] | true;
		/** Whether variations carry the field too. */
		variation: boolean;
	};
	options: DeclarativeOption[];
	/** Quick-edit tab group, e.g. `i18n:se`. */
	group: string | null;
	tab: string | null;
	/** Visible in the default table view. */
	visible: boolean;
	order: number;
	enableSorting: boolean;
	/** wc/v3 `orderby` value when sorting by this field. */
	sortParam: string | null;
	/** Top-level `_fields` keys to request when the column is visible. */
	restFields: string[];
	filter: { param: string; operators: string[] } | null;
	width: number | null;
	source: string;
	/** What the muted `reference` companion is ("Not translated to Svenska; showing the Suomi value"); the cell's title. */
	referenceLabel?: string;
	/** `price` fields: the ISO code of the currency the column is in, when not the shop's. */
	currency?: string;
	/** `price` fields: decimals of that currency when not the shop's. */
	precision?: number;
}

export type DeclarativeFilterType = 'select' | 'text' | 'boolean' | 'number' | 'date';

/** `Registry::normaliseFilter()` output. */
export interface DeclarativeFilter {
	id: string;
	label: string;
	type: DeclarativeFilterType;
	/** The query param; null when every option carries its own `params`. */
	param: string | null;
	options: Array< DeclarativeOption & { params: Record< string, unknown > } >;
	operators: string[];
	isPrimary: boolean;
	multiple: boolean;
	/** Also sent on variation requests. */
	variations: boolean;
	order: number;
	source: string;
}

export type DeclarativeActionArgType = 'text' | 'select' | 'boolean' | 'integer' | 'number' | 'array';

export interface DeclarativeActionArg {
	id: string;
	label: string;
	/** `array` is a multi-select over `options`, sent as a list of values. */
	type: DeclarativeActionArgType;
	required: boolean;
	/** A required `select` without one defaults to its first option. */
	default: unknown;
	options: DeclarativeOption[];
}

/** `Registry::normaliseAction()` output; runs through POST /actions/{id}. */
export interface DeclarativeAction {
	id: string;
	label: string;
	description: string;
	icon: string | null;
	scope: 'product' | 'variation' | 'both';
	supportsBulk: boolean;
	isPrimary: boolean;
	destructive: boolean;
	/** Confirmation text; null runs without asking. */
	confirm: string | null;
	capability: string | null;
	group: string | null;
	order: number;
	args: DeclarativeActionArg[];
	source: string;
}

/** The context the query hooks receive. */
export interface QueryContext {
	tab: string;
	view: View;
	fields: ProductField[];
}

export type QueryParams = Record< string, string | number | boolean | Array< string | number > | undefined >;

/**
 * A DataViews field plus what the list needs to fetch, filter, sort and
 * write it. Ids are the wc/v3 keys (`sale_price`, `stock_status`, ...).
 */
export interface ProductField< Item = ProductListItem > extends Field< Item > {
	rest: {
		/** Top-level `_fields` to request when the column is visible. */
		fields: string[];
		/** Read the value from a row; defaults to `item[ id ]` via `getValue`. */
		read?: ( item: Item ) => unknown;
		/** Turn an edited value into the request body fragment; defaults to `{ [ id ]: value }`. */
		write?: ( value: unknown, item: Item ) => Record< string, unknown >;
		/** The wc/v3 list query param a filter on this field maps to. */
		param?: string;
		/** The wc/v3 `orderby` value. */
		sortParam?: string;
		applies: {
			/** The key exists on parent products. */
			product: boolean;
			/** The key exists on variations. */
			variation: boolean;
		};
	};
	/** Parent product types the field is shown and edited for; 'all' when every type. */
	productTypes: ProductType[] | 'all';
	/** Where the field sits in quick edit, or false when not editable there. */
	edit:
		| {
				group: string;
				tab?: string;
				bulk: BulkMode;
				order?: number;
		  }
		| false;
	/** A read-only companion value shown beside the control (e.g. the default-language name). */
	reference?: ( item: Item ) => unknown;
	/** Extension fields are tagged with their source id; core fields have 'core'. */
	source?: string;
	/** True for a field that exists only to filter (no column, no edit): kept out of the column pickers. */
	filterOnly?: boolean;
	/** The table column's default styles (`view.layout.styles[ id ]`), applied when the user's view has none for it. */
	columnStyle?: ColumnStyle;
	/** The section of the column picker (`i18n:se` for a language); defaults to `edit.group`, then the field's source. */
	columnGroup?: string;
}

/** What DataViews' table layout reads per column (`view.layout.styles[ id ]`). */
export interface ColumnStyle {
	width?: number | string;
	minWidth?: number | string;
	maxWidth?: number | string;
	align?: 'start' | 'center' | 'end';
}

export type ProductAction< Item = ProductListItem > = Action< Item > & {
	/** Which rows the action is offered for; defaults to both. */
	scope?: 'product' | 'variation' | 'both';
	/** A `Caps` key that must be true for the action to show. */
	capability?: string;
	source?: string;
};

export interface QuickEditTab {
	id: string;
	label: string;
	/** Field ids on the tab; a field's `edit.tab` may also point here. */
	fields?: string[];
	order?: number;
}

export interface BatchUpdate {
	products?: ProductUpdate[];
	/** Keyed by parent id. */
	variations?: Record< number, VariationUpdate[] >;
}

export interface BatchResult {
	updated: ProductListItem[];
	errors: Array< { id: number; message: string; code?: string } >;
	batchId: string;
}

export interface NoticeOptions {
	id?: string;
	/** Default 'snackbar'. */
	type?: 'snackbar' | 'default';
	isDismissible?: boolean;
	actions?: Array< { label: string; onClick?: () => void; url?: string } >;
	/** Stay until dismissed. By default a snackbar hides after 6 s, or 10 s with `actions` (an Undo), paused while hovered or focused; errors always stay. */
	explicitDismiss?: boolean;
}

/** `window.wcProductsList`. Created before `wcProductsList.ready` fires. */
export interface ExtensionApi {
	version: string;
	settings: Settings;
	registerField( field: ProductField ): void;
	registerAction( action: ProductAction ): void;
	/** Add or change wc/v3 list params; `context.tab` is the status tab. */
	addQueryParams( callback: ( params: QueryParams, context: QueryContext ) => QueryParams ): void;
	registerQuickEditTab( tab: QuickEditTab ): void;
	/** Refetch the current page (and counts when asked). Resolves when the rows are in. */
	refresh( options?: { counts?: boolean } ): Promise< void >;
	/** Merge partial rows into the cache by id without a request. */
	patchItems( items: Array< Partial< ProductListItem > & { id: number } > ): void;
	/** Save through the same path as bulk edit: variations first, then parents, logged under one batch. */
	batchUpdate( update: BatchUpdate, options?: { source?: string } ): Promise< BatchResult >;
	notices: {
		success( message: string, options?: NoticeOptions ): void;
		error( message: string, options?: NoticeOptions ): void;
		info( message: string, options?: NoticeOptions ): void;
	};
}

declare global {
	interface Window {
		wcProductsList?: ExtensionApi;
		wcProductsListSettings?: Settings;
	}
}
