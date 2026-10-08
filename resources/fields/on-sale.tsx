import { __ } from '@wordpress/i18n';
import type { ProductField, ProductListItem, Settings } from '../types';
import { BooleanCell } from './components/boolean-cell';
import { scheduledSale } from './components/price-cell';
import { field } from './helpers';

/** `true` / `false` for wc/v3's `on_sale`; `scheduled` when a sale is set but has not started. */
export function saleState( item: ProductListItem ): 'true' | 'false' | 'scheduled' {
	if ( item.on_sale === true ) {
		return 'true';
	}

	return scheduledSale( item ) ? 'scheduled' : 'false';
}

export function createOnSaleField( _settings: Settings ): ProductField {
	return field( {
		id: 'on_sale',
		label: __( 'On sale', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		// Each option carries its own params: `on_sale` is wc/v3's, `sale_scheduled` the plugin's (Rest\ListQuery).
		elements: [
			{ value: 'true', label: __( 'On sale', 'wp-woocommerce-products-list' ), params: { on_sale: true } },
			{ value: 'false', label: __( 'Not on sale', 'wp-woocommerce-products-list' ), params: { on_sale: false } },
			{ value: 'scheduled', label: __( 'Sale scheduled', 'wp-woocommerce-products-list' ), params: { sale_scheduled: true } },
		] as unknown as ProductField[ 'elements' ],
		filterBy: { operators: [ 'is' ] },
		readOnly: true,
		render: ( { item } ) => {
			const state = saleState( item );

			return state === 'scheduled' ? <span className="wc-products-list__bool wc-products-list__bool--scheduled">{ __( 'Scheduled', 'wp-woocommerce-products-list' ) }</span> : <BooleanCell value={ state === 'true' } />;
		},
		getValue: ( { item } ) => saleState( item ),
		rest: { fields: [ 'on_sale', 'sale_price', 'date_on_sale_from', 'date_on_sale_from_gmt' ], param: 'on_sale', applies: { product: true, variation: true } },
		edit: false,
	} );
}
