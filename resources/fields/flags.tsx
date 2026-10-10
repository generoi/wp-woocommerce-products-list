import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { BooleanCell } from './components/boolean-cell';
import { field, valueOf } from './helpers';

function flag( id: string, label: string, options: { variation: boolean; productTypes: ProductField[ 'productTypes' ]; group: string; order: number } ): ProductField {
	return field( {
		id,
		type: 'boolean',
		label,
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <BooleanCell value={ valueOf( item, id ) } />,
		getValue: ( { item } ) => valueOf( item, id ) === true,
		rest: { applies: { product: true, variation: options.variation } },
		productTypes: options.productTypes,
		edit: { group: options.group, bulk: 'default', order: options.order },
	} );
}

export function createFlagFields( _settings: Settings ): ProductField[] {
	return [
		flag( 'virtual', __( 'Virtual', 'wp-woocommerce-products-list' ), { variation: true, productTypes: [ 'simple' ], group: 'shipping', order: 59 } ),
		flag( 'downloadable', __( 'Downloadable', 'wp-woocommerce-products-list' ), { variation: true, productTypes: [ 'simple' ], group: 'advanced', order: 94 } ),
		flag( 'sold_individually', __( 'Sold individually', 'wp-woocommerce-products-list' ), { variation: false, productTypes: 'all', group: 'inventory', order: 35 } ),
		flag( 'reviews_allowed', __( 'Reviews allowed', 'wp-woocommerce-products-list' ), { variation: false, productTypes: 'all', group: 'advanced', order: 95 } ),
	];
}
