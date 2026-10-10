import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { field, valueOf } from './helpers';

export function createExternalFields( _settings: Settings ): ProductField[] {
	return [
		field( {
			id: 'external_url',
			type: 'url',
			label: __( 'Product URL', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			getValue: ( { item } ) => valueOf( item, 'external_url' ) ?? '',
			rest: { applies: { product: true, variation: false } },
			productTypes: [ 'external' ],
			edit: { group: 'external', bulk: 'default', order: 15 },
		} ),
		field( {
			id: 'button_text',
			type: 'text',
			label: __( 'Button text', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			getValue: ( { item } ) => valueOf( item, 'button_text' ) ?? '',
			rest: { applies: { product: true, variation: false } },
			productTypes: [ 'external' ],
			edit: { group: 'external', bulk: 'default', order: 16 },
		} ),
	];
}
