/**
 * Which fields the quick/bulk edit form shows for a selection.
 *
 * Ported from WooCommerce's experimental products app (product-edit/utils.ts):
 *
 * - a field is shown only when it applies to every selected row (the
 *   intersection of the per-type field sets);
 * - bulk editing drops `sku` (unique per product) and fields that opt out
 *   with `edit.bulk === false`;
 * - when the selection contains variations, parent-owned fields go;
 * - when the selection contains variable parents, sellable fields go — unless
 *   the user asked to apply them to those parents' variations, in which case
 *   the parent is treated as its variations for those fields.
 */
import type { ProductField, ProductListItem } from '../types';
import { editTypeOf, isVariableParent, isVariation, KNOWN_PRODUCT_TYPES } from './field-value';

export interface VisibilityOptions {
	mode: 'quick' | 'bulk';
	applyToVariations: boolean;
}

/** Fields only a parent product carries; hidden as soon as a variation is selected. */
export const PARENT_OWNED_FIELD_IDS: ReadonlySet< string > = new Set( [
	'name',
	'slug',
	'short_description',
	'catalog_visibility',
	'categories',
	'brands',
	'tags',
	'type',
	'featured',
	'upsell_ids',
	'cross_sell_ids',
	'grouped_products',
	'external_url',
	'button_text',
	'images',
	'reviews_allowed',
	'attributes',
	'default_attributes',
] );

/** Fields a variable parent does not sell itself; its variations do. */
export const SELLABLE_FIELD_IDS: ReadonlySet< string > = new Set( [
	'price',
	'regular_price',
	'on_sale',
	'sale_price',
	'schedule_sale',
	'date_on_sale_from',
	'date_on_sale_to',
	'cost_of_goods_sold',
] );

/** Fields that cannot be set on many rows at once. */
export const BULK_UNSUPPORTED_FIELD_IDS: ReadonlySet< string > = new Set( [ 'sku', 'global_unique_id', 'slug' ] );

/** The last segment of a (dotted or colon-prefixed) field id: `i18n:se.sale_price` → `sale_price`. */
export function leafOf( fieldId: string ): string {
	const dot = fieldId.lastIndexOf( '.' );

	return dot === -1 ? fieldId : fieldId.slice( dot + 1 );
}

/** Sellable by id, or by leaf (`i18n:se.sale_price` is a sale price too). */
export function isSellableField( fieldOrId: ProductField | string ): boolean {
	const id = typeof fieldOrId === 'string' ? fieldOrId : fieldOrId.id;

	return SELLABLE_FIELD_IDS.has( id ) || SELLABLE_FIELD_IDS.has( leafOf( id ) );
}

export function isParentOwnedField( fieldOrId: ProductField | string ): boolean {
	const id = typeof fieldOrId === 'string' ? fieldOrId : fieldOrId.id;

	return PARENT_OWNED_FIELD_IDS.has( id ) || PARENT_OWNED_FIELD_IDS.has( leafOf( id ) );
}

export function isBulkUnsupportedField( fieldOrId: ProductField | string ): boolean {
	const id = typeof fieldOrId === 'string' ? fieldOrId : fieldOrId.id;

	return BULK_UNSUPPORTED_FIELD_IDS.has( id ) || BULK_UNSUPPORTED_FIELD_IDS.has( leafOf( id ) );
}

export function isEditableField( field: ProductField ): boolean {
	return field.edit !== false && field.edit !== undefined && field.readOnly !== true;
}

export function hasVariations( items: ProductListItem[] ): boolean {
	return items.some( isVariation );
}

export function hasVariableParents( items: ProductListItem[] ): boolean {
	return items.some( isVariableParent );
}

/**
 * Whether a field exists on a row. A variable parent asked to apply sellable
 * fields to its variations counts as a variation for those fields.
 */
export function fieldAppliesTo( field: ProductField, item: ProductListItem, applyToVariations = false ): boolean {
	const applies = field.rest?.applies ?? { product: true, variation: false };

	if ( isVariation( item ) ) {
		return applies.variation;
	}

	if ( applyToVariations && isVariableParent( item ) && isSellableField( field ) ) {
		return applies.variation;
	}

	if ( ! applies.product ) {
		return false;
	}

	if ( field.productTypes === 'all' || field.productTypes === undefined ) {
		return true;
	}

	const type = editTypeOf( item );

	// A type the registry does not know (a subscription plugin's, say) edits like a simple product.
	return field.productTypes.includes( type ) || ( ! KNOWN_PRODUCT_TYPES.includes( type ) && field.productTypes.includes( 'simple' ) );
}

/**
 * The fields the edit form shows for `items`, in registry order.
 */
export function visibleEditFields( fields: ProductField[], items: ProductListItem[], options: VisibilityOptions ): ProductField[] {
	const rows = items.filter( ( item ) => ! item._placeholder );

	if ( rows.length === 0 ) {
		return [];
	}

	const isBulk = options.mode === 'bulk' || rows.length > 1;
	const withVariations = hasVariations( rows );
	const withVariableParents = hasVariableParents( rows );

	return fields.filter( ( field ) => {
		if ( ! isEditableField( field ) ) {
			return false;
		}

		if ( isBulk ) {
			if ( isBulkUnsupportedField( field ) ) {
				return false;
			}

			if ( field.edit !== false && field.edit.bulk === false ) {
				return false;
			}
		}

		if ( withVariations && isParentOwnedField( field ) ) {
			return false;
		}

		if ( withVariableParents && isSellableField( field ) && ! options.applyToVariations ) {
			return false;
		}

		if ( ! rows.every( ( item ) => fieldAppliesTo( field, item, options.applyToVariations ) ) ) {
			return false;
		}

		if ( typeof field.isVisible === 'function' ) {
			const isVisible = field.isVisible;

			return rows.every( ( item ) => isVisible( item ) );
		}

		return true;
	} );
}
