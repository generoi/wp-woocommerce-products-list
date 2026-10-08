/**
 * Factories for the edit-module tests: settings, fields and rows shaped like
 * the registry and the REST client produce them.
 */
import type { ProductField, ProductListItem, ProductRow, Settings, VariationRow } from '../../resources/types';

export function editSettings( overrides: Partial< Settings > = {} ): Settings {
	return {
		version: '0.1.0',
		locale: 'fi',
		currency: { code: 'EUR', symbol: '€', position: 'right_space', decimals: 2, decimalSeparator: ',', thousandSeparator: ' ' },
		units: { weight: 'kg', dimension: 'cm' },
		dateFormat: 'j.n.Y',
		timeFormat: 'H:i',
		timezone: 'Europe/Helsinki',
		user: { id: 1, name: 'admin' },
		caps: { edit: true, editOthers: true, publish: true, delete: true, deleteOthers: true, manageWoocommerce: true, manageTerms: true },
		statuses: [ { value: 'publish', label: 'Published' }, { value: 'draft', label: 'Draft' } ],
		productTypes: [ { value: 'simple', label: 'Simple' }, { value: 'variable', label: 'Variable' } ],
		stockStatuses: [ { value: 'instock', label: 'In stock' } ],
		catalogVisibility: [ { value: 'visible', label: 'Shop and search' } ],
		backorders: [ { value: 'no', label: 'Do not allow' } ],
		taxStatuses: [ { value: 'taxable', label: 'Taxable' } ],
		taxClasses: [ { value: '', label: 'Standard' } ],
		shippingClasses: [],
		taxonomies: [],
		features: { cogs: false, brands: false, reviews: true },
		limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 50, actionBatchSize: 100 },
		links: { admin: '/wp/wp-admin/', rest: '/wp-json/', page: '', history: '', legacyList: '', newProduct: '', editProduct: '/wp/wp-admin/post.php?post=%d&action=edit', assets: '' },
		fields: [],
		filters: [],
		actions: [],
		languages: null,
		...overrides,
	};
}

type FieldOverrides = Partial< ProductField > & { rest?: Partial< ProductField[ 'rest' ] > };

export function field( id: string, overrides: FieldOverrides = {} ): ProductField {
	const { rest, ...rest_ } = overrides;

	return {
		id,
		label: id,
		type: 'text',
		productTypes: 'all',
		edit: { group: 'general', bulk: 'default' },
		source: 'core',
		...rest_,
		rest: {
			fields: [ id ],
			applies: { product: true, variation: false },
			...rest,
		},
	};
}

