/**
 * A revert, chunked: `GET /log/batch/{id}` says which objects a revert
 * writes, in chunks of the server's size; each chunk is one POST under a
 * revert batch id shared by all of them (so History shows one batch and a
 * revert can itself be reverted). Objects whose fields were changed again
 * since the batch come back as `conflict` and are left alone; the caller
 * may post them again with `force`.
 *
 * While it runs the revert is a job of the list's save activity (the bar
 * says "Reverting…", its objects are locked, leaving the page asks first),
 * and it is refused while any of its objects is still being saved in this
 * tab. Every chunk carries the revert batch id as its batch header and the
 * planned header (the objects in all), and the batch is closed at the end,
 * so the server can tell a revert cut short from one that finished
 * (docs/contracts.md §3.6).
 */
import { decodeEntities } from '@wordpress/html-entities';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { ActionResult, RevertCheck, RevertPlan } from '../api/client';
import { checkRevert, closeBatch, getRevertPlan, logSkipped, newBatchId, revertBatch } from '../api/client';
import { recordFailedRows } from '../edit/failed-rows';
import { humanizeError } from '../edit/errors';
import { outcomeUnknown, UNCERTAIN_CODE, uncertainMessage } from '../edit/save-runner';
import { beginSaveJob, finishSaveJob, pendingAmong, updateSaveJob } from '../store/save-activity';

export interface RevertOutcome {
	revertBatchId: string;
	/** Objects put back. */
	ok: number;
	/** Objects left alone because a field changed again since the batch. */
	conflicts: ActionResult[];
	/** Objects that could not be written. */
	failed: ActionResult[];
	/** Entries the server reports as skipped (trash, delete, duplicate rows, items an earlier revert already put back). */
	skipped: number;
	/** The first skipped entry's message ("Price was already put back by an earlier revert of this batch…"). */
	skippedMessage?: string;
}

export interface RunRevertOptions {
	/** Only these objects (a retry of conflicts); the plan's chunks otherwise. */
	ids?: number[];
	force?: boolean;
	/** Take the batch's change off the current value for relative fields (stock) instead of overwriting. */
	relative?: boolean;
	/** The id to keep logging under (a forced retry joins the first pass). */
	revertBatchId?: string;
	onProgress?( done: number, total: number ): void;
	/** Close the revert batch when the run ends (tests pass their own); `closeBatch` of the REST client by default. */
	close?( revertBatchId: string ): Promise< void >;
	/** Record the objects of chunks that got no answer (tests pass their own); `logSkipped` of the REST client by default. */
	logFailed?: typeof logSkipped;
}

/** The revert's objects are still being written by a save in this tab: reverting them now would split the save. */
export class RevertBusyError extends Error {
	readonly ids: number[];

	constructor( ids: number[] ) {
		super(
			sprintf(
				/* translators: %d: number of items still being saved */
				_n(
					'%d item of this batch is still being saved in this tab. Wait until the update is done, then undo it.',
					'%d items of this batch are still being saved in this tab. Wait until the update is done, then undo it.',
					ids.length,
					'wp-woocommerce-products-list'
				),
				ids.length
			)
		);
		this.name = 'RevertBusyError';
		this.ids = ids;
	}
}

function chunk< T >( list: T[], size: number ): T[][] {
	const out: T[][] = [];
	const step = Math.max( 1, size );

	for ( let index = 0; index < list.length; index += step ) {
		out.push( list.slice( index, index + step ) );
	}

	return out;
}

export function splitResults( results: ActionResult[] ): Pick< RevertOutcome, 'ok' | 'conflicts' | 'failed' | 'skipped' | 'skippedMessage' > {
	const outcome: Pick< RevertOutcome, 'ok' | 'conflicts' | 'failed' | 'skipped' | 'skippedMessage' > = { ok: 0, conflicts: [], failed: [], skipped: 0 };

	for ( const result of results ) {
		if ( result.ok ) {
			outcome.ok += 1;
		} else if ( result.code === 'conflict' ) {
			outcome.conflicts.push( result );
		} else if ( result.code === 'skipped' ) {
			outcome.skipped += 1;
			outcome.skippedMessage ??= result.message ? decodeEntities( result.message ) : undefined;
		} else {
			outcome.failed.push( result );
		}
	}

	return outcome;
}

