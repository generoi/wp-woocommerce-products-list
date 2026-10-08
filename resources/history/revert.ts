/**
 * A revert, chunked: `GET /log/batch/{id}` says which objects a revert
 * writes, in chunks of the server's size; each chunk is one POST under a
 * revert batch id shared by all of them (so History shows one batch and a
 * revert can itself be reverted). Objects whose fields were changed again
 * since the batch come back as `conflict` and are left alone; the caller
 * may post them again with `force`.
 */
import type { ActionResult, RevertPlan } from '../api/client';
import { getRevertPlan, newBatchId, revertBatch } from '../api/client';

export interface RevertOutcome {
	revertBatchId: string;
	/** Objects put back. */
	ok: number;
	/** Objects left alone because a field changed again since the batch. */
	conflicts: ActionResult[];
	/** Objects that could not be written. */
	failed: ActionResult[];
	/** Entries the server reports as skipped (trash, delete, duplicate rows). */
	skipped: number;
}

export interface RunRevertOptions {
	/** Only these objects (a retry of conflicts); the plan's chunks otherwise. */
	ids?: number[];
	force?: boolean;
	/** The id to keep logging under (a forced retry joins the first pass). */
	revertBatchId?: string;
	onProgress?( done: number, total: number ): void;
}

function chunk< T >( list: T[], size: number ): T[][] {
	const out: T[][] = [];
	const step = Math.max( 1, size );

	for ( let index = 0; index < list.length; index += step ) {
		out.push( list.slice( index, index + step ) );
	}

	return out;
}

export function splitResults( results: ActionResult[] ): Pick< RevertOutcome, 'ok' | 'conflicts' | 'failed' | 'skipped' > {
	const outcome = { ok: 0, conflicts: [] as ActionResult[], failed: [] as ActionResult[], skipped: 0 };

	for ( const result of results ) {
		if ( result.ok ) {
			outcome.ok += 1;
		} else if ( result.code === 'conflict' ) {
			outcome.conflicts.push( result );
		} else if ( result.code === 'skipped' ) {
			outcome.skipped += 1;
		} else {
			outcome.failed.push( result );
		}
	}

	return outcome;
}

/** Post the revert chunk by chunk; `plan.chunks` or the given ids cut to the plan's chunk size. */
export async function runRevert( batchId: string, plan: Pick< RevertPlan, 'chunk' | 'chunks' >, options: RunRevertOptions = {}, post: typeof revertBatch = revertBatch ): Promise< RevertOutcome > {
	const revertBatchId = options.revertBatchId ?? newBatchId();
	const chunks = options.ids ? chunk( options.ids, plan.chunk || 100 ) : plan.chunks;
	const total = chunks.reduce( ( sum, ids ) => sum + ids.length, 0 );
	const results: ActionResult[] = [];
	let done = 0;

	options.onProgress?.( 0, total );

	for ( const ids of chunks ) {
		if ( ! ids.length ) {
			continue;
		}

		const response = await post( batchId, { ids, revertBatchId, force: options.force, fields: [ 'id' ] } );

		results.push( ...( response.results ?? [] ) );
		done += ids.length;
		options.onProgress?.( done, total );
	}

	return { revertBatchId, ...splitResults( results ) };
}

/** The plan, then every chunk of it. */
export async function revertWholeBatch( batchId: string, options: Omit< RunRevertOptions, 'ids' > = {} ): Promise< RevertOutcome & { plan: RevertPlan } > {
	const plan = await getRevertPlan( batchId );
	const outcome = await runRevert( batchId, plan, options );

	return { ...outcome, plan };
}
