import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { field, valueOf } from './helpers';

export function createCatalogVisibilityField( settings: Settings ): ProductField {
	return field( {
		id: 'catalog_visibility',
		type: 'text',
		label: __( 'Catalog visibility', 'wp-woocommerce-products-list' ),
		elements: settings.catalogVisibility,
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <OptionCell value={ valueOf( item, 'catalog_visibility' ) } options={ settings.catalogVisibility } />,
		getValue: ( { item } ) => valueOf( item, 'catalog_visibility' ) ?? 'visible',
		rest: { applies: { product: true, variation: false } },
		edit: { group: 'visibility', bulk: 'default', order: 51 },
	} );
}
