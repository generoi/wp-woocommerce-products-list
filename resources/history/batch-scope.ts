/**
 * What a batch touched, for the "Revert batch" confirm: how many changes on
 * how many items, and which fields, so the user knows the revert is wider
 * than the row they were looking at.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import type { LogRow } from '../api/client';

export interface BatchScope {
	/** Update rows in the batch (what the revert puts back). */
	changes: number;
	/** Distinct items among them (first page). */
	objects: number;
	fields: string[];
	/** True when the first page did not hold every row. */
	partial: boolean;
}

export function summarizeBatch( rows: LogRow[], total: number ): BatchScope {
	const updates = rows.filter( ( row ) => row.action === 'update' && row.status === 'ok' );
	const objects = new Set( updates.map( ( row ) => `${ row.object_type }:${ row.object_id }` ) );
	const fields = Array.from( new Set( updates.map( ( row ) => row.field ).filter( Boolean ) ) );

	return { changes: total, objects: objects.size, fields, partial: rows.length < total };
}

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

	/* translators: 1: "N changes", 2: "N items", 3: the field names */
	return sprintf( __( 'This will put back %1$s on %2$s: %3$s.', 'wp-woocommerce-products-list' ), changes, scope.partial ? `${ objects }+` : objects, scope.fields.join( ', ' ) );
}
