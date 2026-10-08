/** Move to Trash with Undo (restore), rows gone from the page before the request returns. */
import { doAction } from '@wordpress/hooks';
import { __, _n, sprintf } from '@wordpress/i18n';
import { trash } from '@wordpress/icons';
import { runAction } from '../api/client';
import { ACTIONS } from '../extensions/hooks';
import { invalidateProducts, removeItems } from '../store/products';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { canDelete, errorMessage, idsOf, isRealRow, summarize } from './context';
import { notify } from './notices';

export const createTrashAction: ActionFactory = ( { settings } ) => {
	if ( ! settings.caps.delete ) {
		return null;
	}

	const action: ProductAction = {
		id: 'trash',
		label: __( 'Move to Trash', 'wp-woocommerce-products-list' ),
		icon: trash,
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && canDelete( item ) && item.status !== 'trash',
		callback: ( items, { onActionPerformed } ) => {
			const ids = idsOf( items );

			removeItems( ids );

			void runAction( 'trash', ids, {}, { fields: [ 'id', 'status' ] } )
				.then( ( response ) => {
					const { ok, failed } = summarize( response );

					invalidateProducts( { counts: true } );

					if ( ok.length ) {
						doAction( ACTIONS.deleted, ok, { action: 'trash', batchId: response.batch_id } );
						notify.success(
							sprintf(
								/* translators: %d: number of products */
								_n( '%d product moved to the Trash.', '%d products moved to the Trash.', ok.length, 'wp-woocommerce-products-list' ),
								ok.length
							),
							{
								id: `wc-pl-trash-${ response.batch_id }`,
								actions: [
									{
										label: __( 'Undo', 'wp-woocommerce-products-list' ),
										onClick: () => {
											notify.remove( `wc-pl-trash-${ response.batch_id }` );
											void runAction( 'restore', ok, {}, { fields: [ 'id', 'status' ] } )
												.then( ( restored ) => {
													invalidateProducts( { counts: true } );

													const result = summarize( restored );

													if ( result.failed.length ) {
														notify.error( result.failed[ 0 ]?.message ?? '' );
													} else {
														notify.success( __( 'Restored.', 'wp-woocommerce-products-list' ) );
													}
												} )
												.catch( ( error: unknown ) => notify.error( errorMessage( error ) ) );
										},
									},
								],
							}
						);
					}

					if ( failed.length ) {
						notify.error( failed[ 0 ]?.message ?? __( 'The product could not be trashed.', 'wp-woocommerce-products-list' ) );
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
