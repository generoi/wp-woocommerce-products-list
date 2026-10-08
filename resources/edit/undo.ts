/**
 * Undo for a saved batch: the snackbar's Undo calls the log's revert, which
 * puts back the old value of every field the batch changed (logged as a new
 * batch with source `revert`). A 220-variation revert runs for seconds, so
 * the snackbar says "Reverting 100 of 220…" while it does and "220 items put
 * back." when it is done.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { notify } from '../actions/notices';
import { getRevertPlan } from '../api/client';
import { restoreFocus } from './focus';
import type { FocusOrigin } from './focus';
import { runRevert } from '../history/revert';
import { invalidateLog } from '../history/use-log';
import { invalidateProducts } from '../store/products';

/** The id of the "Reverting…" notice of a batch; one per batch, replaced as it progresses. */
export function undoNoticeId( batchId: string ): string {
	return `wc-pl-undo-${ batchId }`;
}

export function revertingMessage( done: number, total: number ): string {
	if ( total === 0 ) {
		return __( 'Reverting…', 'wp-woocommerce-products-list' );
	}

	return sprintf(
		/* translators: 1: items put back so far, 2: items in total */
		__( 'Reverting %1$d of %2$d items…', 'wp-woocommerce-products-list' ),
		done,
		total
	);
}

export interface UndoOptions {
	/** Where focus was when Undo was clicked; it goes back there (or to the table) when the revert is done. */
	focus?: FocusOrigin | null;
}

export async function undoBatch( batchId: string, options: UndoOptions = {} ): Promise< void > {
	const noticeId = undoNoticeId( batchId );
	// Up at once: the Undo snackbar vanished the moment it was clicked.
	notify.info( revertingMessage( 0, 0 ), { id: noticeId, explicitDismiss: true, isDismissible: false } );

	try {
		const plan = await getRevertPlan( batchId );
		const outcome = await runRevert( batchId, plan, {
			onProgress: ( done, total ) => notify.info( revertingMessage( done, total ), { id: noticeId, explicitDismiss: true, isDismissible: false } ),
		} );
		const ok = outcome.ok;
		const failed = [ ...outcome.failed ];

		notify.remove( noticeId );
		invalidateProducts( { counts: true } );
		invalidateLog();

		if ( outcome.conflicts.length ) {
			notify.error(
				sprintf(
					/* translators: %d: number of items left alone */
					_n( '%d item was changed again since and was left as it is; revert it from History.', '%d items were changed again since and were left as they are; revert them from History.', outcome.conflicts.length, 'wp-woocommerce-products-list' ),
					outcome.conflicts.length
				)
			);
		}

		if ( ok && ! failed.length ) {
			notify.success(
				sprintf(
					/* translators: %d: number of items put back */
					_n( '%d item put back.', '%d items put back.', ok, 'wp-woocommerce-products-list' ),
					ok
				)
			);
		}

		if ( failed.length ) {
			notify.error(
				sprintf(
					/* translators: 1: items put back, 2: items that failed, 3: the first failure's message */
					__( '%1$d put back, %2$d failed: %3$s', 'wp-woocommerce-products-list' ),
					ok,
					failed.length,
					failed[ 0 ]?.message ?? __( 'Some items could not be put back.', 'wp-woocommerce-products-list' )
				)
			);
		}
	} catch ( error ) {
		notify.remove( noticeId );
		notify.error( error instanceof Error ? error.message : __( 'The undo failed.', 'wp-woocommerce-products-list' ) );
	} finally {
		if ( options.focus !== undefined ) {
			setTimeout( () => restoreFocus( options.focus ?? null ), 0 );
		}
	}
}
