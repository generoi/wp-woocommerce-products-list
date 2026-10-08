/**
 * Add every variation of the selected variable products to the selection
 * (expanding them first: DataViews keeps only ids that are in `data`).
 * Needs the screen's `onChangeSelection`; without it the action is hidden.
 */
import { __ } from '@wordpress/i18n';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { idsOf, isRealRow } from './context';
import { notify } from './notices';

export const createSelectVariationsAction: ActionFactory = ( { hierarchy, onChangeSelection, selection } ) => {
	if ( ! onChangeSelection ) {
		return null;
	}

	const action: ProductAction = {
		id: 'select-variations',
		label: __( 'Select all variations', 'wp-woocommerce-products-list' ),
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && item._hasChildren,
		callback: ( items ) => {
			void ( async () => {
				let current = selection ?? [];

				try {
					for ( const id of idsOf( items ) ) {
						current = await hierarchy.selectVariations( id, current );
					}

					onChangeSelection( current );
				} catch ( error ) {
					notify.error( error instanceof Error ? error.message : __( 'The variations could not be loaded.', 'wp-woocommerce-products-list' ) );
				}
			} )();
		},
	};

	return action;
};
