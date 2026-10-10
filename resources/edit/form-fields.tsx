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
import { toInput } from '../fields/components/price-edit';
import type { ProductField, ProductListItem, Settings } from '../types';
import { isSalePriceField, numericKindOf } from './bulk-numeric';
import { createBulkNumericControl } from './bulk-numeric-control';
import type { FormData } from './bulk-numeric-control';
import { createDateTimeControl } from './datetime-control';
import { isVariableParent, isVariation, readFieldValue } from './field-value';
import { mergeReference, MIXED_VALUE, hasOptionList } from './merge';
import type { MixedState } from './merge';
import { createMixedBooleanControl } from './mixed-boolean-control';
import { createHtmlTextControl } from './html-text-control';
import { createMixedTextControl } from './mixed-text-control';
import { createTermTokensControl } from './term-tokens-control';
import { SCHEDULE_SALE_FIELD_ID } from './payload';
import { isStockGatedEdit, managesStock } from './row-rules';
import { saleDateProblem } from './sale-schedule';
import { isParentDerivedField, isSellableField, leafOf } from './visibility';

export type { FormData } from './bulk-numeric-control';

export interface FormFieldOptions {
	bulk: boolean;
	items: ProductListItem[];
	/** The merged record (shared values), for placeholders. */
	base: Record< string, unknown >;
	mixed: Record< string, MixedState >;
	settings: Settings;
	/** Fields whose values are still loading: shown read-only until they are there (nothing is typed over a value the form did not show). */
	pending?: ReadonlySet< string >;
	/** The labels the form shows, by field id, where they differ from the field's (formLabelOf in form-layouts.ts). */
	labels?: Record< string, string >;
	/**
	 * A quick edit of a variable product setting the price of all its variations: the price fields take the bulk
	 * operations (change to, regular price minus 20 %…), since its variations' prices can differ.
	 */
	sellableOps?: boolean;
	/** General-tab values with an unsaved edit (`name`): a language field's "Default:" hint shows what was typed, not the saved text. */
	editedDefaults?: Record< string, unknown >;
}

/**
 * How many rows take a stock status with the form's Manage stock value: not a variable product (its variations decide
 * it) and not a row that manages stock (its quantity decides it). `manageStock` is the form's value: true or false
 * for every row, anything else (untouched, mixed) leaves each row as it is.
 */
