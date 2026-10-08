import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { field } from './helpers';

/**
 * The stock status, with the managed quantity beside it ("In stock · 12")
 * so a restock can be planned from the list without another column.
 */
export function createStockStatusField( settings: Settings ): ProductField {
	return field( {
		id: 'stock_status',
		type: 'text',
		label: __( 'Stock', 'wp-woocommerce-products-list' ),
		elements: settings.stockStatuses,
		// wc/v3 validates `stock_status` against its enum: one value at a time.
		filterBy: { operators: [ 'is' ], isPrimary: true },
		// Sorted by the managed quantity (Rest\ListQuery `orderby=stock_quantity`):
		// ascending puts what is out and what is low first, the restock view.
		enableSorting: true,
		render: ( { item } ) => {
			const managed = item.manage_stock === true && typeof item.stock_quantity === 'number';

			return (
				<span className={ `wc-products-list__stock wc-products-list__stock--${ item.stock_status ?? 'unknown' }` }>
					<OptionCell value={ item.stock_status } options={ settings.stockStatuses } />
					{ managed && (
						<span className="wc-products-list__stock-qty" title={ __( 'Stock quantity', 'wp-woocommerce-products-list' ) }>
							{ item.stock_quantity }
						</span>
					) }
				</span>
			);
		},
		getValue: ( { item } ) => item.stock_status ?? '',
		rest: { fields: [ 'stock_status', 'stock_quantity', 'manage_stock' ], param: 'stock_status', sortParam: 'stock_quantity', applies: { product: true, variation: true } },
		edit: { group: 'inventory', bulk: 'default', order: 30 },
	} );
}
