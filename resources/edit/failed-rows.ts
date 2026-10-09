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
import { notify } from '../actions/notices';
import { selectRows } from '../list/selection';
import { getSettings } from '../settings';
import { isGoneCode, isServerLoggedCode } from './errors';

export interface FailedRow {
	id: number;
	message: string;
	code?: string;
	/** The row's name, for the notice ("Pelsi Black: …"); else the caller's `names`, else `#id`. */
	name?: string;
}

export interface FailureNoticeAction {
	label: string;
	onClick?: () => void;
	url?: string;
	/** The click leaves the notice up (ui/notices.tsx withExtraActions). */
	keepsNotice?: boolean;
}

/** How many names (and how many distinct reasons) a failure notice shows before "and N more". */
export const FAILED_NAMES_SHOWN = 3;

/** Id => name of the rows an action was given, for its failure notice. */
export function namesById( rows: ReadonlyArray< { id: number; name?: unknown } > ): Map< number, string > {
	return new Map( rows.filter( ( row ) => typeof row.name === 'string' && row.name !== '' ).map( ( row ) => [ row.id, row.name as string ] ) );
}

function andMore( shown: string, more: number ): string {
	return more > 0
		? /* translators: 1: the first items, 2: number of further items */
		  sprintf( __( '%1$s and %2$d more', 'wp-woocommerce-products-list' ), shown, more )
		: shown;
}

/**
 * The failed rows by name, grouped by reason, as Undo's conflict notice
 * names them: "Pelsi Black, Wally Blue: Anna is editing this product in the
 * product editor. …; Sock 3: The product was deleted." At most
 * FAILED_NAMES_SHOWN names per reason and reasons in all, then "and N more".
 */
export function describeFailedRows( failed: ReadonlyArray< FailedRow >, names?: ReadonlyMap< number, string > ): string {
	const seen = new Set< number >();
	const groups = new Map< string, string[] >();

	for ( const failure of failed ) {
		if ( seen.has( failure.id ) ) {
			continue;
		}

		seen.add( failure.id );
		const name = failure.name || names?.get( failure.id ) || `#${ failure.id }`;
		const group = groups.get( failure.message ) ?? [];

		group.push( name );
		groups.set( failure.message, group );
	}

	const parts: string[] = [];
	let hidden = 0;

	Array.from( groups ).forEach( ( [ message, rowNames ], index ) => {
		if ( index >= FAILED_NAMES_SHOWN ) {
			hidden += rowNames.length;

			return;
		}

		const who = andMore( rowNames.slice( 0, FAILED_NAMES_SHOWN ).join( ', ' ), rowNames.length - FAILED_NAMES_SHOWN );

		parts.push(
			message
				? /* translators: 1: product names, 2: why they failed */
				  sprintf( __( '%1$s: %2$s', 'wp-woocommerce-products-list' ), who, message )
				: who
		);
	} );

	return andMore( parts.join( '; ' ), hidden );
}

/** What the action was: the notice says what did not happen ("was not moved to the Trash"). */
export type FailedAction = 'update' | 'trash' | 'restore' | 'duplicate';

/**
 * A failure notice that names the rows and says what did not happen to
 * them: "1 product was not moved to the Trash: Pelsi Black: Anna is
 * editing this product in the product editor. …".
 */
export function failureMessage( action: FailedAction, failed: ReadonlyArray< FailedRow >, names?: ReadonlyMap< number, string > ): string {
	const count = new Set( failed.map( ( failure ) => failure.id ) ).size;
	const rows = describeFailedRows( failed, names );

	switch ( action ) {
		case 'trash':
			/* translators: 1: number of products, 2: the products and why */
			return sprintf( _n( '%1$d product was not moved to the Trash: %2$s', '%1$d products were not moved to the Trash: %2$s', count, 'wp-woocommerce-products-list' ), count, rows );
		case 'restore':
			/* translators: 1: number of products, 2: the products and why */
			return sprintf( _n( '%1$d product is still in the Trash: %2$s', '%1$d products are still in the Trash: %2$s', count, 'wp-woocommerce-products-list' ), count, rows );
		case 'duplicate':
			/* translators: 1: number of products, 2: the products and why */
			return sprintf( _n( '%1$d product could not be duplicated: %2$s', '%1$d products could not be duplicated: %2$s', count, 'wp-woocommerce-products-list' ), count, rows );
		default:
			/* translators: 1: number of items, 2: the items and why */
			return sprintf( _n( '%1$d item could not be updated: %2$s', '%1$d items could not be updated: %2$s', count, 'wp-woocommerce-products-list' ), count, rows );
	}
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

/** "Open the Trash": the Trash tab of the list, where products a restore left in the Trash are. */
export function trashTabNoticeAction(): FailureNoticeAction | null {
	let page: string | undefined;

	try {
		page = getSettings().links.page;
	} catch {
		page = undefined;
	}

	return page ? { label: __( 'Open the Trash', 'wp-woocommerce-products-list' ), url: addQueryArgs( page, { tab: 'trash' } ) } : null;
}

export interface FailureNoticeOptions {
	/**
	 * The failed rows are in the Trash, not in the list being viewed (a
	 * refused Undo of Move to Trash): "Open the Trash" in place of "Select
	 * the N failed".
	 */
	inTrash?: boolean;
}

/**
 * The actions of a failure notice, as the editor's outcome notice has them:
 * "Select the N failed" (the rows that still exist, to try again) and
 * "View in History" (the batch, with the failed rows recorded).
 *
 * "Select" keeps the notice up (its message names the rows and why), and
 * selects only the rows the list shows: when it shows none of them
 * (another tab, a search) the selection is left as it is and a notice says
 * so, rather than clearing the selection.
 */
export function failureNoticeActions( batchId: string, failed: ReadonlyArray< FailedRow >, options: FailureNoticeOptions = {} ): FailureNoticeAction[] {
	const ids = Array.from( new Set( failed.filter( ( failure ) => failure.id > 0 && ! isGoneCode( failure.code ) ).map( ( failure ) => failure.id ) ) );
	const history = historyNoticeAction( batchId );
	const trashTab = options.inTrash && ids.length ? trashTabNoticeAction() : null;

	return [
		...( trashTab ? [ trashTab ] : [] ),
		...( ids.length && ! options.inTrash
			? [
					{
						label: sprintf(
							/* translators: %d: number of items that failed */
							_n( 'Select the %d failed', 'Select the %d failed', ids.length, 'wp-woocommerce-products-list' ),
							ids.length
						),
						keepsNotice: true,
						onClick: () => {
							if ( ! selectRows( ids ) ) {
								notify.info( _n( 'This item is not in the list you are viewing; View in History lists it.', 'These items are not in the list you are viewing; View in History lists them.', ids.length, 'wp-woocommerce-products-list' ) );
							}
						},
					},
			  ]
			: [] ),
		...( history ? [ history ] : [] ),
	];
}