export function stockStatusTakers( rows: ProductListItem[], manageStock: unknown ): number {
	return rows.filter( ( item ) => ! isVariableParent( item ) && ( manageStock === false || ( manageStock !== true && ! managesStock( item ) ) ) ).length;
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

/** The tax classes a variation can pick: its parent's (stored as `parent`, WooCommerce's own value), or one of the store's. */
export function variationTaxClassElements( settings: Pick< Settings, 'taxClasses' > ): Option[] {
	return [ { value: 'parent', label: __( 'Same as parent', 'wp-woocommerce-products-list' ) }, ...settings.taxClasses.map( ( entry ) => ( { value: String( entry.value ), label: entry.label } ) ) ];
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

/** A money field: a core price, or an extension's price column (it carries its currency, also when it takes no bulk op). */
function isMoneyField( field: ProductField ): boolean {
	return numericKindOf( field ) === 'money' || ( field as { currency?: FieldCurrency } ).currency !== undefined;
}

/** Reference text for the help line: money formatted, HTML stripped, long text cut. */
export function referenceText( field: ProductField, reference: string, settings: Settings ): string {
	if ( isMoneyField( field ) ) {
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

/** A free-text field rendered by DataForm's text control: no options, no custom control, no numeric op. */
export function isPlainTextField( field: ProductField ): boolean {
	return ( field.type === 'text' || field.type === undefined ) && ! field.Edit && ! hasOptionList( field ) && numericKindOf( field ) === null;
}

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
	const { bulk, items, base, mixed, settings, pending, labels, sellableOps = false, editedDefaults = {} } = options;
	const ids = new Set( fields.map( ( field ) => field.id ) );
	const rows = items.filter( ( item ) => ! item._placeholder );
	const onlyVariations = rows.length > 0 && rows.every( isVariation );
	const onlyVariableParents = rows.length > 0 && rows.every( isVariableParent );
	const someVariableParents = rows.some( isVariableParent );
	const noRowManagesStock = rows.length > 0 && ! rows.some( managesStock );

	return fields.map( ( field ) => {
		const state = mixed[ field.id ];
		const isMixed = state?.isMixed === true;
		const reference = mergeReference( items, field );
		const kind = bulk || ( sellableOps && isSellableField( field ) ) ? numericKindOf( field ) : null;
		const scheduleId = scheduleIdFor( field.id );
		const leaf = leafOf( field.id );

		const formField: Field< FormData > = {
			id: field.id,
			label: labels?.[ field.id ] ?? field.label ?? field.id,
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

		// Texts only: a language's price is in that market's currency, its default in the shop's.
		const edited = reference !== null && leaf !== field.id && ! isMoneyField( field ) && Object.prototype.hasOwnProperty.call( editedDefaults, leaf ) ? editedDefaults[ leaf ] : undefined;

		if ( typeof edited === 'string' && edited !== '' ) {
			formField.description = sprintf(
				/* translators: %s: the default-language value as typed on the General tab, not saved yet */
				__( 'Default (not saved yet): %s', 'wp-woocommerce-products-list' ),
				referenceText( field, edited, settings )
			);
		} else if ( reference !== null && reference !== '' ) {
			formField.description = sprintf(
				/* translators: %s: the default-language value */
				__( 'Default: %s', 'wp-woocommerce-products-list' ),
				referenceText( field, reference, settings )
			);

			// One row whose shop text comes from a fallback language: say what is shown now first.
			const shown = rows.length === 1 && field.shownReference ? field.shownReference( rows[ 0 ] as ProductListItem ) : null;

			if ( shown ) {
				formField.description = sprintf(
					/* translators: 1: "Shown now (English fallback)", 2: that text, 3: "Default: <default-language text>" */
					__( '%1$s: %2$s · %3$s', 'wp-woocommerce-products-list' ),
					shown.label,
					referenceText( field, shown.text, settings ),
					formField.description
				);
			}
		}

		if ( scheduleId && ids.has( scheduleId ) ) {
			formField.isVisible = ( data ) => data[ scheduleId ] === true;
		}

		// Our own datetime-local input: named after the field for assistive technology
		// ("Sale from", not "Date time"), site wall-clock time in and out, no calendar popover.
		if ( ( field.type === 'datetime' || field.type === 'date' ) && ! field.Edit ) {
			const problem = ( data: FormData, fieldId: string ) => saleDateProblem( data, fieldId, ids );

			formField.type = undefined;
			formField.Edit = createDateTimeControl( settings, { problem } ) as ComponentType< DataFormControlProps< FormData > >;
			// The control clears with `undefined`, which would read as "untouched"; an empty string is "no date".
			formField.setValue = ( { value } ) => ( { [ field.id ]: value === undefined ? '' : value } );
			// A half-typed date or an end before the start blocks Update (quick and bulk alike, inline-editor.tsx).
			formField.isValid = { ...formField.isValid, custom: ( item: FormData ) => problem( item, field.id ) };
		}

		if ( field.type === 'array' ) {
			const sample = rows.map( ( item ) => readFieldValue( field, item ) ).find( ( value ) => Array.isArray( value ) && value.length > 0 ) as unknown[] | undefined;
			const numeric = sample ? sample.every( ( entry ) => typeof entry === 'number' ) : false;

			const picked = ! field.Edit && ( Array.isArray( field.elements ) || typeof field.getElements === 'function' );

			formField.getValue = ( { item } ) => stringTokens( item[ field.id ] );
			// A list picked from known options (term ids) never keeps a token that is not one: a typed name
			// would otherwise reach the save as `{id: null}` and WooCommerce would drop every term.
			formField.setValue = ( { value } ) => ( {
				[ field.id ]: Array.isArray( value )
					? value
							.map( String )
							.filter( ( token ) => ! numeric || INTEGER_PATTERN.test( token ) )
							.filter( ( token ) => ! picked || ! numeric || Number( token ) > 0 )
							.map( ( token ) => ( numeric ? Number( token ) : token ) )
					: [],
			} );

			if ( picked ) {
				// Typed and suggested by name, kept as ids (DataViews' own control matches what is typed against the ids).
				formField.Edit = createTermTokensControl();
			}
			formField.elements = stringElements( field.elements );

			if ( field.getElements ) {
				const getElements = field.getElements;

				formField.getElements = async () => stringElements( await getElements() ) ?? [];
			}
		}

		if ( onlyVariations && leaf === 'status' && ! field.Edit ) {
			formField.elements = VARIATION_STATUS_ELEMENTS;
			formField.getElements = undefined;
			formField.description ??= __( 'Inactive variations cannot be bought.', 'wp-woocommerce-products-list' );
		}

		// A variable product's own stock is the whole product's; restocking sizes happens on the variations.
		if ( onlyVariableParents && field.id === 'manage_stock' ) {
			formField.description ??= __( 'Stock for the product as a whole. Each variation (a size, a colour) can keep its own stock.', 'wp-woocommerce-products-list' );
		}

		// WooCommerce works the stock status out from the quantity of a row that manages stock, and a variable product's from
		// its variations: the edit skips those rows (row-rules.ts, visibility.ts). The status is offered only while some
		// row still takes it with the Manage stock the form shows (in a bulk edit too: a field every row would skip is a
		// dead end; the Inventory card says what to do instead, inline-editor.tsx).
		if ( isParentDerivedField( field ) && field.id === leaf && ids.has( 'manage_stock' ) ) {
			formField.isVisible = ( data ) => stockStatusTakers( rows, data.manage_stock ) > 0;
		}

		if ( isParentDerivedField( field ) ) {
			if ( bulk && someVariableParents ) {
				formField.description ??= __( 'Skipped for variable products (their variations decide it) and for items that manage stock (their quantity decides it).', 'wp-woocommerce-products-list' );
			} else if ( bulk ) {
				formField.description ??= __( 'Skipped for items that manage stock: their quantity decides it.', 'wp-woocommerce-products-list' );
			}
		}

		// As WooCommerce's product screen: quantity, backorders and the low stock threshold show once Manage stock is on
		// (WooCommerce ignores them otherwise). A bulk edit keeps them, for the rows that do manage stock.
		if ( ! bulk && field.id === leaf && isStockGatedEdit( field.id ) && ids.has( 'manage_stock' ) ) {
			formField.isVisible = ( data ) => data.manage_stock === true;
		}

		// A bulk edit of rows none of which manages stock: the same, so a quantity is never typed for rows that would all
		// skip it, nor is the shared "Do not allow" read as a change about to be made. Ticking Manage stock shows them.
		if ( bulk && noRowManagesStock && field.id === leaf && isStockGatedEdit( field.id ) && ids.has( 'manage_stock' ) ) {
			formField.isVisible = ( data ) => data.manage_stock === true;
		}

		if ( bulk && noRowManagesStock && field.id === 'manage_stock' ) {
			const none = __( 'None of these items manages stock. Tick it to set the stock quantity, backorders and low stock threshold.', 'wp-woocommerce-products-list' );

			formField.description = typeof formField.description === 'string' && formField.description ? `${ formField.description } ${ none }` : formField.description ?? none;
		}

		if ( ! bulk && field.id === 'manage_stock' ) {
			formField.description ??= onlyVariations ? __( 'Track stock quantity for this variation.', 'wp-woocommerce-products-list' ) : __( 'Track stock quantity for this product.', 'wp-woocommerce-products-list' );
		}

		// A variation without a class of its own ships like its parent; the product-level "No shipping class" is not a choice here.
		if ( onlyVariations && field.id === 'shipping_class' && ! field.Edit ) {
			formField.elements = variationShippingClassElements( settings );
			formField.getElements = undefined;
		}

		// A variation stores `parent` to use its parent's tax class (every variation WooCommerce creates starts so); without it in the list, a variation that was never given a class of its own fails validation.
		if ( onlyVariations && field.id === 'tax_class' && ! field.Edit ) {
			formField.elements = variationTaxClassElements( settings );
			formField.getElements = undefined;
		}

		if ( kind ) {
			const fieldCurrency = ( field as { currency?: FieldCurrency } ).currency;
			const current = displayValue( base[ field.id ] );
			// A shared price in the notation the input takes ("15,50"), not the stored one ("15.5").
			const shown = kind === 'money' && current !== '' ? toInput( current, fieldCurrency ? { currency: { ...settings.currency, decimals: fieldCurrency.decimals } } : settings ) : current;
			const shared = isMixed ? state?.placeholder : shown;

			formField.type = undefined;
			formField.isValid = undefined;
			formField.Edit = createBulkNumericControl( {
				kind,
				settings,
				placeholder: shared,
				reference: reference !== null && reference !== '' ? referenceText( field, reference, settings ) : reference,
				salePrice: isSalePriceField( field ),
				currency: ( field as { currency?: FieldCurrency } ).currency,
			} ) as ComponentType< DataFormControlProps< FormData > >;
		} else if ( bulk && field.type === 'boolean' && isMixed && ! field.Edit ) {
			formField.Edit = createMixedBooleanControl( reference );
		} else if ( bulk && isMixed && isPlainTextField( field ) ) {
			// Rows disagree: "Mixed" until something is typed; erasing it is no change again, and
			// emptying every row is the explicit "Clear on all rows" choice.
			formField.type = undefined;
			formField.Edit = createMixedTextControl();
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

		// HTML (descriptions and their translations): a formatted-text editor with a Code view, not raw markup in
		// a textarea. Not for a bulk field whose rows disagree, which keeps its "Mixed" control.
		if ( field.html && ! kind && ! ( bulk && isMixed ) ) {
			const edit = field.Edit as { rows?: number } | undefined;

			formField.type = undefined;
			formField.Edit = createHtmlTextControl( { rows: typeof edit === 'object' && edit && typeof edit.rows === 'number' ? edit.rows : 4 } );
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

		if ( pending?.has( field.id ) ) {
			formField.readOnly = true;
		}

		return formField;
	} );
}

/** Field labels by id, for error lists. */
export function labelsOf( fields: ProductField[] ): Record< string, string > {
	return Object.fromEntries( fields.map( ( field ) => [ field.id, field.label ?? field.id ] ) );
}
