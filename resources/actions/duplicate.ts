/** Copy products through the server action (WC_Admin_Duplicate_Product); the copies are drafts. */
import { __, _n, sprintf } from '@wordpress/i18n';
import { copy } from '@wordpress/icons';
import { runAction } from '../api/client';
import { invalidateProducts } from '../store/products';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { canEdit, dropFromSelection, errorMessage, idsOf, isRealRow, rowFields, summarize } from './context';
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

			void runAction( 'duplicate', ids, {}, { fields: rowFields( fields ) } )
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
						notify.error( failed[ 0 ]?.message ?? __( 'The product could not be duplicated.', 'wp-woocommerce-products-list' ) );
					}

					dropFromSelection( context, ok );
					onActionPerformed?.( items );
				} )
				.catch( ( error: unknown ) => notify.error( errorMessage( error ) ) );
		},
	};

	return action;
};
