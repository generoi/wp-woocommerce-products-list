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
import { describeConflict, runRevert } from '../history/revert';
import { historyNoticeAction } from './failed-rows';
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
			// Which item and which field, with the value it kept: "Pelsi Black 37-38: Stock quantity 10 → 9 kept".
			const shown = outcome.conflicts.slice( 0, 3 ).map( ( conflict ) => describeConflict( conflict ) );
			const more = outcome.conflicts.length - shown.length;

			notify.error(
				sprintf(
					/* translators: 1: number of items left alone, 2: the items with the field and the value kept */
					_n( '%1$d item was changed again since and was left as it is (%2$s); revert it from History.', '%1$d items were changed again since and were left as they are (%2$s); revert them from History.', outcome.conflicts.length, 'wp-woocommerce-products-list' ),
					outcome.conflicts.length,
					more > 0
						? /* translators: 1: the first items, 2: number of further items */
						  sprintf( __( '%1$s and %2$d more', 'wp-woocommerce-products-list' ), shown.join( '; ' ), more )
						: shown.join( '; ' )
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
				),
				// The revert batch records what was not put back (runRevert posts the unanswered chunks as failed).
				historyNoticeAction( outcome.revertBatchId ) ? { actions: [ historyNoticeAction( outcome.revertBatchId )! ] } : undefined
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