/** The core fields the tests reason about, with the registry's rules. */
export function coreFields(): ProductField[] {
	return [
		field( 'name', { edit: { group: 'general', bulk: 'default' } } ),
		field( 'sku', { rest: { fields: [ 'sku' ], applies: { product: true, variation: true } }, edit: { group: 'inventory', bulk: 'default' } } ),
		field( 'status', { rest: { fields: [ 'status' ], applies: { product: true, variation: true } } } ),
		field( 'regular_price', {
			productTypes: [ 'simple', 'external' ],
			rest: { fields: [ 'regular_price' ], applies: { product: true, variation: true } },
			edit: { group: 'price', bulk: 'money' },
		} ),
		field( 'sale_price', {
			productTypes: [ 'simple', 'external' ],
			rest: { fields: [ 'sale_price' ], applies: { product: true, variation: true } },
			edit: { group: 'price', bulk: 'money' },
		} ),
		field( 'date_on_sale_from', {
			type: 'datetime',
			productTypes: [ 'simple', 'external' ],
			rest: { fields: [ 'date_on_sale_from' ], applies: { product: true, variation: true } },
			edit: { group: 'price', bulk: 'default' },
		} ),
		field( 'date_on_sale_to', {
			type: 'datetime',
			productTypes: [ 'simple', 'external' ],
			rest: { fields: [ 'date_on_sale_to' ], applies: { product: true, variation: true } },
			edit: { group: 'price', bulk: 'default' },
		} ),
		field( 'stock_quantity', {
			type: 'integer',
			rest: { fields: [ 'stock_quantity' ], applies: { product: true, variation: true } },
			edit: { group: 'inventory', bulk: 'integer' },
		} ),
		field( 'featured', { type: 'boolean', edit: { group: 'organization', bulk: 'default' } } ),
		field( 'categories', { type: 'array', edit: { group: 'organization', bulk: 'default' } } ),
		field( 'external_url', { productTypes: [ 'external' ], edit: { group: 'external', bulk: 'default' } } ),
		field( 'dimensions', { edit: { group: 'shipping', bulk: 'default' } } ),
		field( 'readonly_thing', { readOnly: true, edit: false } ),
		field( 'i18n:se.name', {
			source: 'gds-woo-i18n',
			rest: {
				fields: [ 'i18n' ],
				read: ( item ) => ( item as Record< string, { se?: { name?: { value?: string } } } > ).i18n?.se?.name?.value ?? '',
				write: ( value ) => ( { i18n: { se: { name: value } } } ),
				applies: { product: true, variation: false },
			},
			reference: ( item ) => ( item as Record< string, { se?: { name?: { source?: string } } } > ).i18n?.se?.name?.source ?? '',
			edit: { group: 'i18n:se', bulk: 'default' },
		} ),
		field( 'i18n:se.sale_price', {
			source: 'gds-woo-i18n',
			productTypes: [ 'simple', 'external' ],
			rest: {
				fields: [ 'i18n' ],
				read: ( item ) => ( item as Record< string, { se?: { sale_price?: { value?: string } } } > ).i18n?.se?.sale_price?.value ?? '',
				write: ( value ) => ( { i18n: { se: { sale_price: value } } } ),
				applies: { product: true, variation: true },
			},
			edit: { group: 'i18n:se', bulk: 'money' },
		} ),
		field( 'i18n:se.regular_price', {
			source: 'gds-woo-i18n',
			productTypes: [ 'simple', 'external' ],
			rest: {
				fields: [ 'i18n' ],
				read: ( item ) => ( item as Record< string, { se?: { regular_price?: { value?: string } } } > ).i18n?.se?.regular_price?.value ?? '',
				write: ( value ) => ( { i18n: { se: { regular_price: value } } } ),
				applies: { product: true, variation: true },
			},
			edit: { group: 'i18n:se', bulk: 'money' },
		} ),
	];
}

export function simple( id: number, props: Record< string, unknown > = {} ): ProductRow {
	return {
		id,
		type: 'simple',
		name: `Simple ${ id }`,
		status: 'publish',
		sku: `S${ id }`,
		regular_price: '100',
		sale_price: '',
		stock_quantity: 5,
		featured: false,
		categories: [],
		_kind: 'product',
		_level: 0,
		_parentId: null,
		_hasChildren: false,
		_childCount: 0,
		...props,
	} as ProductRow;
}

export function external( id: number, props: Record< string, unknown > = {} ): ProductRow {
	return simple( id, { type: 'external', external_url: 'https://example.com', ...props } );
}

export function variable( id: number, props: Record< string, unknown > = {} ): ProductRow {
	return simple( id, { type: 'variable', regular_price: '', sale_price: '', _hasChildren: true, _childCount: 2, ...props } );
}

export function variation( id: number, parentId: number, props: Record< string, unknown > = {} ): VariationRow {
	return {
		id,
		parent_id: parentId,
		name: `Variation ${ id }`,
		status: 'publish',
		sku: `V${ id }`,
		regular_price: '50',
		sale_price: '',
		stock_quantity: 3,
		_kind: 'variation',
		_level: 1,
		_parentId: parentId,
		_hasChildren: false,
		_childCount: 0,
		...props,
	} as VariationRow;
}

export function ids( items: Array< { id: string } > ): string[] {
	return items.map( ( item ) => item.id );
}

export function placeholder( parentId: number ): ProductListItem {
	return { id: -1, _kind: 'variation', _level: 1, _parentId: parentId, _hasChildren: false, _childCount: 0, _placeholder: 'loading' } as ProductListItem;
}
