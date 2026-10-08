/**
 * What a batch touched, for the "Revert batch" confirm: how many changes on
 * how many items, and which fields, so the user knows the revert is wider
 * than the row they were looking at.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import type { LogRow, RevertPlan } from '../api/client';

/** Actions whose rows a revert never writes back; mirrors Revert::NOT_REVERTABLE in src/Log/Revert.php. */
export const NOT_REVERTABLE_ACTIONS: ReadonlySet< string > = new Set( [ 'trash', 'restore', 'delete', 'duplicate', 'create' ] );

/**
 * A row a revert puts back: an ok row with a field, of an update or of an
 * extension action that logged its changes (a translation copy), but never
 * of trash/restore/delete/duplicate/create.
 */
export function isRevertableRow( row: Pick< LogRow, 'action' | 'status' | 'field' > ): boolean {
	return row.status === 'ok' && row.field !== '' && ! NOT_REVERTABLE_ACTIONS.has( row.action );
}

export interface BatchScope {
	/** Revertable rows in the batch (what the revert puts back). */
	changes: number;
	/** Distinct items among them (first page). */
	objects: number;
	fields: string[];
	/** True when the first page did not hold every row. */
	partial: boolean;
	/** Entries the revert leaves alone (trash, restore, delete, duplicate rows, and rows without a field). */
	skipped?: number;
	/** Changes that failed when they were made: nothing to put back. */
	failed?: number;
}

/** The scope from `GET /log/batch/{id}`: exact counts for any size, no field names. */
export function scopeFromPlan( plan: Pick< RevertPlan, 'rows' | 'objects' | 'skipped' > & Partial< Pick< RevertPlan, 'failed' > > ): BatchScope {
	const failedEntries = plan.skipped.filter( ( entry ) => entry.action === 'failed' ).length;
	const failed = Math.max( failedEntries, plan.failed ?? 0 );
	const skipped = plan.skipped.length - failedEntries;

	return { changes: Math.max( 0, plan.rows - skipped - failed ), objects: plan.objects, fields: [], partial: false, skipped, failed };
}

/**
 * @param rows  The batch's rows loaded so far.
 * @param total The server's row count for that query; when every row is
 *              here only the revertable rows count as changes (an error
 *              row put nothing in place, so there is nothing to put back),
 *              otherwise the count is the server's and marked partial.
 */
export function summarizeBatch( rows: LogRow[], total: number ): BatchScope {
	const updates = rows.filter( isRevertableRow );
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

	const parts: string[] = [ text ];

	if ( scope.skipped ) {
		parts.push(
			sprintf(
				/* translators: %d: number of log entries the revert leaves alone */
				_n( '%d entry (trash, restore, delete or duplicate) is not reverted.', '%d entries (trash, restore, delete or duplicate) are not reverted.', scope.skipped, 'wp-woocommerce-products-list' ),
				scope.skipped
			)
		);
	}

	if ( scope.failed ) {
		parts.push(
			sprintf(
				/* translators: %d: number of changes that failed when they were made */
				_n( '%d failed change, nothing to revert.', '%d failed changes, nothing to revert.', scope.failed, 'wp-woocommerce-products-list' ),
				scope.failed
			)
		);
	}

	return parts.join( ' ' );
}
