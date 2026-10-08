/**
 * The DataForm fields for the edit modal, derived from the product fields:
 * same id, label, control and options, but reading and writing the flat
 * form record (`data[ field.id ]`) rather than the row, with the bulk
 * behaviours layered on: Mixed placeholders, indeterminate booleans, the
 * numeric operation control, and the schedule toggle hiding the sale dates.
 */
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps, Field } from '../dataviews';
import type { ProductField, ProductListItem, Settings } from '../types';
import { numericKindOf } from './bulk-numeric';
import { createBulkNumericControl } from './bulk-numeric-control';
import type { FormData } from './bulk-numeric-control';
import { mergeReference } from './merge';
import type { MixedState } from './merge';
import { createMixedBooleanControl } from './mixed-boolean-control';
import { SCHEDULE_SALE_FIELD_ID } from './payload';

export type { FormData } from './bulk-numeric-control';

export interface FormFieldOptions {
	bulk: boolean;
	items: ProductListItem[];
	/** The merged record (shared values), for placeholders. */
	base: Record< string, unknown >;
	mixed: Record< string, MixedState >;
	settings: Settings;
}

function scheduleIdFor( fieldId: string ): string | null {
	const match = /^(.*)date_on_sale_(from|to)$/.exec( fieldId );

	return match ? `${ match[ 1 ] }${ SCHEDULE_SALE_FIELD_ID }` : null;
}

function displayValue( value: unknown ): string {
	if ( value === undefined || value === null || value === '' ) {
		return '';
	}

	return typeof value === 'object' ? '' : String( value );
}

export function toFormFields( fields: ProductField[], options: FormFieldOptions ): Field< FormData >[] {
	const { bulk, items, base, mixed, settings } = options;
	const ids = new Set( fields.map( ( field ) => field.id ) );

	return fields.map( ( field ) => {
		const state = mixed[ field.id ];
		const isMixed = state?.isMixed === true;
		const reference = mergeReference( items, field );
		const kind = bulk ? numericKindOf( field ) : null;
		const scheduleId = scheduleIdFor( field.id );

		const formField: Field< FormData > = {
			id: field.id,
			label: field.label ?? field.id,
			type: field.type,
			description: field.description,
			placeholder: isMixed ? state?.placeholder : field.placeholder,
			elements: field.elements,
			getElements: field.getElements,
			readOnly: field.readOnly,
			format: field.format,
			Edit: field.Edit as Field< FormData >[ 'Edit' ],
			isValid: field.isValid as Field< FormData >[ 'isValid' ],
			getValue: ( { item } ) => item[ field.id ],
			setValue: ( { value } ) => ( { [ field.id ]: value } ),
		};

		if ( reference !== null && reference !== '' ) {
			formField.description = sprintf(
				/* translators: %s: the default-language value */
				__( 'Default: %s', 'wp-woocommerce-products-list' ),
				reference
			);
		}

		if ( scheduleId && ids.has( scheduleId ) ) {
			formField.isVisible = ( data ) => data[ scheduleId ] === true;
		}

		// The default datetime control opens a full calendar; the compact one keeps the form short.
		if ( ( field.type === 'datetime' || field.type === 'date' ) && ! field.Edit ) {
			formField.Edit = { control: 'datetime', compact: true };
		}

		if ( kind ) {
			const shared = isMixed ? state?.placeholder : displayValue( base[ field.id ] );

			formField.type = undefined;
			formField.isValid = undefined;
			formField.Edit = createBulkNumericControl( { kind, settings, placeholder: shared, reference } ) as ComponentType< DataFormControlProps< FormData > >;
		} else if ( bulk && field.type === 'boolean' && isMixed && ! field.Edit ) {
			formField.Edit = createMixedBooleanControl( reference );
		}

		if ( bulk && formField.isValid?.required ) {
			formField.isValid = { ...formField.isValid, required: false };
		}

		return formField;
	} );
}

/** Field labels by id, for error lists. */
export function labelsOf( fields: ProductField[] ): Record< string, string > {
	return Object.fromEntries( fields.map( ( field ) => [ field.id, field.label ?? field.id ] ) );
}
