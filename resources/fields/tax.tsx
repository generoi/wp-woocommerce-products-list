import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { field } from './helpers';

export function createTaxStatusField( settings: Settings ): ProductField {
	return field( {
		id: 'tax_status',
		type: 'text',
		label: __( 'Tax status', 'wp-woocommerce-products-list' ),
		elements: settings.taxStatuses,
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <OptionCell value={ item.tax_status } options={ settings.taxStatuses } />,
		getValue: ( { item } ) => item.tax_status ?? 'taxable',
		rest: { applies: { product: true, variation: true } },
		edit: { group: 'tax', bulk: 'default', order: 70 },
	} );
}

export function createTaxClassField( settings: Settings ): ProductField {
	return field( {
		id: 'tax_class',
		type: 'text',
		label: __( 'Tax class', 'wp-woocommerce-products-list' ),
		elements: settings.taxClasses,
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <OptionCell value={ item.tax_class } options={ settings.taxClasses } />,
		getValue: ( { item } ) => item.tax_class ?? '',
		rest: { applies: { product: true, variation: true } },
		edit: { group: 'tax', bulk: 'default', order: 71 },
	} );
}
