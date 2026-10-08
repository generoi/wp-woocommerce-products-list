/** Expand / collapse the variations of variable products. */
import { __ } from '@wordpress/i18n';
import { chevronDown } from '@wordpress/icons';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { idsOf, isRealRow } from './context';

export const createExpandAction: ActionFactory = ( { hierarchy } ) => {
	const action: ProductAction = {
		id: 'expand',
		label: ( items ) => {
			const ids = idsOf( items );
			const allExpanded = ids.length > 0 && ids.every( ( id ) => hierarchy.isExpanded( id ) );

			return allExpanded ? __( 'Collapse variations', 'wp-woocommerce-products-list' ) : __( 'Expand variations', 'wp-woocommerce-products-list' );
		},
		icon: chevronDown,
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && item._hasChildren,
		callback: ( items ) => {
			const ids = idsOf( items );
			const allExpanded = ids.length > 0 && ids.every( ( id ) => hierarchy.isExpanded( id ) );

			for ( const id of ids ) {
				if ( allExpanded ) {
					hierarchy.collapse( id );
				} else {
					void hierarchy.expand( id );
				}
			}
		},
	};

	return action;
};
