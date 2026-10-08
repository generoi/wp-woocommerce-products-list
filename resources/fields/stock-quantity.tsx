import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { PHYSICAL_TYPES, field } from './helpers';

export function createStockQuantityField( _settings: Settings ): ProductField {
	return field( {
		id: 'stock_quantity',
		type: 'integer',
		label: __( 'Quantity', 'wp-woocommerce-products-list' ),
		enableSorting: true,
		filterBy: { operators: [ 'greaterThanOrEqual', 'lessThanOrEqual', 'between' ] },
		render: ( { item } ) => <span className="wc-products-list__qty">{ item.stock_quantity ?? '—' }</span>,
		getValue: ( { item } ) => ( item.stock_quantity === null || item.stock_quantity === undefined ? undefined : item.stock_quantity ),
		rest: { fields: [ 'stock_quantity', 'manage_stock' ], param: 'stock_quantity', sortParam: 'stock_quantity', applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: { group: 'inventory', bulk: 'integer', order: 32 },
	} );
}
