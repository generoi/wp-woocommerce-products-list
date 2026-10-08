import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { NameCell } from './components/name-cell';
import { field } from './helpers';

export function createNameField( _settings: Settings ): ProductField {
	return field( {
		id: 'name',
		type: 'text',
		label: __( 'Name', 'wp-woocommerce-products-list' ),
		enableHiding: false,
		enableSorting: true,
		enableGlobalSearch: true,
		filterBy: false,
		render: NameCell,
		getValue: ( { item } ) => item.name ?? '',
		rest: { fields: [ 'name', 'permalink' ], sortParam: 'title', applies: { product: true, variation: true } },
		edit: { group: 'general', bulk: false, order: 0 },
	} );
}
