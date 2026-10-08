/**
 * The DataForm fields for the edit modal, derived from the product fields:
 * same id, label, control and options, but reading and writing the flat
 * form record (`data[ field.id ]`) rather than the row, with the bulk
 * behaviours layered on: Mixed placeholders and a "Mixed (no change)"
 * option on selects, indeterminate booleans, the numeric operation control,
 * and the schedule toggle hiding the sale dates.
 *
 * Term fields (categories, tags, brands) carry numeric ids on the row;
 * DataForm's array control wants strings (that is what its validation and
 * its label lookup compare with), so the form sees strings and the edit
 * state gets the row's type back.
 */
import { decodeEntities } from '@wordpress/html-entities';
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps, Field, Option } from '../dataviews';
import { formatMoney } from '../extensions/declarative';
import type { FieldCurrency } from '../extensions/declarative';
import { formatPrice } from '../fields/currency';
import type { ProductField, ProductListItem, Settings } from '../types';
import { isSalePriceField, numericKindOf } from './bulk-numeric';
import { createBulkNumericControl } from './bulk-numeric-control';
import type { FormData } from './bulk-numeric-control';
import { createDateTimeControl } from './datetime-control';
import { isVariation, readFieldValue } from './field-value';
import { mergeReference, MIXED_VALUE, hasOptionList } from './merge';
import type { MixedState } from './merge';
import { createMixedBooleanControl } from './mixed-boolean-control';
import { SCHEDULE_SALE_FIELD_ID } from './payload';
import { leafOf } from './visibility';

export type { FormData } from './bulk-numeric-control';

export interface FormFieldOptions {
	bulk: boolean;
	items: ProductListItem[];
	/** The merged record (shared values), for placeholders. */
	base: Record< string, unknown >;
	mixed: Record< string, MixedState >;
	settings: Settings;
}

/** Variations are Active (publish) or Inactive (private): the list's vocabulary, and what the Enable/Disable actions write. */
export const VARIATION_STATUS_ELEMENTS: Option[] = [
	{ value: 'publish', label: __( 'Active', 'wp-woocommerce-products-list' ) },
	{ value: 'private', label: __( 'Inactive', 'wp-woocommerce-products-list' ) },
];

/** How much of a reference value (the default-language description) the help text shows. */
export const REFERENCE_MAX_LENGTH = 200;

/** The shipping classes a variation can pick: its parent's, or one of the store's. */
export function variationShippingClassElements( settings: Pick< Settings, 'shippingClasses' > ): Option[] {
	return [ { value: '', label: __( 'Same as parent', 'wp-woocommerce-products-list' ) }, ...settings.shippingClasses.map( ( entry ) => ( { value: String( entry.value ), label: entry.label } ) ) ];
}

function scheduleIdFor( fieldId: string ): string | null {
	const match = /^(.*)date_on_sale_(from|to)$/.exec( fieldId );

	return match ? `${ match[ 1 ] }${ SCHEDULE_SALE_FIELD_ID }` : null;
}

function displayValue( value: unknown ): string {
	if ( value === undefined || value === null || value === '' || value === MIXED_VALUE ) {
		return '';
	}

	return typeof value === 'object' ? '' : String( value );
}

/** Reference text for the help line: money formatted, HTML stripped, long text cut. */
export function referenceText( field: ProductField, reference: string, settings: Settings ): string {
	if ( numericKindOf( field ) === 'money' ) {
		// A language's price column is in that market's currency (SEK), not the shop's.
		const currency = ( field as { currency?: FieldCurrency } ).currency;

		return ( currency ? formatMoney( reference, currency, settings ) : formatPrice( reference, settings ) ) || reference;
	}

	let text = reference;

	if ( /<[a-z][^>]*>/i.test( text ) ) {
		text = text.replace( /<[^>]+>/g, ' ' );
	}

	// Stored HTML carries entities (`&amp;`, `&nbsp;`); the help line is plain text.
	text = decodeEntities( text ).replace( /\u00a0/g, ' ' ).replace( /\s+/g, ' ' ).trim();

	return text.length > REFERENCE_MAX_LENGTH ? `${ text.slice( 0, REFERENCE_MAX_LENGTH ).trimEnd() }…` : text;
}

function stringTokens( value: unknown ): string[] {
	return Array.isArray( value ) ? value.map( ( entry ) => ( typeof entry === 'object' && entry !== null && 'id' in entry ? String( ( entry as { id: unknown } ).id ) : String( entry ) ) ) : [];
}

function stringElements( elements: Option[] | undefined ): Option[] | undefined {
	return elements?.map( ( element ) => ( { ...element, value: String( element.value ) } ) );
}

const INTEGER_PATTERN = /^-?\d+$/;

function integerMessage( value: unknown ): string | null {
	if ( value === undefined || value === null || value === '' ) {
		return null;
	}

	const text = String( value ).trim();

	if ( ! INTEGER_PATTERN.test( text ) ) {
		return __( 'Enter a whole number.', 'wp-woocommerce-products-list' );
	}

	return Number( text ) < 0 ? __( 'The quantity cannot be negative.', 'wp-woocommerce-products-list' ) : null;
}

