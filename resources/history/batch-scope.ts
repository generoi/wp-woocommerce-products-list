/**
 * What a batch touched, for the "Revert batch" confirm: how many changes on
 * how many items, and which fields, so the user knows the revert is wider
 * than the row they were looking at.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import type { LogRow, RevertPlan } from '../api/client';

export interface BatchScope {
	/** Update rows in the batch (what the revert puts back). */
	changes: number;
	/** Distinct items among them (first page). */
	objects: number;
	fields: string[];
	/** True when the first page did not hold every row. */
	partial: boolean;
	/** Entries the revert leaves alone (trash, delete, duplicate rows). */
	skipped?: number;
}

/** The scope from `GET /log/batch/{id}`: exact counts for any size, no field names. */
export function scopeFromPlan( plan: Pick< RevertPlan, 'rows' | 'objects' | 'skipped' > ): BatchScope {
	return { changes: plan.rows - plan.skipped.length, objects: plan.objects, fields: [], partial: false, skipped: plan.skipped.length };
}

/**
 * @param rows  The batch's rows loaded so far (update action).
 * @param total The server's row count for that query; when every row is
 *              here only the successful updates count as changes (an
 *              error row put nothing in place, so there is nothing to put
 *              back), otherwise the count is the server's and marked partial.
 */
export function summarizeBatch( rows: LogRow[], total: number ): BatchScope {
	const updates = rows.filter( ( row ) => row.action === 'update' && row.status === 'ok' );
	const objects = new Set( updates.map( ( row ) => `${ row.object_type }:${ row.object_id }` ) );
	const fields = Array.from( new Set( updates.map( ( row ) => row.field ).filter( Boolean ) ) );
	const partial = rows.length < total;

	return { changes: partial ? total : updates.length, objects: objects.size, fields, partial };
}

/** How many pages of a batch the revert confirm loads before giving up on an exact count. */
export const BATCH_SCOPE_MAX_PAGES = 10;

export function describeBatchScope( scope: BatchScope ): string {
	const changes = sprintf(
		/* translators: %d: number of changes */
		_n( '%d change', '%d changes', scope.changes, 'wp-woocommerce-products-list' ),
		scope.changes
	);
	const objects = sprintf(
		/* translators: %d: number of items */
		_n( '%d item', '%d items', scope.objects, 'wp-woocommerce-products-list' ),
		scope.objects
	);

	const text = scope.fields.length
		? /* translators: 1: "N changes", 2: "N items", 3: the field names */
		  sprintf( __( 'This will put back %1$s on %2$s: %3$s.', 'wp-woocommerce-products-list' ), changes, scope.partial ? `${ objects }+` : objects, scope.fields.join( ', ' ) )
		: /* translators: 1: "N changes", 2: "N items" */
		  sprintf( __( 'This will put back %1$s on %2$s.', 'wp-woocommerce-products-list' ), changes, scope.partial ? `${ objects }+` : objects );

	if ( ! scope.skipped ) {
		return text;
	}

	return `${ text } ${ sprintf(
		/* translators: %d: number of log entries the revert leaves alone */
		_n( '%d entry (trash, delete or duplicate) is not reverted.', '%d entries (trash, delete or duplicate) are not reverted.', scope.skipped, 'wp-woocommerce-products-list' ),
		scope.skipped
	) }`;
}
