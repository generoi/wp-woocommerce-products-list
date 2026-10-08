/** Delete permanently, after a confirmation. Irreversible: no Undo. */
import { Button } from '@wordpress/components';
import { useState } from '@wordpress/element';
import { doAction } from '@wordpress/hooks';
import { __, _n, sprintf } from '@wordpress/i18n';
import { runAction } from '../api/client';
import type { RenderModalProps } from '../dataviews';
import { ACTIONS } from '../extensions/hooks';
import { invalidateProducts, removeItems } from '../store/products';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory } from './context';
import { canDelete, errorMessage, idsOf, isRealRow, nameOf, realRows, summarize } from './context';
import { notify } from './notices';

function DeleteModal( { items, closeModal, onActionPerformed }: RenderModalProps< ProductListItem > ) {
	const rows = realRows( items );
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );

	const confirm = async () => {
		const ids = idsOf( rows );

		setBusy( true );
		setError( null );

		try {
			const response = await runAction( 'delete', ids, {}, { fields: [ 'id' ] } );
			const { ok, failed } = summarize( response );

			if ( ok.length ) {
				removeItems( ok );
				invalidateProducts( { counts: true } );
				doAction( ACTIONS.deleted, ok, { action: 'delete', batchId: response.batch_id } );
				notify.success(
					sprintf(
						/* translators: %d: number of products */
						_n( '%d product permanently deleted.', '%d products permanently deleted.', ok.length, 'wp-woocommerce-products-list' ),
						ok.length
					)
				);
			}

			if ( failed.length ) {
				setBusy( false );
				setError( failed.map( ( failure ) => `${ failure.id }: ${ failure.message }` ).join( ' ' ) );

				return;
			}

			onActionPerformed?.( rows );
			closeModal?.();
		} catch ( caught ) {
			setBusy( false );
			setError( errorMessage( caught ) );
		}
	};

	return (
		<div className="wc-pl-confirm">
			<p>
				{ rows.length === 1
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