export function toFormFields( fields: ProductField[], options: FormFieldOptions ): Field< FormData >[] {
	const { bulk, items, base, mixed, settings } = options;
	const ids = new Set( fields.map( ( field ) => field.id ) );
	const rows = items.filter( ( item ) => ! item._placeholder );
	const onlyVariations = rows.length > 0 && rows.every( isVariation );

	return fields.map( ( field ) => {
		const state = mixed[ field.id ];
		const isMixed = state?.isMixed === true;
		const reference = mergeReference( items, field );
		const kind = bulk ? numericKindOf( field ) : null;
		const scheduleId = scheduleIdFor( field.id );
		const leaf = leafOf( field.id );

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
				referenceText( field, reference, settings )
			);
		}

		if ( scheduleId && ids.has( scheduleId ) ) {
			formField.isVisible = ( data ) => data[ scheduleId ] === true;
		}

		// Our own datetime-local input: named after the field for assistive technology
		// ("Sale from", not "Date time"), site wall-clock time in and out, no calendar popover.
		if ( ( field.type === 'datetime' || field.type === 'date' ) && ! field.Edit ) {
			formField.type = undefined;
			formField.Edit = createDateTimeControl( settings ) as ComponentType< DataFormControlProps< FormData > >;
			// The control clears with `undefined`, which would read as "untouched"; an empty string is "no date".
			formField.setValue = ( { value } ) => ( { [ field.id ]: value === undefined ? '' : value } );
		}

		if ( field.type === 'array' ) {
			const sample = rows.map( ( item ) => readFieldValue( field, item ) ).find( ( value ) => Array.isArray( value ) && value.length > 0 ) as unknown[] | undefined;
			const numeric = sample ? sample.every( ( entry ) => typeof entry === 'number' ) : false;

			formField.getValue = ( { item } ) => stringTokens( item[ field.id ] );
			formField.setValue = ( { value } ) => ( {
				[ field.id ]: Array.isArray( value ) ? value.map( ( token ) => ( numeric && INTEGER_PATTERN.test( String( token ) ) ? Number( token ) : String( token ) ) ) : [],
			} );
			formField.elements = stringElements( field.elements );

			if ( field.getElements ) {
				const getElements = field.getElements;

				formField.getElements = async () => stringElements( await getElements() ) ?? [];
			}
		}

		if ( onlyVariations && leaf === 'status' && ! field.Edit ) {
			formField.elements = VARIATION_STATUS_ELEMENTS;
			formField.getElements = undefined;
		}

		// A variation without a class of its own ships like its parent; the product-level "No shipping class" is not a choice here.
		if ( onlyVariations && field.id === 'shipping_class' && ! field.Edit ) {
			formField.elements = variationShippingClassElements( settings );
			formField.getElements = undefined;
		}

		if ( kind ) {
			const shared = isMixed ? state?.placeholder : displayValue( base[ field.id ] );

			formField.type = undefined;
			formField.isValid = undefined;
			formField.Edit = createBulkNumericControl( { kind, settings, placeholder: shared, reference, salePrice: isSalePriceField( field ) } ) as ComponentType< DataFormControlProps< FormData > >;
		} else if ( bulk && field.type === 'boolean' && isMixed && ! field.Edit ) {
			formField.Edit = createMixedBooleanControl( reference );
		} else if ( bulk && isMixed && hasOptionList( field ) ) {
			// Rows disagree: the select shows "Mixed" until the user picks a value for all of them.
			const mixedOption: Option = { value: MIXED_VALUE, label: __( '— Mixed (no change) —', 'wp-woocommerce-products-list' ) };

			if ( formField.getElements ) {
				const getElements = formField.getElements;

				formField.getElements = async () => [ mixedOption, ...( ( await getElements() ) ?? [] ) ];
			} else {
				formField.elements = [ mixedOption, ...( formField.elements ?? [] ) ];
			}
		}

		if ( bulk && formField.isValid?.required ) {
			formField.isValid = { ...formField.isValid, required: false };
		}

		if ( ! bulk ) {
			// Quick edit validates what the classic editor would reject, and says so next to the field.
			if ( leaf === 'name' && field.id === leaf ) {
				formField.isValid = { ...formField.isValid, required: true };
			}

			if ( numericKindOf( field ) === 'integer' ) {
				const custom = formField.isValid?.custom as ( ( item: FormData, def: never ) => string | null ) | undefined;

				formField.isValid = {
					...formField.isValid,
					custom: ( item, def ) => integerMessage( item[ field.id ] ) ?? ( custom ? custom( item, def as never ) : null ),
				};
			}
		}

		return formField;
	} );
}

/** Field labels by id, for error lists. */
export function labelsOf( fields: ProductField[] ): Record< string, string > {
	return Object.fromEntries( fields.map( ( field ) => [ field.id, field.label ?? field.id ] ) );
}
