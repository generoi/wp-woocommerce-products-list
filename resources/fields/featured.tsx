import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { BooleanCell } from './components/boolean-cell';
import { field, valueOf } from './helpers';

export function createFeaturedField( _settings: Settings ): ProductField {
	return field( {
		id: 'featured',
		type: 'boolean',
		label: __( 'Featured', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: { operators: [ 'is' ] },
		render: ( { item } ) => <BooleanCell value={ valueOf( item, 'featured' ) } />,
		getValue: ( { item } ) => valueOf( item, 'featured' ) === true,
		rest: { param: 'featured', applies: { product: true, variation: false } },
		edit: { group: 'visibility', bulk: 'default', order: 50 },
	} );
}
