import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { ImageCell, firstImage } from './components/image-cell';
import { field } from './helpers';

export function createImagesField( _settings: Settings ): ProductField {
	return field( {
		id: 'images',
		type: 'media',
		label: __( 'Image', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ImageCell,
		getValue: ( { item } ) => firstImage( item )?.src ?? '',
		rest: { fields: [ 'images' ], applies: { product: true, variation: true } },
		edit: false,
	} );
}
