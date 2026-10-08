/**
 * One form record for many rows: shared values stay, differing values become
 * a neutral "Mixed" state the controls show as a placeholder.
 *
 * The record is keyed by field id (not by wc/v3 key) so dotted extension
 * fields such as `i18n:se.name` are flat entries the DataForm reads back
 * with the derived `getValue` in form-fields.ts.
 */
import { __ } from '@wordpress/i18n';
import type { ProductField, ProductListItem } from '../types';
import { isEmptyValue, isPlainObject, normalizeForCompare, readFieldValue } from './field-value';

export interface MixedState {
	isMixed: boolean;
	isEmpty: boolean;
	placeholder: string;
}

export interface MergedItems {
	data: Record< string, unknown >;
	mixed: Record< string, MixedState >;
}

export const MIXED_LABEL = __( 'Mixed', 'wp-woocommerce-products-list' );

function mixedFallback( sample: unknown ): unknown {
	if ( Array.isArray( sample ) ) {
		return [];
	}

	if ( sample === null ) {
		return null;
	}

	if ( typeof sample === 'string' ) {
		return '';
	}

	return undefined;
}

/** Shared value, or the type's neutral fallback; objects merge key by key (dimensions). */
export function mergeValues( values: unknown[] ): { value: unknown; isMixed: boolean } {
	if ( values.length === 0 ) {
		return { value: undefined, isMixed: false };
	}

	const first = normalizeForCompare( values[ 0 ] );
	const allEqual = values.every( ( value ) => normalizeForCompare( value ) === first );

	if ( allEqual ) {
		return { value: values[ 0 ], isMixed: false };
	}

	if ( values.some( isPlainObject ) ) {
		const keys = new Set< string >();

		values.forEach( ( value ) => {
			if ( isPlainObject( value ) ) {
				Object.keys( value ).forEach( ( key ) => keys.add( key ) );
			}
		} );

		const merged: Record< string, unknown > = {};

		keys.forEach( ( key ) => {
			merged[ key ] = mergeValues( values.map( ( value ) => ( isPlainObject( value ) ? value[ key ] : undefined ) ) ).value;
		} );

		return { value: merged, isMixed: true };
	}

	// The first real value decides the fallback type; a null-only mix stays null.
	const sample = values.find( ( value ) => value !== undefined && value !== null ) ?? values.find( ( value ) => value !== undefined );

	return { value: mixedFallback( sample ), isMixed: true };
}

export function mergeItems( items: ProductListItem[], fields: ProductField[] ): MergedItems {
	const rows = items.filter( ( item ) => ! item._placeholder );
	const data: Record< string, unknown > = {};
	const mixed: Record< string, MixedState > = {};

	for ( const field of fields ) {
		const values = rows.map( ( item ) => readFieldValue( field, item ) );
		const { value, isMixed } = mergeValues( values );

		data[ field.id ] = value;
		mixed[ field.id ] = {
			isMixed,
			isEmpty: ! isMixed && isEmptyValue( value ),
			placeholder: isMixed ? MIXED_LABEL : '',
		};
	}

	return { data, mixed };
}

/** The shared reference value (default-language text etc.) or the Mixed label. */
export function mergeReference( items: ProductListItem[], field: ProductField ): string | null {
	if ( ! field.reference ) {
		return null;
	}

	const reference = field.reference;
	const { value, isMixed } = mergeValues( items.filter( ( item ) => ! item._placeholder ).map( ( item ) => reference( item ) ) );

	if ( isMixed ) {
		return MIXED_LABEL;
	}

	if ( value === undefined || value === null || value === '' ) {
		return '';
	}

	return typeof value === 'string' ? value : String( value );
}
