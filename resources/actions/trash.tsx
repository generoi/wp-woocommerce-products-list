/**
 * Move to Trash with Undo (restore), rows gone from the page before the
 * request returns. One draft row goes straight away; a published product
 * or several rows are confirmed first, with the names on screen.
 */
import { Button } from '@wordpress/components';
import { useEffect, useRef, useState } from '@wordpress/element';
import { doAction } from '@wordpress/hooks';
import { __, _n, sprintf } from '@wordpress/i18n';
import { trash } from '@wordpress/icons';
import { runAction } from '../api/client';
import type { RenderModalProps } from '../dataviews';
import { ACTIONS } from '../extensions/hooks';
import { captureFocusOrigin, restoreFocus, useReturnFocus } from '../edit/focus';
import { invalidateProducts, removeItems } from '../store/products';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory } from './context';
import { canDelete, errorMessage, idsOf, isRealRow, nameOf, realRows, summarize } from './context';
import { notify } from './notices';

/** Whether the set is small and harmless enough to trash without asking. */
export function needsConfirm( rows: ProductListItem[] ): boolean {
	return rows.length > 1 || rows.some( ( row ) => row.status === 'publish' );
}

const NAMES_SHOWN = 10;

/** The rows leave the page at once; the request runs behind an Undo. */
export function trashRows( rows: ProductListItem[] ): void {
	const ids = idsOf( rows );

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
									// The snackbar (and the Undo button with it) goes away: focus must not fall to <body>.
									const origin = captureFocusOrigin();

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
										.catch( ( error: unknown ) => notify.error( errorMessage( error ) ) )
										.finally( () => setTimeout( () => restoreFocus( origin ), 0 ) );
								},
							},
						],
					}
				);
			}

			if ( failed.length ) {
				notify.error( failed[ 0 ]?.message ?? __( 'The product could not be trashed.', 'wp-woocommerce-products-list' ) );
			}
		} )
		.catch( ( error: unknown ) => {
			invalidateProducts( { counts: true } );
			notify.error( errorMessage( error ) );
		} );
}

function TrashModal( { items, closeModal, onActionPerformed }: RenderModalProps< ProductListItem > ) {
	// The rows the modal opened with; the list trims the selection while it is open.
	const [ rows ] = useState( () => realRows( items ) );
	const ranRef = useRef( false );
	const confirm = needsConfirm( rows );

	useReturnFocus();

	const run = () => {
		if ( ranRef.current ) {
			return;
		}

		ranRef.current = true;
		trashRows( rows );
		onActionPerformed?.( rows );
		closeModal?.();
	};

	// Nothing to confirm: go, before the modal has painted.
	useEffect( () => {
		if ( ! confirm ) {
			run();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the rows it opened with
	}, [] );

	if ( ! confirm ) {
		return <></>;
	}

	const published = rows.filter( ( row ) => row.status === 'publish' ).length;
	const shown = rows.slice( 0, NAMES_SHOWN );

	return (
		<div className="wc-pl-confirm">
			<p>
				{ rows.length === 1
					? sprintf(
							/* translators: %s: product name */
							__( 'Move the published product “%s” to the Trash? It leaves the shop until it is restored.', 'wp-woocommerce-products-list' ),
							nameOf( rows[ 0 ]! )
					  )
					: sprintf(
							/* translators: 1: number of products, 2: how many of them are published */
							_n( 'Move %1$d product to the Trash? %2$d of them is published and leaves the shop until it is restored.', 'Move %1$d products to the Trash? %2$d of them are published and leave the shop until they are restored.', rows.length, 'wp-woocommerce-products-list' ),
							rows.length,
							published
					  ) }
			</p>
			{ rows.length > 1 ? (
				<ul className="wc-pl-confirm__list">
					{ shown.map( ( row ) => (
						<li key={ row.id }>{ nameOf( row ) }</li>
					) ) }
					{ rows.length > shown.length ? (
						<li>
							{ sprintf(
								/* translators: %d: number of further products */
								__( '…and %d more', 'wp-woocommerce-products-list' ),
								rows.length - shown.length
							) }
						</li>
					) : null }
				</ul>
			) : null }
			<p>{ __( 'You can undo this from the notice, or restore them from the Trash tab.', 'wp-woocommerce-products-list' ) }</p>
			<div className="wc-pl-edit__footer">
				<Button variant="tertiary" onClick={ () => closeModal?.() } __next40pxDefaultSize>
					{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
				</Button>
				<Button variant="primary" isDestructive disabled={ rows.length === 0 } onClick={ run } __next40pxDefaultSize>
					{ __( 'Move to Trash', 'wp-woocommerce-products-list' ) }
				</Button>
			</div>
		</div>
	);
}

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
		RenderModal: TrashModal,
		modalHeader: __( 'Move to Trash', 'wp-woocommerce-products-list' ),
		modalSize: 'medium',
	};

	return action;
};
