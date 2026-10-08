import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { BooleanCell } from './components/boolean-cell';
import { PHYSICAL_TYPES, field } from './helpers';

export function createManageStockField( _settings: Settings ): ProductField {
	return field( {
		id: 'manage_stock',
		type: 'boolean',
		label: __( 'Manage stock', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <BooleanCell value={ item.manage_stock } />,
		getValue: ( { item } ) => item.manage_stock === true,
		rest: { applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: { group: 'inventory', bulk: 'default', order: 31 },
	} );
}
