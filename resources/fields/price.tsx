import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { PriceCell } from './components/price-cell';
import { field } from './helpers';

/** The effective price (computed by WooCommerce; read-only). */
export function createPriceField( _settings: Settings ): ProductField {
	return field( {
		id: 'price',
		type: 'number',
		label: __( 'Price', 'wp-woocommerce-products-list' ),
		enableSorting: true,
		filterBy: { operators: [ 'greaterThanOrEqual', 'lessThanOrEqual', 'between' ] },
		readOnly: true,
		render: PriceCell,
		getValue: ( { item } ) => ( item.price === '' || item.price === undefined ? undefined : Number( item.price ) ),
		rest: {
			fields: [ 'price', 'regular_price', 'sale_price', 'on_sale', 'date_on_sale_from', 'date_on_sale_from_gmt', 'date_on_sale_to' ],
			param: 'price',
			sortParam: 'price',
			applies: { product: true, variation: true },
		},
		edit: false,
	} );
}
