import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { MoneyCell } from './components/price-cell';
import { PriceEdit } from './components/price-edit';
import { isValidPrice } from './currency';
import { SELLABLE_TYPES, field } from './helpers';

export function createRegularPriceField( _settings: Settings ): ProductField {
	return field( {
		id: 'regular_price',
		type: 'text',
		label: __( 'Regular price', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <MoneyCell value={ item.regular_price } />,
		getValue: ( { item } ) => item.regular_price ?? '',
		Edit: PriceEdit,
		isValid: {
			custom: ( item ) => ( isValidPrice( item.regular_price ) ? null : __( 'Enter a valid price.', 'wp-woocommerce-products-list' ) ),
		},
		rest: { applies: { product: true, variation: true } },
		productTypes: [ ...SELLABLE_TYPES ],
		edit: { group: 'pricing', bulk: 'money', order: 20 },
	} );
}