/**
 * The snackbar a finished revert leaves: how many items it put back, what failed, or (it wrote nothing, say because an
 * Undo put the items back while the confirm was open) that nothing was reverted and why. Null while conflicts are left
 * to decide on.
 */
export function revertNotice( result: Pick< RevertOutcome, 'ok' | 'conflicts' | 'failed' | 'skipped' | 'skippedMessage' > ): { status: 'success' | 'error' | 'info'; message: string } | null {
	if ( result.failed.length ) {
		return {
			status: 'error',
			message: sprintf(
				/* translators: 1: items reverted, 2: items that failed, 3: the first failure's message */
				__( '%1$d reverted, %2$d failed: %3$s', 'wp-woocommerce-products-list' ),
				result.ok,
				result.failed.length,
				result.failed[ 0 ]?.message ?? __( 'Some items could not be reverted.', 'wp-woocommerce-products-list' )
			),
		};
	}

	if ( result.ok ) {
		return {
			status: 'success',
			message: sprintf(
				/* translators: %d: number of items reverted */
				_n( '%d item reverted.', '%d items reverted.', result.ok, 'wp-woocommerce-products-list' ),
				result.ok
			),
		};
	}

	if ( result.conflicts.length ) {
		return null;
	}

	if ( result.skipped ) {
		const left = sprintf(
			/* translators: %d: number of items the revert left as they are */
			_n( 'Nothing was reverted: %d item was left as it is.', 'Nothing was reverted: %d items were left as they are.', result.skipped, 'wp-woocommerce-products-list' ),
			result.skipped
		);

		return { status: 'info', message: result.skippedMessage ? `${ left } ${ result.skippedMessage }` : left };
	}

	return { status: 'info', message: __( 'Nothing was reverted: no item had anything left to put back.', 'wp-woocommerce-products-list' ) };
}

export interface RevertCheckSummary {
	/** Objects changed again since the batch (a revert leaves them as they are). */
	changed: number;
	/** Of those, the ones an earlier revert of the batch already put back. */
	alreadyReverted: number;
	/** One changed object, for an example sentence. */
	example: ActionResult | null;
	/** The ids of the changed objects (the revert leaves them as they are). */
	changedIds: number[];
}

/**
 * The dry run before a revert: which objects changed again since the batch.
 * Without ids the server checks only its first chunk, so a batch of several
 * chunks is checked chunk by chunk (in parallel: nothing is written).
 */
export async function checkRevertPlan( batchId: string, plan: Pick< RevertPlan, 'chunks' >, check: typeof checkRevert = checkRevert, signal?: AbortSignal ): Promise< RevertCheckSummary > {
	const parts = plan.chunks.length > 1 ? plan.chunks.filter( ( ids ) => ids.length ) : [ undefined ];
	// At most REVERT_PARALLEL at a time, like the revert itself: a 24k-row batch is 243 chunks, and all
	// of them at once took every PHP worker for about a minute (the storefront waited behind them).
	const responses: RevertCheck[] = new Array( parts.length );
	let next = 0;
	const worker = async () => {
		while ( next < parts.length && ! signal?.aborted ) {
			const index = next++;

			responses[ index ] = await check( batchId, { ids: parts[ index ], signal } );
		}
	};

	await Promise.all( Array.from( { length: Math.min( REVERT_PARALLEL, parts.length ) }, worker ) );
	const summary: RevertCheckSummary = { changed: 0, alreadyReverted: 0, example: null, changedIds: [] };

	for ( const response of responses.filter( Boolean ) ) {
		summary.changed += response.changed ?? 0;
		summary.alreadyReverted += response.already_reverted ?? 0;
		// Only an item someone else changed is an example of "changed since": one an earlier revert put back is counted apart.
		summary.example ??= response.items.find( ( item ) => ! item.already_reverted?.length ) ?? null;
		summary.changedIds.push( ...response.items.map( ( item ) => item.id ) );
	}

	return summary;
}

