/**
 * The DataForm control for money fields: a text input in the shop's
 * notation, stored as a dot-decimal string. Bulk edit wraps it with the
 * set/increase/decrease operation (edit/bulk-numeric-control.tsx).
 *
 * The text is the user's while the input has focus: every keystroke is
 * parsed and emitted, and the stored value is not formatted back into the
 * input while it is what the text says (formatting on every change turned
 * "149" into "1,0049"). A value that changes from outside (the editor's
 * load bringing a newer price, a reset, another row) replaces the text at
 * once, also while the input has focus: the box never shows a price other
 * than the one an edit would be based on (the save's expected value).
 */
import { useEffect, useId, useRef, useState } from '@wordpress/element';
import type { ComponentType } from 'react';
import { InputControl } from '../../ui';
import { getSettings } from '../../settings';
import type { ProductListItem, Settings } from '../../types';
import type { DataFormControlProps } from '../../dataviews';
import { parsePrice } from '../currency';

/** The currency a price is in when it is not the shop's (a language's market price in SEK): its symbol and decimals. */
export interface PriceEditCurrency {
	symbol: string;
	decimals: number;
}

export function PriceEdit( props: DataFormControlProps< ProductListItem > ) {
	return <PriceInput { ...props } />;
}

/**
 * The control for a price in another currency (a language's market price): the shop's notation with that currency's
 * symbol and decimals, as the list shows it ("149,50 kr"), not the stored dot-decimal string.
 */
export function createPriceEdit( currency: PriceEditCurrency ): ComponentType< DataFormControlProps< ProductListItem > > {
	return function MarketPriceEdit( props: DataFormControlProps< ProductListItem > ) {
		return <PriceInput { ...props } currency={ currency } />;
	};
}

function PriceInput( { data, field, onChange, hideLabelFromVision, validity, currency }: DataFormControlProps< ProductListItem > & { currency?: PriceEditCurrency } ) {
	const shop = getSettings();
	const settings = currency ? { ...shop, currency: { ...shop.currency, symbol: currency.symbol, decimals: currency.decimals } } : shop;
	const stored = field.getValue( { item: data } );
	const [ text, setText ] = useState( () => toInput( stored, settings ) );
	const focusedRef = useRef( false );
	// Core wp-components and dataviews' inlined copy each count instances from 1,
	// so their generated ids collide across the form; React's are unique per tree.
	const id = `wc-pl-price-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;

	useEffect( () => {
		setText( ( current ) => ( focusedRef.current && samePrice( parsePrice( current, settings ), stored ) ? current : toInput( stored, settings ) ) );
		// Only the stored value and the currency settings matter; `settings` is a stable singleton.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ stored, settings.currency.decimalSeparator, settings.currency.decimals ] );

	// A problem replaces the field's own help (a market price's "Default: 85,00 kr") while it lasts.
	const message = validity?.custom?.type === 'invalid' ? validity.custom.message : validity?.min?.type === 'invalid' ? validity.min.message : undefined;

	return (
		<InputControl
			__next40pxDefaultSize
			id={ id }
			label={ field.label }
			hideLabelFromVision={ hideLabelFromVision }
			placeholder={ field.placeholder }
			help={ message ?? ( field.description || undefined ) }
			inputMode="decimal"
			aria-invalid={ message ? true : undefined }
			className={ message ? 'wc-products-list__price-edit is-invalid' : 'wc-products-list__price-edit' }
			value={ text }
			suffix={ <span className="wc-products-list__price-edit-suffix">{ settings.currency.symbol }</span> }
			onChange={ ( nextValue ) => {
				const next = nextValue ?? '';
				setText( next );
				const parsed = next.trim() === '' ? '' : parsePrice( next, settings );

				if ( parsed !== null ) {
					onChange( field.setValue( { item: data, value: parsed } ) );
				}
			} }
			onFocus={ () => {
				focusedRef.current = true;
			} }
			onBlur={ () => {
				focusedRef.current = false;
				setText( toInput( parsePrice( text, settings ) ?? '', settings ) );
			} }
		/>
	);
}

/** The stored dot-decimal string in the shop's notation with the shop's decimals ('180' → '180,00'). */
export function toInput( value: unknown, settings: Pick< Settings, 'currency' > ): string {
	if ( value === null || value === undefined || value === '' ) {
		return '';
	}

	const number = Number( value );
	const decimals = Math.max( 0, settings.currency.decimals ?? 0 );
	const text = Number.isFinite( number ) ? number.toFixed( decimals ) : String( value );

	return text.replace( '.', settings.currency.decimalSeparator );
}

/** Whether typed text (parsed) and a stored price are the same amount ('' and null alike). */
function samePrice( parsed: string | null, stored: unknown ): boolean {
	if ( parsed === null ) {
		return false;
	}

	const empty = ( value: unknown ) => value === null || value === undefined || value === '';

	if ( empty( parsed ) || empty( stored ) ) {
		return empty( parsed ) && empty( stored );
	}

	return Number( parsed ) === Number( stored );
}
