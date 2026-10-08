/**
 * Undo for a saved batch: the snackbar's Undo calls the log's revert, which
 * puts back the old value of every field the batch changed (logged as a new
 * batch with source `revert`).
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { notify } from '../actions/notices';
import { revertWholeBatch } from '../history/revert';
import { invalidateLog } from '../history/use-log';
import { invalidateProducts } from '../store/products';

export async function undoBatch( batchId: string ): Promise< void > {
	try {
		const outcome = await revertWholeBatch( batchId );
		const ok = outcome.ok;
		const failed = [ ...outcome.failed ];

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
		notify.error( error instanceof Error ? error.message : __( 'The undo failed.', 'wp-woocommerce-products-list' ) );
	}
}
