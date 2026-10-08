import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { field } from './helpers';

export function createSkuField( _settings: Settings ): ProductField {
	return field( {
		id: 'sku',
		type: 'text',
		label: __( 'SKU', 'wp-woocommerce-products-list' ),
		enableSorting: true,
		enableGlobalSearch: true,
		filterBy: false,
		render: ( { item } ) => <code className="wc-products-list__sku">{ item.sku || '—' }</code>,
		getValue: ( { item } ) => item.sku ?? '',
		rest: { sortParam: 'sku', applies: { product: true, variation: true } },
		edit: { group: 'general', bulk: false, order: 10 },
	} );
}
