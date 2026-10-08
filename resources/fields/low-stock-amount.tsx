import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { PHYSICAL_TYPES, field } from './helpers';

export function createLowStockAmountField( _settings: Settings ): ProductField {
	return field( {
		id: 'low_stock_amount',
		type: 'integer',
		label: __( 'Low stock threshold', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <span>{ item.low_stock_amount ?? '—' }</span>,
		getValue: ( { item } ) => item.low_stock_amount ?? undefined,
		rest: { applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: { group: 'inventory', bulk: 'integer', order: 34 },
	} );
}
