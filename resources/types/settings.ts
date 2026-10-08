/**
 * `window.wcProductsListSettings`, printed by src/Bootstrap.php and filtered
 * through `wc_products_list/bootstrap`. Keep in sync with that file.
 */
import type { DeclarativeAction, DeclarativeField, DeclarativeFilter } from './extension';

export interface Option< Value extends string = string > {
	value: Value;
	label: string;
}

export interface CurrencySettings {
	code: string;
	symbol: string;
	position: 'left' | 'right' | 'left_space' | 'right_space';
	decimals: number;
	decimalSeparator: string;
	thousandSeparator: string;
}

export interface Caps {
	edit: boolean;
	editOthers: boolean;
	publish: boolean;
	delete: boolean;
	deleteOthers: boolean;
	manageWoocommerce: boolean;
	manageTerms: boolean;
}

export interface TaxonomySettings {
	/** The taxonomy name: product_cat, product_tag, product_brand, product_shipping_class, pa_*. */
	name: string;
	label: string;
	/** The wc/v3 key the terms live under: categories, tags, brands, shipping_class, attributes. */
	restKey: 'categories' | 'tags' | 'brands' | 'shipping_class' | 'attributes';
	hierarchical: boolean;
	/** True for pa_* attribute taxonomies. */
	attribute: boolean;
}

export interface Limits {
	/** wc/v3 caps per_page at 100. */
	perPageMax: number;
	/** Variations shown under one parent before a "more" placeholder. */
	maxChildrenPerParent: number;
	/** Rows per products/batch request. */
	batchSize: number;
	/** Ids per /actions/{action} request. */
	actionBatchSize: number;
}

export interface Links {
	admin: string;
	rest: string;
	page: string;
	history: string;
	legacyList: string;
	newProduct: string;
	/** sprintf-style, %d is the product id. */
	editProduct: string;
	assets: string;
}

/**
 * Set by a translation integration (gds-woo-i18n) through the bootstrap
 * filter; null when none is active.
 */
export interface LanguageSettings {
	default: string;
	others: string[];
	labels: Record< string, string >;
	currencies?: Record< string, string >;
}

export interface Settings {
	version: string;
	locale: string;
	currency: CurrencySettings;
	units: { weight: string; dimension: string };
	dateFormat: string;
	timeFormat: string;
	timezone: string;
	user: { id: number; name: string };
	caps: Caps;
	statuses: Option[];
	productTypes: Option[];
	stockStatuses: Option[];
	catalogVisibility: Option[];
	backorders: Option[];
	taxStatuses: Option[];
	taxClasses: Option[];
	shippingClasses: Array< Option & { id: number } >;
	taxonomies: TaxonomySettings[];
	features: {
		cogs: boolean;
		brands: boolean;
		reviews: boolean;
		/** "Delete permanently" offered on rows outside the Trash (`wc_products_list/allow_hard_delete`). */
		hardDelete: boolean;
	};
	limits: Limits;
	links: Links;
	fields: DeclarativeField[];
	filters: DeclarativeFilter[];
	actions: DeclarativeAction[];
	languages: LanguageSettings | null;
	/** Anything else an integration adds through the bootstrap filter. */
	[ extension: string ]: unknown;
}
