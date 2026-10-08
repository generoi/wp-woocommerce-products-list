import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { field } from './helpers';

export function createTypeField( settings: Settings ): ProductField {
	const options = [ ...settings.productTypes, { value: 'variation', label: __( 'Variation', 'wp-woocommerce-products-list' ) } ];

	return field( {
		id: 'type',
		type: 'text',
		label: __( 'Type', 'wp-woocommerce-products-list' ),
		elements: settings.productTypes,
		filterBy: { operators: [ 'isAny', 'isNone' ] },
		enableSorting: false,
		render: ( { item } ) => <OptionCell value={ item._kind === 'variation' ? 'variation' : ( item as { type?: string } ).type } options={ options } />,
		getValue: ( { item } ) => ( item as { type?: string } ).type ?? '',
		rest: { param: 'include_types', applies: { product: true, variation: true } },
		edit: false,
	} );
}
