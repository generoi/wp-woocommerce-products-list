/**
 * Bulk operations for list fields (categories, tags, brands): add to,
 * remove from or replace each row's own list, resolved per row at save
 * time like the numeric ops. Without this a bulk edit would send the
 * picked terms as the full list and every row would end up with exactly
 * those, whatever it had before.
 *
 * The operation lives in a virtual sibling field `<id>__op` (a select
 * rendered above the token list), so DataForm's own array control keeps
 * doing the picking. The op field never reaches a payload.
 */
import { __, sprintf } from '@wordpress/i18n';
import type { Option } from '../dataviews';
import type { ProductField } from '../types';
import { isEditableField } from './visibility';

export type ArrayOperation = 'add' | 'remove' | 'replace';

export const ARRAY_OP_SUFFIX = '__op';

export const DEFAULT_ARRAY_OPERATION: ArrayOperation = 'add';

export const ARRAY_OPERATIONS: readonly ArrayOperation[] = [ 'add', 'remove', 'replace' ];

export function arrayOpFieldId( fieldId: string ): string {
	return `${ fieldId }${ ARRAY_OP_SUFFIX }`;
}

export function isArrayOpFieldId( id: string ): boolean {
	return id.endsWith( ARRAY_OP_SUFFIX );
}

/** The list field an op field belongs to. */
export function arrayFieldOf( opId: string ): string {
	return isArrayOpFieldId( opId ) ? opId.slice( 0, opId.length - ARRAY_OP_SUFFIX.length ) : opId;
}

export function isArrayOperation( value: unknown ): value is ArrayOperation {
	return typeof value === 'string' && ( ARRAY_OPERATIONS as readonly string[] ).includes( value );
}

/** Whether `fields` carries a bulk op for the list field `id`. */
export function hasArrayOp( fields: ProductField[], id: string ): boolean {
	const opId = arrayOpFieldId( id );

	return fields.some( ( field ) => field.id === opId );
}

export function arrayOperationElements(): Option[] {
	return [
		{ value: 'add', label: __( 'Add to the existing ones', 'wp-woocommerce-products-list' ) },
		{ value: 'remove', label: __( 'Remove from the existing ones', 'wp-woocommerce-products-list' ) },
		{ value: 'replace', label: __( 'Replace all with these', 'wp-woocommerce-products-list' ) },
	];
}

/** A list field that can take a bulk op: editable in bulk, with a term list to pick from. */
export function supportsArrayOp( field: ProductField ): boolean {
	return field.type === 'array' && isEditableField( field ) && field.edit !== false && field.edit.bulk !== false && ( Array.isArray( field.elements ) || typeof field.getElements === 'function' );
}

/**
 * The fields with a `<id>__op` select in front of every list field that
 * supports it. Bulk mode only: quick edit shows the row's list and
 * replaces it.
 */
export function withArrayOps( fields: ProductField[] ): ProductField[] {
	const result: ProductField[] = [];

	for ( const field of fields ) {
		if ( supportsArrayOp( field ) && field.edit !== false && ! fields.some( ( other ) => other.id === arrayOpFieldId( field.id ) ) ) {
			const order = typeof field.edit.order === 'number' ? field.edit.order : 100;

			result.push( {
				id: arrayOpFieldId( field.id ),
				/* translators: %s: a field label such as "Categories" */
				label: sprintf( __( '%s: how to apply', 'wp-woocommerce-products-list' ), field.label ?? field.id ),
				type: 'text',
				elements: arrayOperationElements(),
				productTypes: field.productTypes,
				edit: { group: field.edit.group, tab: field.edit.tab, bulk: 'default', order: order - 0.5 },
				source: field.source,
				rest: {
					fields: [],
					applies: field.rest.applies,
					read: () => DEFAULT_ARRAY_OPERATION,
				},
			} );
		}

		result.push( field );
	}

	return result;
}

function key( value: unknown ): string {
	return typeof value === 'object' && value !== null && 'id' in value ? String( ( value as { id: unknown } ).id ) : String( value );
}

function sameSet( a: unknown[], b: unknown[] ): boolean {
	if ( a.length !== b.length ) {
		return false;
	}

	const keys = new Set( a.map( key ) );

	return b.every( ( value ) => keys.has( key( value ) ) );
}

/**
 * The row's list after the op; `changed` is false when the result equals
 * the current list (the row is left alone).
 */
export function applyArrayOp( current: unknown, operation: ArrayOperation, value: unknown[] ): { next: unknown[]; changed: boolean } {
	const list = Array.isArray( current ) ? current : [];

	switch ( operation ) {
		case 'add': {
			const have = new Set( list.map( key ) );
			const next = [ ...list, ...value.filter( ( entry ) => ! have.has( key( entry ) ) ) ];

			return { next, changed: next.length !== list.length };
		}
		case 'remove': {
			const drop = new Set( value.map( key ) );
			const next = list.filter( ( entry ) => ! drop.has( key( entry ) ) );

			return { next, changed: next.length !== list.length };
		}
		case 'replace':
		default:
			return { next: value, changed: ! sameSet( list, value ) };
	}
}

export function describeArrayOperation( operation: ArrayOperation ): string {
	switch ( operation ) {
		case 'add':
			return __( 'add', 'wp-woocommerce-products-list' );
		case 'remove':
			return __( 'remove', 'wp-woocommerce-products-list' );
		case 'replace':
		default:
			return __( 'replace all with', 'wp-woocommerce-products-list' );
	}
}
