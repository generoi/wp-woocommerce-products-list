/**
 * Delete permanently, after a confirmation. Irreversible: no Undo.
 * Products only from the Trash (as in the classic list); variations have no
 * Trash in WooCommerce, so "Delete variations" works on any variation row
 * (a retired colour's sizes).
 */
import { Button } from '@wordpress/components';
import { useState } from '@wordpress/element';
import { doAction } from '@wordpress/hooks';
import { __, _n, sprintf } from '@wordpress/i18n';
import { newBatchId, runAction } from '../api/client';
import { allFailed, recordFailedRows, unansweredResults } from '../edit/failed-rows';
import type { RenderModalProps } from '../dataviews';
import { ACTIONS } from '../extensions/hooks';
import { useReturnFocus } from '../edit/focus';
import { invalidateProducts, removeItems } from '../store/products';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory } from './context';
import { canDelete, errorMessage, idsOf, isRealRow, isVariationRow, nameOf, realRows, summarize } from './context';
import { notify } from './notices';

function DeleteModal( { items, closeModal, onActionPerformed }: RenderModalProps< ProductListItem > ) {
	const rows = realRows( items );
	const variations = rows.length > 0 && rows.every( isVariationRow );
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );

	useReturnFocus();

	const confirm = async () => {
		const ids = idsOf( rows );
		const batchId = newBatchId();

		setBusy( true );
		setError( null );

		try {
			const response = await runAction( 'delete', ids, {}, { fields: [ 'id' ], batchId } );
			const { ok, failed } = summarize( response );

			if ( ok.length ) {
				removeItems( ok );
				invalidateProducts( { counts: true } );
				doAction( ACTIONS.deleted, ok, { action: 'delete', batchId: response.batch_id } );
				notify.success(
					variations
						? sprintf(
								/* translators: %d: number of variations */
								_n( '%d variation permanently deleted.', '%d variations permanently deleted.', ok.length, 'wp-woocommerce-products-list' ),
								ok.length
						  )
						: sprintf(
								/* translators: %d: number of products */
								_n( '%d product permanently deleted.', '%d products permanently deleted.', ok.length, 'wp-woocommerce-products-list' ),
								ok.length
						  )
				);
			}

			if ( failed.length ) {
				// The ids whose request failed have no row on the server: recorded as failed (the others it logged).
				recordFailedRows( batchId, 'action', unansweredResults( response.results ), { action: 'delete' } );
				setBusy( false );
				setError( failed.map( ( failure ) => `${ failure.id }: ${ failure.message }` ).join( ' ' ) );

				return;
			}

			onActionPerformed?.( rows );
			closeModal?.();
		} catch ( caught ) {
			recordFailedRows( batchId, 'action', allFailed( ids, errorMessage( caught ) ), { action: 'delete' } );
			setBusy( false );
			setError( errorMessage( caught ) );
		}
	};

	return (
		<div className="wc-pl-confirm">
			<p>
				{ variations ? (
					rows.length === 1 ? (
						sprintf(
							/* translators: %s: variation name */
							__( 'Delete the variation “%s” permanently? Variations have no Trash; this cannot be undone.', 'wp-woocommerce-products-list' ),
							nameOf( rows[ 0 ]! )
						)
					) : (
						sprintf(
							/* translators: %d: number of variations */
							_n( 'Delete %d variation permanently? Variations have no Trash; this cannot be undone.', 'Delete %d variations permanently? Variations have no Trash; this cannot be undone.', rows.length, 'wp-woocommerce-products-list' ),
							rows.length
						)
					)
				) : rows.length === 1
					? sprintf(
							/* translators: %s: product name */
							__( 'Delete “%s” permanently? This cannot be undone.', 'wp-woocommerce-products-list' ),
							nameOf( rows[ 0 ]! )
					  )
					: sprintf(
							/* translators: %d: number of products */
							_n( 'Delete %d product permanently, with its variations? This cannot be undone.', 'Delete %d products permanently, with their variations? This cannot be undone.', rows.length, 'wp-woocommerce-products-list' ),
							rows.length
					  ) }
			</p>
			{ error ? (
				<p className="wc-pl-confirm__error" role="alert">
					{ error }
				</p>
			) : null }
			<div className="wc-pl-edit__footer">
				<Button variant="tertiary" onClick={ () => closeModal?.() } disabled={ busy } __next40pxDefaultSize>
					{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
				</Button>
				<Button variant="primary" isDestructive isBusy={ busy } disabled={ busy || rows.length === 0 } onClick={ () => void confirm() } __next40pxDefaultSize>
					{ __( 'Delete permanently', 'wp-woocommerce-products-list' ) }
				</Button>
			</div>
		</div>
	);
}

export const createDeleteAction: ActionFactory = ( { settings } ) => {
	if ( ! settings.caps.delete ) {
		return null;
	}

	const action: ProductAction = {
		id: 'delete',
		label: __( 'Delete permanently', 'wp-woocommerce-products-list' ),
		supportsBulk: true,
		scope: 'product',
		// As in the classic list: only what is already in the Trash, unless the site opts in (`wc_products_list/allow_hard_delete`).
		isEligible: ( item ) => isRealRow( item ) && canDelete( item ) && ( item.status === 'trash' || settings.features.hardDelete === true ),
		RenderModal: DeleteModal,
		modalHeader: __( 'Delete permanently', 'wp-woocommerce-products-list' ),
		modalSize: 'small',
	};

	return action;
};

/** "Delete variations": variation rows, whatever their status (WooCommerce has no Trash for variations). */
export const createDeleteVariationsAction: ActionFactory = ( { settings } ) => {
	if ( ! settings.caps.delete ) {
		return null;
	}

	const action: ProductAction = {
		id: 'delete-variations',
		label: __( 'Delete variations permanently', 'wp-woocommerce-products-list' ),
		supportsBulk: true,
		scope: 'variation',
		isEligible: ( item ) => isRealRow( item ) && isVariationRow( item ) && canDelete( item ),
		RenderModal: DeleteModal,
		modalHeader: __( 'Delete variations permanently', 'wp-woocommerce-products-list' ),
		modalSize: 'small',
	};

	return action;
};
