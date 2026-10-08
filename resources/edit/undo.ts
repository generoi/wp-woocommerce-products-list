/**
 * Undo for a saved batch: the snackbar's Undo calls the log's revert, which
 * puts back the old value of every field the batch changed (logged as a new
 * batch with source `revert`).
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { revertBatch } from '../api/client';
import { notify } from '../actions/notices';
import { invalidateLog } from '../history/use-log';
import { invalidateProducts } from '../store/products';

export async function undoBatch( batchId: string ): Promise< void > {
	try {
		const response = await revertBatch( batchId, { fields: [ 'id' ] } );
		const ok = response.results.filter( ( result ) => result.ok ).length;
		const failed = response.results.filter( ( result ) => ! result.ok );

		invalidateProducts( { counts: true } );
		invalidateLog();

		if ( ok ) {
			notify.success(
				sprintf(
					/* translators: %d: number of items put back */
					_n( '%d item put back.', '%d items put back.', ok, 'wp-woocommerce-products-list' ),
					ok
				)
			);
		}

		if ( failed.length ) {
			notify.error( failed[ 0 ]?.message ?? __( 'Some items could not be put back.', 'wp-woocommerce-products-list' ) );
		}
	} catch ( error ) {
		notify.error( error instanceof Error ? error.message : __( 'The undo failed.', 'wp-woocommerce-products-list' ) );
	}
}
