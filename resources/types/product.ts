/**
 * The wc/v3 shapes the app reads and writes, and the row the list renders.
 *
 * Raw* mirror the REST schema (string prices, ISO dates without zone in the
 * site's timezone, `*_gmt` twins). Nothing here is invented: when a key is
 * missing from a response it is because the request's `_fields` left it out,
 * so every raw property is optional except `id`.
 */

export type ProductType = 'simple' | 'variable' | 'grouped' | 'external' | ( string & {} );

export type ProductStatus = 'publish' | 'future' | 'draft' | 'pending' | 'private' | 'trash';

export type StockStatus = 'instock' | 'outofstock' | 'onbackorder' | ( string & {} );

export type CatalogVisibility = 'visible' | 'catalog' | 'search' | 'hidden';

export type TaxStatus = 'taxable' | 'shipping' | 'none';

export type Backorders = 'no' | 'notify' | 'yes';

export interface RawTerm {
	id: number;
	name: string;
	slug: string;
}

export interface RawImage {
	id: number;
	src: string;
	name?: string;
	alt?: string;
	date_created?: string;
	date_modified?: string;
}

export interface RawAttribute {
	id: number;
	name: string;
	slug?: string;
	position?: number;
	visible?: boolean;
	variation?: boolean;
	/** Parent products list every option. */
	options?: string[];
	/** Variations carry the one chosen option. */
	option?: string;
}

export interface RawDimensions {
	length: string;
	width: string;
	height: string;
}

export interface RawMetaData {
	id?: number;
	key: string;
	value: unknown;
}

/**
 * What `Rows` adds under `wc_products_list` when the list-mode header is set.
 * Extensions may add keys through the `wc_products_list/row` filter.
 */
export interface ListRowMeta {
	/** Number of variations of a variable product; 0 otherwise. */
	variation_count: number;
	/** The classic editor URL for this object (variations link to their parent). */
	edit_link: string;
	can_edit: boolean;
	can_delete: boolean;
	/** 0 for a product; the parent's id for a variation. */
	parent_id: number;
	[ extension: string ]: unknown;
}

/** The keys a product and a variation share. */
interface RawSellable {
	id: number;
	name?: string;
	slug?: string;
	permalink?: string;
	status?: ProductStatus;
	description?: string;
	sku?: string;
	price?: string;
	regular_price?: string;
	sale_price?: string;
	date_on_sale_from?: string | null;
	date_on_sale_from_gmt?: string | null;
	date_on_sale_to?: string | null;
	date_on_sale_to_gmt?: string | null;
	on_sale?: boolean;
	purchasable?: boolean;
	virtual?: boolean;
	downloadable?: boolean;
	tax_status?: TaxStatus;
	tax_class?: string;
	manage_stock?: boolean | 'parent';
	stock_quantity?: number | null;
	stock_status?: StockStatus;
	backorders?: Backorders;
	backorders_allowed?: boolean;
	backordered?: boolean;
	low_stock_amount?: number | null;
	weight?: string;
	dimensions?: RawDimensions;
	shipping_class?: string;
	shipping_class_id?: number;
	menu_order?: number;
	date_created?: string;
	date_created_gmt?: string;
	date_modified?: string;
	date_modified_gmt?: string;
	meta_data?: RawMetaData[];
	/** Present when the Cost of Goods Sold feature is on. */
	cost_of_goods_sold?: {
		values?: Array< { defined_value: number; effective_value: number } >;
		total_value?: number;
	};
	/** Set by Rows in list mode. */
	wc_products_list?: ListRowMeta;
	/** Extension row data (e.g. gds-woo-i18n's `i18n`). */
	[ extension: string ]: unknown;
}

export interface RawProduct extends RawSellable {
	type?: ProductType;
	featured?: boolean;
	catalog_visibility?: CatalogVisibility;
	short_description?: string;
	total_sales?: number;
	external_url?: string;
	button_text?: string;
	sold_individually?: boolean;
	reviews_allowed?: boolean;
	average_rating?: string;
	rating_count?: number;
	parent_id?: number;
	categories?: RawTerm[];
	tags?: RawTerm[];
	brands?: RawTerm[];
	images?: RawImage[];
	attributes?: RawAttribute[];
	default_attributes?: RawAttribute[];
	variations?: number[];
	grouped_products?: number[];
	upsell_ids?: number[];
	cross_sell_ids?: number[];
	related_ids?: number[];
	has_options?: boolean;
	post_password?: string;
}

export interface RawVariation extends RawSellable {
	/** wc/v3 formats this as "Parent name - option, option". */
	name?: string;
	parent_id?: number;
	image?: RawImage | null;
	attributes?: RawAttribute[];
	global_unique_id?: string;
}

export type PlaceholderKind = 'loading' | 'error' | 'more';

/**
 * A row of the list. Parents are level 0, their variations level 1; a
 * placeholder row stands in for children while they load, when loading
 * failed, or for the ones beyond `limits.maxChildrenPerParent`.
 */
export interface ListItemMeta {
	/** 'product' for a parent row, 'variation' for a child row. */
	_kind: 'product' | 'variation';
	_level: 0 | 1;
	/** null for a parent, the parent's id for a variation or placeholder. */
	_parentId: number | null;
	/** The parent's decoded name on a variation row (screen readers hear which product "Blue, 42" belongs to). */
	_parentName?: string;
	/** True for variable products with at least one variation. */
	_hasChildren: boolean;
	/** `wc_products_list.variation_count`, 0 when unknown. */
	_childCount: number;
	/** Set only on placeholder rows. */
	_placeholder?: PlaceholderKind;
	/** The placeholder's message (error text, "N more…"). */
	_placeholderMessage?: string;
}

export type ProductListItem = ( RawProduct | RawVariation ) & ListItemMeta;

export type ProductRow = RawProduct & ListItemMeta & { _kind: 'product'; _level: 0; _parentId: null };

export type VariationRow = RawVariation & ListItemMeta & { _kind: 'variation'; _level: 1; _parentId: number };

export function isVariationRow( item: ProductListItem ): item is VariationRow {
	return item._kind === 'variation';
}

export function isProductRow( item: ProductListItem ): item is ProductRow {
	return item._kind === 'product';
}

export function isPlaceholderRow( item: ProductListItem ): boolean {
	return item._placeholder !== undefined;
}

/** `getItemId` for DataViews: ids are post ids, unique across parents and variations. */
export function getItemId( item: ProductListItem ): string {
	return item._placeholder ? `${ item._parentId }:${ item._placeholder }` : String( item.id );
}

/** One wc/v3 batch update: the id plus the keys to change. */
export type ProductUpdate = { id: number } & Partial< Omit< RawProduct, 'id' > > & Record< string, unknown >;

export type VariationUpdate = { id: number } & Partial< Omit< RawVariation, 'id' > > & Record< string, unknown >;

/** The wc/v3 `products/batch` and `products/{id}/variations/batch` response. */
export interface BatchResponse< Item = RawProduct > {
	create?: Item[];
	update?: Array< Item | BatchItemError >;
	delete?: Item[];
}

export interface BatchItemError {
	id: number;
	error: {
		code: string;
		message: string;
		data?: { status?: number } & Record< string, unknown >;
	};
}

export function isBatchItemError( item: unknown ): item is BatchItemError {
	return typeof item === 'object' && item !== null && 'error' in item;
}
