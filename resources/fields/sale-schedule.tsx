import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { DateCell } from './components/date-cell';
import { SELLABLE_TYPES, field } from './helpers';

function scheduleField( id: 'date_on_sale_from' | 'date_on_sale_to', label: string, order: number ): ProductField {
	return field( {
		id,
		type: 'datetime',
		label,
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <DateCell value={ item[ id ] } gmt={ ( item as Record< string, unknown > )[ `${ id }_gmt` ] } withTime />,
		getValue: ( { item } ) => item[ id ] ?? '',
		rest: { fields: [ id, `${ id }_gmt` ], applies: { product: true, variation: true } },
		productTypes: [ ...SELLABLE_TYPES ],
		edit: { group: 'pricing', bulk: 'default', order },
	} );
}

/** The scheduled-sale window; empty means "now" / "forever". */
export function createSaleScheduleFields( _settings: Settings ): ProductField[] {
	return [
		scheduleField( 'date_on_sale_from', __( 'Sale from', 'wp-woocommerce-products-list' ), 22 ),
		scheduleField( 'date_on_sale_to', __( 'Sale to', 'wp-woocommerce-products-list' ), 23 ),
	];
}
