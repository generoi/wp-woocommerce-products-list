import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { BooleanCell } from './components/boolean-cell';
import { field } from './helpers';

export function createOnSaleField( _settings: Settings ): ProductField {
	return field( {
		id: 'on_sale',
		type: 'boolean',
		label: __( 'On sale', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: { operators: [ 'is' ] },
		readOnly: true,
		render: ( { item } ) => <BooleanCell value={ item.on_sale } />,
		getValue: ( { item } ) => item.on_sale === true,
		rest: { param: 'on_sale', applies: { product: true, variation: true } },
		edit: false,
	} );
}