/** Chunks posted at once: the server takes at most 100 objects per call, and parallel chunks of one batch do not interfere (conflicts and `reverts` are per object). */
export const REVERT_PARALLEL = 3;

/**
 * The results of a revert chunk whose request failed as a whole: one failed
 * result per object, so the chunks that did answer still count ("N put
 * back, M failed"). No answer, or a server error, may still have been
 * stored: those say so (UNCERTAIN_CODE), like a save's (save-runner.ts).
 */
export function failedChunkResults( ids: number[], error: unknown ): ActionResult[] {
	const rawCode = typeof ( error as { code?: unknown } | null )?.code === 'string' ? ( error as { code: string } ).code : undefined;
	const raw = error instanceof Error ? error.message : String( error ?? '' );
	const message = humanizeError( rawCode, raw );
	const unknown = outcomeUnknown( error );

	return ids.map( ( id ) => ( {
		id,
		ok: false,
		code: unknown ? UNCERTAIN_CODE : rawCode ?? 'request_failed',
		message: unknown ? uncertainMessage( message ) : message,
	} ) );
}

/** Refusals of a whole revert request before it wrote anything: one revert of a batch at a time, never while its save runs. */
const NOT_STARTED_CODES = new Set( [ 'wc_products_list_revert_running', 'wc_products_list_batch_running' ] );

/** Post the revert in chunks, REVERT_PARALLEL at a time; `plan.chunks` or the given ids cut to the plan's chunk size. Results keep the chunk order.
 * A chunk whose request fails comes back as failed results (failedChunkResults) and the other chunks still run;
 * it throws only when no chunk got an answer, so nothing was put back for sure. */
export async function runRevert( batchId: string, plan: Pick< RevertPlan, 'chunk' | 'chunks' >, options: RunRevertOptions = {}, post: typeof revertBatch = revertBatch ): Promise< RevertOutcome > {
	const revertBatchId = options.revertBatchId ?? newBatchId();
	const chunks = ( options.ids ? chunk( options.ids, plan.chunk || 100 ) : plan.chunks ).filter( ( ids ) => ids.length );
	const total = chunks.reduce( ( sum, ids ) => sum + ids.length, 0 );
	const objectIds = chunks.flat();
	const busy = pendingAmong( objectIds );

	// A save in this tab still writes some of these objects: refused, never interleaved with it (other tabs and users are
	// caught by the server's expected values and locks).
	if ( busy.length ) {
		throw new RevertBusyError( busy );
	}

	const perChunk: ActionResult[][] = chunks.map( () => [] );
	// Several requests: the server keeps the revert batch `running` until it is closed, `interrupted` when it never is.
	const planned = chunks.length > 1 ? total : 0;
	const close = options.close ?? closeBatch;
	const job = total ? beginSaveJob( objectIds.map( ( id ) => ( { id, parent_id: 0 } ) ), 'revert' ) : undefined;
	let done = 0;
	let next = 0;
	let answered = false;
	let firstError: unknown = null;
	/** The objects of chunks whose request failed as a whole: the server has no row for them. */
	const unanswered: ActionResult[] = [];

	options.onProgress?.( 0, total );

	if ( job !== undefined ) {
		updateSaveJob( job, 0, total );
	}

	const worker = async () => {
		while ( next < chunks.length ) {
			const index = next++;
			const ids = chunks[ index ] as number[];
			try {
				const response = await post( batchId, { ids, revertBatchId, force: options.force, relative: options.relative, fields: [ 'id' ], batchId: revertBatchId, ...( planned ? { planned } : {} ) } );

				perChunk[ index ] = response.results ?? [];
				answered = true;
			} catch ( error ) {
				firstError ??= error;
				perChunk[ index ] = failedChunkResults( ids, error );

				// A chunk refused before it started (another revert of this batch, or its save, still running) wrote and
				// tried nothing: no failed rows for it.
				if ( ! NOT_STARTED_CODES.has( String( ( error as { code?: unknown } | null )?.code ?? '' ) ) ) {
					unanswered.push( ...perChunk[ index ]! );
				}
			}

			done += ids.length;
			options.onProgress?.( done, total );

			if ( job !== undefined ) {
				updateSaveJob( job, done, total );
			}
		}
	};

	try {
		// Settled, not raced: the batch is closed and the rows unlocked only once no chunk is in flight any more.
		const settled = await Promise.allSettled( Array.from( { length: Math.min( REVERT_PARALLEL, chunks.length ) }, worker ) );
		const failure = settled.find( ( entry ): entry is PromiseRejectedResult => entry.status === 'rejected' );

		if ( failure ) {
			throw failure.reason;
		}

		// Every request failed: nothing was put back for sure, the caller reports the error as it is.
		if ( ! answered && firstError ) {
			throw firstError;
		}
	} finally {
		if ( planned ) {
			await close( revertBatchId );
		}

		// A chunk that got no answer left no row on the server: its objects go into the revert batch as failed, so
		// History shows the attempt and what it did not put back, a one-request revert included (it has no planned
		// header, so no "Interrupted" state either). Per-object failures of an answered chunk the server logged itself.
		if ( unanswered.length ) {
			recordFailedRows(
				revertBatchId,
				'revert',
				unanswered.map( ( result ) => ( { id: result.id, message: result.message ?? '' } ) ),
				{ post: options.logFailed ?? logSkipped }
			);
		}

		if ( job !== undefined ) {
			finishSaveJob( job );
		}
	}

	return { revertBatchId, ...splitResults( perChunk.flat() ) };
}

