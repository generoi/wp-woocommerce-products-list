/**
 * The DataForm control for money fields: a text input in the shop's
 * notation, stored as a dot-decimal string. Bulk edit wraps it with the
 * set/increase/decrease operation (edit/bulk-numeric-control.tsx).
 */
import { useEffect, useState } from '@wordpress/element';
import { InputControl } from '../../ui';
import { getSettings } from '../../settings';
import type { ProductListItem } from '../../types';
import type { DataFormControlProps } from '../../dataviews';
import { parsePrice } from '../currency';

export function PriceEdit( { data, field, onChange, hideLabelFromVision, validity }: DataFormControlProps< ProductListItem > ) {
	const settings = getSettings();
	const stored = field.getValue( { item: data } );
	const [ text, setText ] = useState( () => toInput( stored, settings.currency.decimalSeparator ) );

	useEffect( () => {
		setText( toInput( stored, settings.currency.decimalSeparator ) );
	}, [ stored, settings.currency.decimalSeparator ] );

	const message = validity?.custom?.type === 'invalid' ? validity.custom.message : validity?.min?.type === 'invalid' ? validity.min.message : undefined;

	return (
		<InputControl
			__next40pxDefaultSize
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
			onBlur={ () => setText( toInput( parsePrice( text, settings ) ?? '', settings.currency.decimalSeparator ) ) }
		/>
	);
}

function toInput( value: unknown, decimalSeparator: string ): string {
	if ( value === null || value === undefined || value === '' ) {
		return '';
	}

	return String( value ).replace( '.', decimalSeparator );
}
