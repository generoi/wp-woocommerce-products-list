/**
 * The DataForm control for money fields: a text input in the shop's
 * notation, stored as a dot-decimal string. Bulk edit wraps it with the
 * set/increase/decrease operation (edit/bulk-numeric-control.tsx).
 */
import { useEffect, useId, useState } from '@wordpress/element';
import { InputControl } from '../../ui';
import { getSettings } from '../../settings';
import type { ProductListItem, Settings } from '../../types';
import type { DataFormControlProps } from '../../dataviews';
import { parsePrice } from '../currency';

export function PriceEdit( { data, field, onChange, hideLabelFromVision, validity }: DataFormControlProps< ProductListItem > ) {
	const settings = getSettings();
	const stored = field.getValue( { item: data } );
	const [ text, setText ] = useState( () => toInput( stored, settings ) );
	// Core wp-components and dataviews' inlined copy each count instances from 1,
	// so their generated ids collide across the form; React's are unique per tree.
	const id = `wc-pl-price-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;

	useEffect( () => {
		setText( toInput( stored, settings ) );
		// Only the stored value and the currency settings matter; `settings` is a stable singleton.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ stored, settings.currency.decimalSeparator, settings.currency.decimals ] );

	const message = validity?.custom?.type === 'invalid' ? validity.custom.message : validity?.min?.type === 'invalid' ? validity.min.message : undefined;

	return (
		<InputControl
			__next40pxDefaultSize
			id={ id }
			label={ field.label }
			hideLabelFromVision={ hideLabelFromVision }
			placeholder={ field.placeholder }
			help={ message }
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
			onBlur={ () => setText( toInput( parsePrice( text, settings ) ?? '', settings ) ) }
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