/** The plan, then every chunk of it. */
export async function revertWholeBatch( batchId: string, options: Omit< RunRevertOptions, 'ids' > = {} ): Promise< RevertOutcome & { plan: RevertPlan } > {
	const plan = await getRevertPlan( batchId );
	const outcome = await runRevert( batchId, plan, options );

	return { ...outcome, plan };
}

/** A stored scalar in the shop's format ("21,00 €" for a price), as the rest of History shows it. */
export type ConflictValueFormat = ( key: string, value: string ) => string;

function shown( value: unknown, key = '', format?: ConflictValueFormat ): string {
	if ( value === null || value === undefined || value === '' ) {
		return '—';
	}

	if ( typeof value === 'object' ) {
		return JSON.stringify( value );
	}

	return format ? format( key, String( value ) ) : String( value );
}

/**
 * One conflict as a sentence: "Pelsi Black 37-38: Stock quantity 10 → 9
 * kept" (the value the batch left → the value now, which the revert kept).
 * `label` maps a field key to its label: a screen that names its fields
 * (History's Field column) passes its own, so a conflict line names the
 * field as the rest of the screen does; the server's label is used for a
 * key it does not know (it answers the key itself), and when none is passed.
 */
export function describeConflict( result: ActionResult, label: ( key: string ) => string = ( key ) => key, format?: ConflictValueFormat ): string {
	// A title saved by a shop manager is stored with "&" as "&amp;": named as the product screen names it.
	const name = result.name ? decodeEntities( result.name ) : `#${ result.id }`;
	const keys = result.fields ?? [];
	const parts = keys.map( ( key, index ) => {
		const mapped = label( key );
		const fieldLabel = mapped && mapped !== key ? mapped : result.labels?.[ index ] || mapped;

		if ( result.batch && result.current && key in result.batch && key in result.current ) {
			return sprintf(
				/* translators: 1: field label, 2: value the batch left, 3: value now (kept) */
				__( '%1$s %2$s → %3$s kept', 'wp-woocommerce-products-list' ),
				fieldLabel,
				shown( result.batch[ key ], key, format ),
				shown( result.current[ key ], key, format )
			);
		}

		return fieldLabel;
	} );

	return parts.length ? `${ name }: ${ parts.join( '; ' ) }` : name;
}

/** The conflicts a relative revert can resolve (a stock count changed since: take the batch's change off it). */
export function relativeConflicts( conflicts: ActionResult[] ): ActionResult[] {
	return conflicts.filter( ( result ) => result.relative === true );
}
