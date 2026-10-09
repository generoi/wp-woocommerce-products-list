/**
 * The rows a write left failed: recorded in the batch's audit trail and
 * offered for another try, for every kind of write the list runs (the
 * editor's saves, the menu and footer actions, Trash, declarative tools,
 * Undo and History reverts, `window.wcProductsList.batchUpdate`).
 *
 * The server logs a row for every item it answered for: its concurrency
 * refusals (`wc_products_list_conflict`, `_locked`, `_trashed`, `_deleted`,
 * `_editing`) as `skipped` rows, and a failed action result as an `error`
 * row. What it never saw (a request that failed as a whole: offline, a
 * timeout, a 5xx before the batch was written) and a wc/v3 item error of a
 * save have no row: those go to `POST /log/skipped` with reason `failed`
 * (docs/contracts.md §3.5), so History's batch says which rows of a
 * campaign did not change.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { addQueryArgs } from '@wordpress/url';
import { isRequestFailure, logSkipped } from '../api/client';
import type { ActionResult, SkippedItem, WriteSource } from '../api/client';
import { selectRows } from '../list/selection';
import { getSettings } from '../settings';
import { isGoneCode, isServerLoggedCode } from './errors';

export interface FailedRow {
	id: number;
	message: string;
	code?: string;
}

export interface FailureNoticeAction {
	label: string;
	onClick?: () => void;
	url?: string;
}

/**
 * The failed rows to post as `failed` (or `deleted`, for a row wc/v3 no
 * longer finds), one per id; rows the server logged itself are left out.
 */
export function failedSkips( failed: ReadonlyArray< FailedRow >, fields?: string[] ): SkippedItem[] {
	const seen = new Set< number >();
	const items: SkippedItem[] = [];

	for ( const failure of failed ) {
		if ( failure.id <= 0 || seen.has( failure.id ) || isServerLoggedCode( failure.code ) ) {
			continue;
		}

		seen.add( failure.id );
		items.push( {
			id: failure.id,
			reason: isGoneCode( failure.code ) ? 'deleted' : 'failed',
			...( fields?.length ? { fields } : {} ),
			...( failure.message ? { message: failure.message } : {} ),
		} );
	}

	return items;
}

export interface RecordFailedOptions {
	/** The write paths the rows would have changed. */
	fields?: string[];
	/** The row action they were attempted with (`trash`, `restore`, …): History labels the rows with it. */
	action?: string;
	post?: typeof logSkipped;
}

/** Post the failed rows of a batch to `/log/skipped` (fire and forget; `logSkipped` never throws). */
export function recordFailedRows( batchId: string, source: WriteSource | 'revert', failed: ReadonlyArray< FailedRow >, options: RecordFailedOptions = {} ): void {
	const items = failedSkips( failed, options.fields );
	const post = options.post ?? logSkipped;

	if ( batchId && items.length ) {
		void ( options.action ? post( batchId, source, items, { action: options.action } ) : post( batchId, source, items ) );
	}
}

/**
 * Of an action's results, the ones the server never answered for (their
 * request failed as a whole, `wcpl_request_failed`): the server logged an
 * `error` row for every other failed result itself.
 */
export function unansweredResults( results: ReadonlyArray< ActionResult > ): FailedRow[] {
	return results
		.filter( ( result ) => ! result.ok && isRequestFailure( result.data ) )
		.map( ( result ) => ( { id: result.id, message: result.message ?? '', ...( result.code ? { code: result.code } : {} ) } ) );
}

/** Every id of a call that failed as a whole (nothing answered), with its error. */
export function allFailed( ids: ReadonlyArray< number >, message: string, code?: string ): FailedRow[] {
	return ids.map( ( id ) => ( { id, message, ...( code ? { code } : {} ) } ) );
}

/** "View in History" for a batch, when the user may open History. */
export function historyNoticeAction( batchId: string ): FailureNoticeAction | null {
	let history: string | undefined;

	try {
		history = getSettings().links.history;
	} catch {
		// No settings (a test, an embed without them): no link, the notice still goes up.
		history = undefined;
	}

	return history && batchId ? { label: __( 'View in History', 'wp-woocommerce-products-list' ), url: addQueryArgs( history, { batch: batchId } ) } : null;
}

/**
 * The actions of a failure notice, as the editor's outcome notice has them:
 * "Select the N failed" (the rows that still exist, to try again) and
 * "View in History" (the batch, with the failed rows recorded).
 */
export function failureNoticeActions( batchId: string, failed: ReadonlyArray< FailedRow > ): FailureNoticeAction[] {
	const ids = Array.from( new Set( failed.filter( ( failure ) => failure.id > 0 && ! isGoneCode( failure.code ) ).map( ( failure ) => failure.id ) ) );
	const history = historyNoticeAction( batchId );

	return [
		...( ids.length
			? [
					{
						label: sprintf(
							/* translators: %d: number of items that failed */
							_n( 'Select the %d failed', 'Select the %d failed', ids.length, 'wp-woocommerce-products-list' ),
							ids.length
						),
						onClick: () => void selectRows( ids ),
					},
			  ]
			: [] ),
		...( history ? [ history ] : [] ),
	];
}
