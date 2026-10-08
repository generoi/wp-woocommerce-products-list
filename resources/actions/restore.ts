/** Restore from the Trash (wp_untrash_post → the status it had). */
import { __, _n, sprintf } from '@wordpress/i18n';
import { backup } from '@wordpress/icons';
import { runAction } from '../api/client';
import { invalidateProducts, removeItems } from '../store/products';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { canDelete, errorMessage, idsOf, isRealRow, summarize } from './context';
import { notify } from './notices';

export const createRestoreAction: ActionFactory = ( { settings } ) => {
	if ( ! settings.caps.delete ) {
		return null;
	}

	const action: ProductAction = {
		id: 'restore',
		label: __( 'Restore', 'wp-woocommerce-products-list' ),
		icon: backup,
		isPrimary: true,
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && canDelete( item ) && item.status === 'trash',
		callback: ( items, { onActionPerformed } ) => {
			const ids = idsOf( items );

			removeItems( ids );

			void runAction( 'restore', ids, {}, { fields: [ 'id', 'status' ] } )
				.then( ( response ) => {
					const { ok, failed } = summarize( response );

					invalidateProducts( { counts: true } );

					if ( ok.length ) {
						notify.success(
							sprintf(
								/* translators: %d: number of products */
								_n( '%d product restored.', '%d products restored.', ok.length, 'wp-woocommerce-products-list' ),
								ok.length
							)
						);
					}

					if ( failed.length ) {
						notify.error( failed[ 0 ]?.message ?? __( 'The product could not be restored.', 'wp-woocommerce-products-list' ) );
					}

					onActionPerformed?.( items );
				} )
				.catch( ( error: unknown ) => {
					invalidateProducts( { counts: true } );
					notify.error( errorMessage( error ) );
				} );
		},
	};

	return action;
};
