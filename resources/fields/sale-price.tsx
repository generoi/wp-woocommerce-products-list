import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { MoneyCell } from './components/price-cell';
import { PriceEdit } from './components/price-edit';
import { isValidPrice } from './currency';
import { SELLABLE_TYPES, field } from './helpers';

/** Sale price must stay below the regular price (Woo's rule, projected per item in bulk). */
export function saleBelowRegular( sale: unknown, regular: unknown ): boolean {
	if ( sale === '' || sale === null || sale === undefined || regular === '' || regular === null || regular === undefined ) {
		return true;
	}

	const s = Number( sale );
	const r = Number( regular );

	return ! Number.isFinite( s ) || ! Number.isFinite( r ) || s < r;
}

export function createSalePriceField( _settings: Settings ): ProductField {
	return field( {
		id: 'sale_price',
		type: 'text',
		label: __( 'Sale price', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <MoneyCell value={ item.sale_price } />,
		getValue: ( { item } ) => item.sale_price ?? '',
		Edit: PriceEdit,
		isValid: {
			custom: ( item ) => {
				if ( ! isValidPrice( item.sale_price ) ) {
					return __( 'Enter a valid price.', 'wp-woocommerce-products-list' );
				}

				return saleBelowRegular( item.sale_price, item.regular_price ) ? null : __( 'The sale price must be lower than the regular price.', 'wp-woocommerce-products-list' );
			},
		},
		rest: { fields: [ 'sale_price', 'regular_price' ], applies: { product: true, variation: true } },
		productTypes: [ ...SELLABLE_TYPES ],
		edit: { group: 'pricing', bulk: 'money', order: 21 },
	} );
}
