import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { DateCell } from './components/date-cell';
import { field } from './helpers';

function dateField( id: 'date_created' | 'date_modified', label: string, sortParam: string ): ProductField {
	return field( {
		id,
		type: 'datetime',
		label,
		enableSorting: true,
		filterBy: { operators: [ 'after', 'before' ] },
		readOnly: true,
		render: ( { item } ) => <DateCell value={ item[ id ] } gmt={ ( item as Record< string, unknown > )[ `${ id }_gmt` ] } />,
		getValue: ( { item } ) => item[ id ] ?? '',
		rest: { fields: [ id, `${ id }_gmt` ], param: id, sortParam, applies: { product: true, variation: true } },
		edit: false,
	} );
}

export function createDateFields( _settings: Settings ): ProductField[] {
	return [
		dateField( 'date_created', __( 'Date', 'wp-woocommerce-products-list' ), 'date' ),
		dateField( 'date_modified', __( 'Modified', 'wp-woocommerce-products-list' ), 'modified' ),
	];
}
