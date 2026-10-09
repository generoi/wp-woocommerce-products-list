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

		const response = await post( batchId, { ids, revertBatchId, force: options.force, relative: options.relative, fields: [ 'id' ] } );

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
