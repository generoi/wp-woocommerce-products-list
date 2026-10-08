/** Open the product on the shop in a new tab. */
import { __ } from '@wordpress/i18n';
import { seen } from '@wordpress/icons';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { isRealRow } from './context';

export const createViewAction: ActionFactory = () => {
	const action: ProductAction = {
		id: 'view',
		label: ( items ) => ( items[ 0 ]?.status === 'publish' ? __( 'View', 'wp-woocommerce-products-list' ) : __( 'Preview', 'wp-woocommerce-products-list' ) ),
		icon: seen,
		supportsBulk: false,
		isEligible: ( item ) => isRealRow( item ) && typeof item.permalink === 'string' && item.permalink !== '' && item.status !== 'trash',
		callback: ( items ) => {
			const link = items[ 0 ]?.permalink;

			if ( link ) {
				window.open( link, '_blank', 'noopener' );
			}
		},
	};

	return action;
};
