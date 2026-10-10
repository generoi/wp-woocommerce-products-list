/**
 * What a batch touched, for the "Revert batch" confirm: how many changes on
 * how many items, and which fields, so the user knows the revert is wider
 * than the row they were looking at.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import type { LogRow, RevertPlan } from '../api/client';

/** Short "why" of a skip reason (LogController::SKIP_REASONS), for counts such as "5 skipped (already had the value)". */
export function skipReasonLabel( reason: string ): string {
	switch ( reason ) {
		case 'unchanged':
			return __( 'already had the value', 'wp-woocommerce-products-list' );
		case 'trashed':
			return __( 'trashed meanwhile', 'wp-woocommerce-products-list' );
		case 'deleted':
			return __( 'deleted meanwhile', 'wp-woocommerce-products-list' );
		case 'conflict':
			return __( 'changed by someone else', 'wp-woocommerce-products-list' );
		case 'locked':
			return __( 'another save was running', 'wp-woocommerce-products-list' );
		case 'editing':
			return __( 'open in the product editor', 'wp-woocommerce-products-list' );
		case 'no_stock_management':
			return __( 'stock not managed', 'wp-woocommerce-products-list' );
		case 'has_sale':
			return __( 'already had a sale', 'wp-woocommerce-products-list' );
		case 'no_sale_price':
			return __( 'no sale price', 'wp-woocommerce-products-list' );
		case 'below_zero':
			return __( 'would go below zero', 'wp-woocommerce-products-list' );
		case 'not_applicable':
			return __( 'field does not apply', 'wp-woocommerce-products-list' );
		case 'failed':
			return __( 'failed to save', 'wp-woocommerce-products-list' );
		default:
			return __( 'other reasons', 'wp-woocommerce-products-list' );
	}
}

/** Actions whose rows a revert never writes back; mirrors Revert::NOT_REVERTABLE in src/Log/Revert.php. */
export const NOT_REVERTABLE_ACTIONS: ReadonlySet< string > = new Set( [ 'trash', 'restore', 'delete', 'duplicate', 'create', 'translate_term' ] );

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
	/** Items the batch left unwritten (status `skipped` rows): nothing to put back. */
	leftOut?: number;
	/** `leftOut` by reason (`{ unchanged: 5 }`). */
	leftOutReasons?: Record< string, number >;
	/** The labels of the not-revertable actions among `skipped` ("Move to Trash", "Duplicate"). */
	skippedActions?: string[];
}

/** The scope from `GET /log/batch/{id}`: exact counts for any size, no field names. */
export function scopeFromPlan(
	plan: Pick< RevertPlan, 'rows' | 'objects' | 'skipped' > & Partial< Pick< RevertPlan, 'failed' | 'left_out' | 'left_out_reasons' > >,
	labelOf: ( action: string ) => string = ( action ) => action
): BatchScope {
	const failedEntries = plan.skipped.filter( ( entry ) => entry.action === 'failed' ).length;
	const failed = Math.max( failedEntries, plan.failed ?? 0 );
	const skipped = plan.skipped.length - failedEntries;
	const skippedActions = Array.from( new Set( plan.skipped.filter( ( entry ) => entry.action !== 'failed' ).map( ( entry ) => labelOf( entry.action ) ) ) );
	const reasons = plan.left_out_reasons && typeof plan.left_out_reasons === 'object' && ! Array.isArray( plan.left_out_reasons ) ? plan.left_out_reasons : null;

	return {
		changes: Math.max( 0, plan.rows - skipped - failed ),
		objects: plan.objects,
		fields: [],
		partial: false,
		skipped,
		failed,
		...( skippedActions.length ? { skippedActions } : {} ),
		...( plan.left_out ? { leftOut: plan.left_out } : {} ),
		...( reasons && Object.keys( reasons ).length ? { leftOutReasons: reasons } : {} ),
	};
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

/** Items a revert would put back once those changed since the batch (`kept`: a revert leaves them as they are) are taken out. */
export function itemsLeftToRevert( scope: Pick< BatchScope, 'objects' >, kept = 0 ): number {
	return Math.max( 0, scope.objects - Math.max( 0, kept ) );
}

/**
 * @param kept Items the pre-revert check found changed since the batch (or already put back by an earlier
 *             revert): the revert leaves them as they are, so they are not counted as put back.
 */
export function describeBatchScope( scope: BatchScope, kept = 0 ): string {
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

	const left = itemsLeftToRevert( scope, kept );
	let head: string = text;

	if ( kept > 0 && left === 0 ) {
		head = __( 'Nothing is left to put back: every item of this batch changed since (see below).', 'wp-woocommerce-products-list' );
	} else if ( kept > 0 ) {
		const ofItems = sprintf(
			/* translators: 1: items the revert puts back, 2: items in the batch */
			_n( '%1$d of %2$d item', '%1$d of %2$d items', scope.objects, 'wp-woocommerce-products-list' ),
			left,
			scope.objects
		);

		head = scope.fields.length
			? /* translators: 1: "N of M items", 2: the field names */
			  sprintf( __( 'This will put back the changes on %1$s: %2$s.', 'wp-woocommerce-products-list' ), ofItems, scope.fields.join( ', ' ) )
			: /* translators: %s: "N of M items" */
			  sprintf( __( 'This will put back the changes on %s.', 'wp-woocommerce-products-list' ), ofItems );
	}

	const parts: string[] = [ head ];

	if ( scope.skipped ) {
		parts.push(
			scope.skippedActions?.length
				? sprintf(
						/* translators: 1: number of log entries the revert leaves alone, 2: their actions ("Move to Trash, Duplicate") */
						_n( '%1$d entry (%2$s) is not reverted.', '%1$d entries (%2$s) are not reverted.', scope.skipped, 'wp-woocommerce-products-list' ),
						scope.skipped,
						scope.skippedActions.join( ', ' )
				  )
				: sprintf(
						/* translators: %d: number of log entries the revert leaves alone */
						_n( '%d entry cannot be reverted.', '%d entries cannot be reverted.', scope.skipped, 'wp-woocommerce-products-list' ),
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

	if ( scope.leftOut ) {
		const reasons = scope.leftOutReasons ?? {};
		const unchanged = Math.min( scope.leftOut, reasons.unchanged ?? 0 );
		const other = scope.leftOut - unchanged;

		if ( unchanged ) {
			parts.push(
				sprintf(
					/* translators: %d: number of items the batch left out because they already had the value */
					_n( '%d item was left out because it already had this value; nothing to put back.', '%d items were left out because they already had this value; nothing to put back.', unchanged, 'wp-woocommerce-products-list' ),
					unchanged
				)
			);
		}

		if ( other ) {
			const why = Object.keys( reasons )
				.filter( ( reason ) => reason !== 'unchanged' )
				.map( skipReasonLabel );

			parts.push(
				why.length
					? sprintf(
							/* translators: 1: number of items the batch left out when it ran, 2: why ("trashed meanwhile, stock not managed") */
							_n( '%1$d item was left out when the batch ran (%2$s); nothing to put back.', '%1$d items were left out when the batch ran (%2$s); nothing to put back.', other, 'wp-woocommerce-products-list' ),
							other,
							why.join( ', ' )
					  )
					: sprintf(
							/* translators: %d: number of items the batch left out when it ran */
							_n( '%d item was left out when the batch ran (see Show changes); nothing to put back.', '%d items were left out when the batch ran (see Show changes); nothing to put back.', other, 'wp-woocommerce-products-list' ),
							other
					  )
			);
		}
	}

	return parts.join( ' ' );
}
