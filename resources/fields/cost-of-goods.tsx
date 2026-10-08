import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { MoneyCell } from './components/price-cell';
import { PriceEdit } from './components/price-edit';
import { field } from './helpers';

type Cogs = { values?: Array< { defined_value: number; effective_value: number } >; total_value?: number };

function cogsValue( item: { cost_of_goods_sold?: Cogs } ): string {
	const defined = item.cost_of_goods_sold?.values?.[ 0 ]?.defined_value;

	return defined === undefined || defined === null ? '' : String( defined );
}

/** Only when WooCommerce's Cost of Goods Sold feature is on. */
export function createCostOfGoodsField( settings: Settings ): ProductField | null {
	if ( ! settings.features.cogs ) {
		return null;
	}

	return field( {
		id: 'cost_of_goods_sold',
		type: 'text',
		label: __( 'Cost', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <MoneyCell value={ cogsValue( item ) } />,
		getValue: ( { item } ) => cogsValue( item ),
		setValue: ( { value } ) => ( { cost_of_goods_sold: { values: [ { defined_value: Number( value ), effective_value: Number( value ) } ] } } ) as never,
		Edit: PriceEdit,
		rest: {
			read: ( item ) => cogsValue( item ),
			write: ( value ) => ( { cost_of_goods_sold: { values: [ { defined_value: value === '' || value === null ? 0 : Number( value ) } ] } } ),
			applies: { product: true, variation: true },
		},
		edit: { group: 'pricing', bulk: 'money', order: 25 },
	} );
}
