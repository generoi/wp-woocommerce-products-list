/**
 * The field list the app runs on: core fields in display order, then the
 * declarative definitions from the settings payload, then fields registered
 * through `window.wcProductsList.registerField`, then the
 * `wcProductsList.fields` filter. Later definitions replace earlier ones
 * with the same id.
 */
import { applyFilters } from '@wordpress/hooks';
import { getRegisteredFields } from '../extensions/api';
import { fieldsFromSettings } from '../extensions/declarative';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, ProductListItem, Settings } from '../types';
import { guardCell } from '../ui/error-boundary';
import { createBackordersField } from './backorders';
import { createCatalogVisibilityField } from './catalog-visibility';
import { createCostOfGoodsField } from './cost-of-goods';
import { createDateFields } from './dates';
import { createDescriptionFields } from './descriptions';
import { createExternalFields } from './external';
import { createFeaturedField } from './featured';
import { createFlagFields } from './flags';
import { createIdentityFields } from './identity';
import { createImagesField } from './images';
import { createLowStockAmountField } from './low-stock-amount';
import { createManageStockField } from './manage-stock';
import { createNameField } from './name';
import { createOnSaleField } from './on-sale';
import { createPriceField } from './price';
import { createRegularPriceField } from './regular-price';
import { createSalePriceField } from './sale-price';
import { createSaleScheduleFields } from './sale-schedule';
import { createDimensionsField, createShippingClassField, createWeightField } from './shipping';
import { createSkuField } from './sku';
import { createStatusField } from './status';
import { createStockQuantityField } from './stock-quantity';
import { createStockStatusField, createVariationStockFilter } from './stock-status';
import { createTaxClassField, createTaxStatusField } from './tax';
import { createTermsFields } from './terms';
import { createTypeField } from './type';

export const CORE_FIELD_IDS: readonly string[] = [
	'name',
	'images',
	'status',
	'type',
	'sku',
	'price',
	'regular_price',
	'sale_price',
	'date_on_sale_from',
	'date_on_sale_to',
	'stock_status',
	'variation_stock',
	'manage_stock',
	'stock_quantity',
	'backorders',
	'low_stock_amount',
	'categories',
	'tags',
	'brands',
	'featured',
	'on_sale',
	'catalog_visibility',
	'date_created',
	'date_modified',
	'weight',
	'dimensions',
	'shipping_class',
	'tax_status',
	'tax_class',
	'virtual',
	'downloadable',
	'sold_individually',
	'reviews_allowed',
	'external_url',
	'button_text',
	'short_description',
	'description',
	'id',
	'slug',
	'menu_order',
	'permalink',
	'cost_of_goods_sold',
];

/** Fields that bulk edit never offers (Woo: a SKU is unique per product). */
export const BULK_EXCLUDED_IDS: readonly string[] = [ 'sku', 'slug' ];

export function createCoreFields( settings: Settings ): ProductField[] {
	return [
		createNameField( settings ),
		createImagesField( settings ),
		createStatusField( settings ),
		createTypeField( settings ),
		createSkuField( settings ),
		createPriceField( settings ),
		createRegularPriceField( settings ),
		createSalePriceField( settings ),
		...createSaleScheduleFields( settings ),
		createStockStatusField( settings ),
		createVariationStockFilter( settings ),
		createManageStockField( settings ),
		createStockQuantityField( settings ),
		createBackordersField( settings ),
		createLowStockAmountField( settings ),
		...createTermsFields( settings ),
		createFeaturedField( settings ),
		createOnSaleField( settings ),
		createCatalogVisibilityField( settings ),
		...createDateFields( settings ),
		createWeightField( settings ),
		createDimensionsField( settings ),
		createShippingClassField( settings ),
		createTaxStatusField( settings ),
		createTaxClassField( settings ),
		...createFlagFields( settings ),
		...createExternalFields( settings ),
		...createDescriptionFields( settings ),
		...createIdentityFields( settings ),
		createCostOfGoodsField( settings ),
	].filter( ( f ): f is ProductField => f !== null );
}

function mergeById( lists: ProductField[][] ): ProductField[] {
	const byId = new Map< string, ProductField >();

	for ( const list of lists ) {
		for ( const field of list ) {
			if ( ! field?.id ) {
				continue;
			}

			byId.delete( field.id );
			byId.set( field.id, field );
		}
	}

	return Array.from( byId.values() );
}

export function createProductFields( settings: Settings ): ProductField[] {
	let declarative: ProductField[] = [];

	try {
		declarative = fieldsFromSettings( settings );
	} catch ( error ) {
		// A broken extension definition must not take the list down.
		console.error( '[wc-products-list] declarative fields', error );
	}

	const core = createCoreFields( settings );
	const coreRenders = new Set( core.map( ( field ) => field.render ).filter( Boolean ) );
	const merged = mergeById( [ core, declarative, getRegisteredFields() ] );
	const filtered = applyFilters( FILTERS.fields, merged, settings ) as ProductField[];

	// A cell renderer from an extension that throws blanks its own cell, not the list.
	return filtered.map( ( field ) => ( field.render && ! coreRenders.has( field.render ) ? { ...field, render: guardCell( field.render, `field ${ field.id }` ) } : field ) );
}

export function getField( fields: ProductField[], id: string ): ProductField | undefined {
	return fields.find( ( field ) => field.id === id );
}

function appliesTo( field: ProductField, item: ProductListItem ): boolean {
	if ( item._kind === 'variation' ) {
		return field.rest.applies.variation;
	}

	if ( ! field.rest.applies.product ) {
		return false;
	}

	const type = ( item as { type?: string } ).type ?? 'simple';

	return field.productTypes === 'all' || field.productTypes.includes( type );
}

/**
 * The editable fields every one of `items` has: the intersection of the
 * per-type field sets. Bulk mode also drops unique-per-product fields and
 * those with `edit.bulk === false`.
 */
export function fieldsForItems( fields: ProductField[], items: ProductListItem[], mode: 'quick' | 'bulk' ): ProductField[] {
	const targets = items.filter( ( item ) => ! item._placeholder );

	if ( ! targets.length ) {
		return [];
	}

	return fields.filter( ( field ) => {
		if ( field.edit === false || field.readOnly ) {
			return false;
		}

		if ( mode === 'bulk' && ( field.edit.bulk === false || BULK_EXCLUDED_IDS.includes( field.id ) ) ) {
			return false;
		}

		return targets.every( ( item ) => appliesTo( field, item ) );
	} );
}

/** Group editable fields for a form: `edit.group` → fields, in `edit.order`. */
export function groupEditFields( fields: ProductField[] ): Map< string, ProductField[] > {
	const groups = new Map< string, ProductField[] >();
	const sorted = fields
		.filter( ( f ) => f.edit !== false )
		.sort( ( a, b ) => ( ( a.edit as { order?: number } ).order ?? 100 ) - ( ( b.edit as { order?: number } ).order ?? 100 ) );

	for ( const field of sorted ) {
		const group = ( field.edit as { group: string } ).group;
		groups.set( group, [ ...( groups.get( group ) ?? [] ), field ] );
	}

	return groups;
}
