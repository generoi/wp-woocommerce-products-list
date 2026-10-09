/**
 * A revert, chunked: `GET /log/batch/{id}` says which objects a revert
 * writes, in chunks of the server's size; each chunk is one POST under a
 * revert batch id shared by all of them (so History shows one batch and a
 * revert can itself be reverted). Objects whose fields were changed again
 * since the batch come back as `conflict` and are left alone; the caller
 * may post them again with `force`.
 */
import { __, sprintf } from '@wordpress/i18n';
import type { ActionResult, RevertPlan } from '../api/client';
import { checkRevert, getRevertPlan, newBatchId, revertBatch } from '../api/client';

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
	/** Take the batch's change off the current value for relative fields (stock) instead of overwriting. */
	relative?: boolean;
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

export interface RevertCheckSummary {
	/** Objects changed again since the batch (a revert leaves them as they are). */
	changed: number;
	/** Of those, the ones an earlier revert of the batch already put back. */
	alreadyReverted: number;
	/** One changed object, for an example sentence. */
	example: ActionResult | null;
}

/**
 * The dry run before a revert: which objects changed again since the batch.
 * Without ids the server checks only its first chunk, so a batch of several
 * chunks is checked chunk by chunk (in parallel: nothing is written).
 */
export async function checkRevertPlan( batchId: string, plan: Pick< RevertPlan, 'chunks' >, check: typeof checkRevert = checkRevert, signal?: AbortSignal ): Promise< RevertCheckSummary > {
	const parts = plan.chunks.length > 1 ? plan.chunks.filter( ( ids ) => ids.length ) : [ undefined ];
	const responses = await Promise.all( parts.map( ( ids ) => check( batchId, { ids, signal } ) ) );
	const summary: RevertCheckSummary = { changed: 0, alreadyReverted: 0, example: null };

	for ( const response of responses ) {
		summary.changed += response.changed ?? 0;
		summary.alreadyReverted += response.already_reverted ?? 0;
		summary.example ??= response.items.find( ( item ) => ! item.already_reverted?.length ) ?? response.items[ 0 ] ?? null;
	}

	return summary;
}

/** Chunks posted at once: the server takes at most 100 objects per call, and parallel chunks of one batch do not interfere (conflicts and `reverts` are per object). */
export const REVERT_PARALLEL = 3;

/** Post the revert in chunks, REVERT_PARALLEL at a time; `plan.chunks` or the given ids cut to the plan's chunk size. Results keep the chunk order. */
export async function runRevert( batchId: string, plan: Pick< RevertPlan, 'chunk' | 'chunks' >, options: RunRevertOptions = {}, post: typeof revertBatch = revertBatch ): Promise< RevertOutcome > {
	const revertBatchId = options.revertBatchId ?? newBatchId();
	const chunks = ( options.ids ? chunk( options.ids, plan.chunk || 100 ) : plan.chunks ).filter( ( ids ) => ids.length );
	const total = chunks.reduce( ( sum, ids ) => sum + ids.length, 0 );
	const perChunk: ActionResult[][] = chunks.map( () => [] );
	let done = 0;
	let next = 0;

	options.onProgress?.( 0, total );

	const worker = async () => {
		while ( next < chunks.length ) {
			const index = next++;
			const ids = chunks[ index ] as number[];
			const response = await post( batchId, { ids, revertBatchId, force: options.force, relative: options.relative, fields: [ 'id' ] } );

			perChunk[ index ] = response.results ?? [];
			done += ids.length;
			options.onProgress?.( done, total );
		}
	};

	await Promise.all( Array.from( { length: Math.min( REVERT_PARALLEL, chunks.length ) }, worker ) );

	return { revertBatchId, ...splitResults( perChunk.flat() ) };
}

/** The plan, then every chunk of it. */
export async function revertWholeBatch( batchId: string, options: Omit< RunRevertOptions, 'ids' > = {} ): Promise< RevertOutcome & { plan: RevertPlan } > {
	const plan = await getRevertPlan( batchId );
	const outcome = await runRevert( batchId, plan, options );

	return { ...outcome, plan };
}

function shown( value: unknown ): string {
	if ( value === null || value === undefined || value === '' ) {
		return '—';
	}

	return typeof value === 'object' ? JSON.stringify( value ) : String( value );
}

/**
 * One conflict as a sentence: "Pelsi Black 37-38: Stock quantity 10 → 9
 * kept" (the value the batch left → the value now, which the revert kept).
 * `label` maps a field key to its label when the server sent none.
 */
export function describeConflict( result: ActionResult, label: ( key: string ) => string = ( key ) => key ): string {
	const name = result.name || `#${ result.id }`;
	const keys = result.fields ?? [];
	const parts = keys.map( ( key, index ) => {
		const fieldLabel = result.labels?.[ index ] || label( key );

		if ( result.batch && result.current && key in result.batch && key in result.current ) {
			return sprintf(
				/* translators: 1: field label, 2: value the batch left, 3: value now (kept) */
				__( '%1$s %2$s → %3$s kept', 'wp-woocommerce-products-list' ),
				fieldLabel,
				shown( result.batch[ key ] ),
				shown( result.current[ key ] )
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
