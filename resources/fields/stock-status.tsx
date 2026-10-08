import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { field } from './helpers';

export function createStockStatusField( settings: Settings ): ProductField {
	return field( {
		id: 'stock_status',
		type: 'text',
		label: __( 'Stock', 'wp-woocommerce-products-list' ),
		elements: settings.stockStatuses,
		// wc/v3 validates `stock_status` against its enum: one value at a time.
		filterBy: { operators: [ 'is' ], isPrimary: true },
		enableSorting: false,
		render: ( { item } ) => (
			<span className={ `wc-products-list__stock wc-products-list__stock--${ item.stock_status ?? 'unknown' }` }>
				<OptionCell value={ item.stock_status } options={ settings.stockStatuses } />
			</span>
		),
		getValue: ( { item } ) => item.stock_status ?? '',
		rest: { param: 'stock_status', applies: { product: true, variation: true } },
		edit: { group: 'inventory', bulk: 'default', order: 30 },
	} );
}
