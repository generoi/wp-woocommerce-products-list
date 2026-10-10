import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { PHYSICAL_TYPES, field } from './helpers';

export function createBackordersField( settings: Settings ): ProductField {
	return field( {
		id: 'backorders',
		type: 'text',
		label: __( 'Backorders', 'wp-woocommerce-products-list' ),
		elements: settings.backorders,
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <OptionCell value={ item.backorders } options={ settings.backorders } />,
		getValue: ( { item } ) => item.backorders ?? 'no',
		rest: { applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: { group: 'inventory', bulk: 'default', order: 33, label: __( 'Allow backorders?', 'wp-woocommerce-products-list' ) },
	} );
}
