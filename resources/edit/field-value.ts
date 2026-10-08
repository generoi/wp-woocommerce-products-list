/**
 * Reading field values off rows and classifying rows for the editor.
 *
 * Kept free of React and of the rest of the app so the pure edit logic
 * (merge, visibility, numeric ops, payload) can be unit-tested on its own.
 */
import type { ProductField, ProductListItem, ProductType } from '../types';

/** The product type the edit rules reason about: a variation, or the parent's type. */
export type EditType = 'variation' | ProductType;

export const KNOWN_PRODUCT_TYPES: readonly string[] = [ 'simple', 'variable', 'grouped', 'external' ];

export function editTypeOf( item: ProductListItem ): EditType {
	if ( isVariation( item ) ) {
		return 'variation';
	}

	const type = ( item as { type?: string } ).type;

	return typeof type === 'string' && type !== '' ? type : 'simple';
}

export function isVariableParent( item: ProductListItem ): boolean {
	return item._kind === 'product' && ( item as { type?: string } ).type === 'variable';
}

/**
 * A variation row: normalised as one, or a wc/v3 object of type
 * `variation` (a search that returns variations as top-level rows).
 */
export function isVariation( item: ProductListItem ): boolean {
	return item._kind === 'variation' || ( item as { type?: string } ).type === 'variation';
}

/** The parent id of a variation row, from whichever key carries it; 0 when unknown. */
export function parentIdOf( item: ProductListItem ): number {
	const row = item as { _parentId?: number | null; parent_id?: number; wc_products_list?: { parent_id?: number } };

	return row._parentId ?? row.wc_products_list?.parent_id ?? row.parent_id ?? 0;
}

/**
 * The value a field holds on a row: the field's own reader first (dotted
 * extension paths), then the DataViews getter, then the raw key.
 */
export function readFieldValue( field: ProductField, item: ProductListItem ): unknown {
	if ( field.rest?.read ) {
		return field.rest.read( item );
	}

	if ( field.getValue ) {
		return field.getValue( { item } );
	}

	return ( item as Record< string, unknown > )[ field.id ];
}

export function readReference( field: ProductField, item: ProductListItem ): unknown {
	return field.reference ? field.reference( item ) : undefined;
}

/** JSON-based equality that keeps `undefined` apart from `null`. */
export function normalizeForCompare( value: unknown ): string {
	if ( value === undefined ) {
		return '__undefined__';
	}

	return JSON.stringify( value ) ?? '__unserializable__';
}

export function isEmptyValue( value: unknown ): boolean {
	if ( value === undefined || value === null || value === '' ) {
		return true;
	}

	if ( Array.isArray( value ) ) {
		return value.length === 0;
	}

	return false;
}

export function isPlainObject( value: unknown ): value is Record< string, unknown > {
	return typeof value === 'object' && value !== null && ! Array.isArray( value );
}

/** Deep-merge request fragments (`{ i18n: { se: { name } } }` + `{ i18n: { se: { slug } } }`). */
export function mergeFragments( target: Record< string, unknown >, fragment: Record< string, unknown > ): Record< string, unknown > {
	const result: Record< string, unknown > = { ...target };

	for ( const [ key, value ] of Object.entries( fragment ) ) {
		const existing = result[ key ];

		if ( isPlainObject( existing ) && isPlainObject( value ) ) {
			result[ key ] = mergeFragments( existing, value );
		} else {
			result[ key ] = value;
		}
	}

	return result;
}
