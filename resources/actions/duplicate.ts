/** Copy products through the server action (WC_Admin_Duplicate_Product); the copies are drafts. */
import { __, _n, sprintf } from '@wordpress/i18n';
import { copy } from '@wordpress/icons';
import { newBatchId, runAction } from '../api/client';
import { allFailed, failureNoticeActions, recordFailedRows, unansweredResults } from '../edit/failed-rows';
import { invalidateProducts } from '../store/products';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { canEdit, errorMessage, idsOf, isRealRow, rowFields, summarize } from './context';
import { notify } from './notices';

export const createDuplicateAction: ActionFactory = ( context ) => {
	const { settings, fields } = context;

	if ( ! settings.caps.edit ) {
		return null;
	}

	const action: ProductAction = {
		id: 'duplicate',
		label: __( 'Duplicate', 'wp-woocommerce-products-list' ),
		icon: copy,
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && canEdit( item ) && item.status !== 'trash',
		callback: ( items, { onActionPerformed } ) => {
			const ids = idsOf( items );
			const batchId = newBatchId();

			void runAction( 'duplicate', ids, {}, { fields: rowFields( fields ), batchId } )
				.then( ( response ) => {
					const { ok, failed } = summarize( response );
					const newIds = response.results.filter( ( result ) => result.ok ).map( ( result ) => Number( result.data?.new_id ) ).filter( ( id ) => Number.isInteger( id ) && id > 0 );

					invalidateProducts( { counts: true } );

					if ( ok.length ) {
						const single = newIds.length === 1 && settings.links.editProduct ? sprintf( settings.links.editProduct as '%d', newIds[ 0 ] ?? 0 ) : null;

						notify.success(
							sprintf(
								/* translators: %d: number of products copied */
								_n( '%d product duplicated as a draft.', '%d products duplicated as drafts.', ok.length, 'wp-woocommerce-products-list' ),
								ok.length
							),
							single ? { actions: [ { label: __( 'Edit copy', 'wp-woocommerce-products-list' ), url: single } ] } : undefined
						);
					}

					if ( failed.length ) {
						// The ids whose request failed have no row on the server: recorded as failed (the others it logged).
						recordFailedRows( batchId, 'action', unansweredResults( response.results ), { action: 'duplicate' } );
						notify.error( failed[ 0 ]?.message ?? __( 'The product could not be duplicated.', 'wp-woocommerce-products-list' ), { actions: failureNoticeActions( batchId, failed ) } );
					}

						onActionPerformed?.( items );
				} )
				.catch( ( error: unknown ) => {
					const failed = allFailed( ids, errorMessage( error ) );

					recordFailedRows( batchId, 'action', failed, { action: 'duplicate' } );
					notify.error( errorMessage( error ), { actions: failureNoticeActions( batchId, failed ) } );
				} );
		},
	};

	return action;
};
