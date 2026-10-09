/**
 * The save orchestration with its I/O injected, so it is unit-testable
 * without the REST client or the cache. save.ts wires the real ones in.
 *
 * `planSave` is the synchronous half: which rows get written with what,
 * which are skipped (do not manage stock, already on sale) and which are
 * unchanged. The modal shows the plan before Save; `runSave` executes it.
 *
 * Order: variations first, then parents (`products/batch`, chunked, side by side). The
 * variations go through the cross-parent `variations/batch` route in
 * chunks of `variationsBatchSize` (a scheduled sale over a page of
 * variable products is one or two requests, not one per parent); without
 * that dep they go one `variations/batch` per parent in sequence.
 * Rows are patched optimistically before each request and replaced by the
 * returned objects after; failed rows roll back and are reported per id.
 */
import { __ } from '@wordpress/i18n';
import type { BatchItemError, BatchResponse, BatchResult, ProductField, ProductListItem, RawProduct, RawVariation, Settings } from '../types';
import { isBatchItemError } from '../types';
import type { FetchVariations } from './apply-to-variations';
import { resolveSaveTargets, resolveSaveTargetsWith } from './apply-to-variations';
import type { SaveTarget } from './apply-to-variations';
import { humanizeError } from './errors';
import { isVariation, parentIdOf } from './field-value';
import { buildPayload, hasPayload, STOCK_DELTA_KEY } from './payload';
import { hasSale, hasSaleEdit, hasStockGatedEdit, resolveRowEdits, saleIsActive } from './row-rules';
import type { RowEditOptions } from './row-rules';

export interface SaveRequestOptions {
	batchId: string;
	source: 'quick' | 'bulk';
	/** The wc/v3 fields the returned rows are trimmed to (what the list shows); whole objects when missing. */
	fields?: string[];
}

export interface SaveDeps {
	batchProducts( update: Array< { id: number } & Record< string, unknown > >, options: SaveRequestOptions ): Promise< BatchResponse< RawProduct > >;
	batchVariations( parentId: number, update: Array< { id: number } & Record< string, unknown > >, options: SaveRequestOptions ): Promise< BatchResponse< RawVariation > >;
	/** Variations of any parents in one request (`POST /wc-products-list/v1/variations/batch`); when present it replaces the per-parent calls. */
	batchVariationsAcross?( update: Array< { id: number; parent_id: number } & Record< string, unknown > >, options: SaveRequestOptions ): Promise< BatchResponse< RawVariation > >;
	fetchVariations: FetchVariations;
	patchItems( items: Array< Partial< ProductListItem > & { id: number } > ): void;
	newBatchId(): string;
	batchSize: number;
	/** Rows per cross-parent variations request (the server's batch limit, 100); `batchSize` when missing. */
	variationsBatchSize?: number;
	/** Normalise a wc/v3 object a write returned the way list reads are (toRow: hierarchy keys, `wcProductsList.item` filter). */
	normalizeRow?( raw: RawProduct | RawVariation, parentId?: number ): ProductListItem;
	/** Cross-parent variation requests in flight at once (they are independent per chunk); `DEFAULT_CONCURRENCY` when missing. */
	concurrency?: number;
}

/** Variation chunks sent side by side: a 500-variation campaign is three requests at a time, not five in a row. */
export const DEFAULT_CONCURRENCY = 3;

/** Run `tasks` with at most `limit` in flight, starting them in order. */
export async function runConcurrently( tasks: Array< () => Promise< void > >, limit: number ): Promise< void > {
	const queue = [ ...tasks ];
	const worker = async () => {
		while ( queue.length ) {
			const task = queue.shift()!;

			await task();
		}
	};

	await Promise.all( Array.from( { length: Math.max( 1, Math.min( limit, queue.length ) ) }, worker ) );
}

export interface SaveOptions extends RowEditOptions {
	applyToVariations: boolean;
	source: 'quick' | 'bulk';
	/** Trim the rows a write returns to these wc/v3 fields (a 100-row page is tens of KB instead of a megabyte). */
	fields?: string[];
	onProgress?( done: number, total: number ): void;
	/** Variations already fetched by the modal (keyed by parent id), so the save does not fetch them again. */
	prefetchedVariations?: ReadonlyMap< number, ProductListItem[] >;
	/** Variable parents that only carry their variations (a retry): their own edits are not sent again. */
	carriersOnly?: ReadonlySet< number >;
	/** The History batch to write under (the editor shares one with the tool runs of the same Update); a new one when missing. */
	batchId?: string;
}

export interface Prepared {
	target: SaveTarget;
	payload: Record< string, unknown >;
	/** The row's values for the payload's top-level keys, to roll back to. */
	snapshot: Record< string, unknown >;
}

export interface SavePlan {
	/** The rows that get a request, with their bodies. */
	writes: Prepared[];
	/** Parent products among the writes. */
	products: number;
	/** Variations among the writes. */
	variations: number;
	/** Rows the edits reach whose values already equal the result. */
	unchanged: number;
	/** Rows a stock edit was dropped for (they do not manage stock). */
	stockSkipped: ProductListItem[];
	/** Rows left alone because they already have a sale. */
	saleSkipped: ProductListItem[];
	/** Rows left alone because the new sale price would not be lower than what they sell at now. */
	notLowerSkipped: ProductListItem[];
	/** Rows written whose existing sale the edits replace. */
	replacedSales: number;
	/** Of those, the rows on sale right now: the sales Update ends (after every skip rule, so the button counts what really ends). */
	endedRunningSales?: number;
	/** Every row the plan left out, with why and the edit keys it would have changed (for the audit log). */
	skippedItems: PlanSkip[];
}

export interface PlanSkip {
	id: number;
	reason: 'no_stock_management' | 'has_sale' | 'other';
	fields: string[];
	message?: string;
}

/** What `runSave` reports: the batch result plus what the plan left out. */
export interface SaveResult extends BatchResult {
	unchanged: number;
	stockSkipped: number;
	saleSkipped: number;
	/** Rows the "only where it gets cheaper" guard left alone. */
	notLowerSkipped?: number;
	replacedSales: number;
	/** The rows the plan left out, for POST /log/skipped. */
	skippedItems?: PlanSkip[];
}

function chunk< T >( list: T[], size: number ): T[][] {
	const chunks: T[][] = [];
	const step = Math.max( 1, size );

	for ( let index = 0; index < list.length; index += step ) {
		chunks.push( list.slice( index, index + step ) );
	}

	return chunks;
}

/**
 * The cross-parent variation requests, as lanes: each lane's requests run
 * one after the other, lanes run side by side, and no parent's rows are in
 * two lanes. Parents that fit go whole into shared requests of up to
 * `size` rows (a parent never split between them); a parent with more rows
 * than that gets a lane of its own, chunked.
 */
export function packVariationLanes< T >( parents: T[][], size: number ): T[][][] {
	const step = Math.max( 1, size );
	const lanes: T[][][] = [];
	let current: T[] = [];

	for ( const rows of parents ) {
		if ( rows.length === 0 ) {
			continue;
		}

		if ( rows.length > step ) {
			lanes.push( chunk( rows, step ) );
			continue;
		}

		if ( current.length + rows.length > step ) {
			lanes.push( [ current ] );
			current = [];
		}

		current = current.concat( rows );
	}

	if ( current.length ) {
		lanes.push( [ current ] );
	}

	return lanes;
}

function errorMessage( error: unknown ): string {
	if ( error instanceof Error ) {
		return error.message;
	}

	if ( typeof error === 'object' && error !== null && 'message' in error ) {
		return String( ( error as { message: unknown } ).message );
	}

	return String( error );
}

/**
 * A write returns the object with full-size `images`; the list shows
 * thumbnails. Unless the save touched them, the row keeps the ones it has.
 */
export function withoutUntouchedImages< Row extends Record< string, unknown > >( row: Row, payload: Record< string, unknown > ): Row {
	const copy: Record< string, unknown > = { ...row };

	for ( const key of [ 'images', 'image' ] ) {
		if ( ! ( key in payload ) ) {
			delete copy[ key ];
		}
	}

	return copy as Row;
}

function errorCode( error: unknown ): string | undefined {
	if ( typeof error === 'object' && error !== null && 'code' in error ) {
		return String( ( error as { code: unknown } ).code );
	}

	return undefined;
}

/** Keys we can show optimistically: top-level wc/v3 keys the row already has in the same shape. */
function optimisticPatch( target: SaveTarget, payload: Record< string, unknown > ): Partial< ProductListItem > & { id: number } {
	const patch: Record< string, unknown > = { id: target.item.id };
	const row = target.item as Record< string, unknown >;

	for ( const [ key, value ] of Object.entries( payload ) ) {
		const current = row[ key ];

		// A relative stock edit is an instruction to the server: show the projected quantity.
		if ( key === STOCK_DELTA_KEY ) {
			const stock = Number( row.stock_quantity );

			if ( Number.isFinite( stock ) && typeof value === 'number' ) {
				patch.stock_quantity = stock + value;
			}

			continue;
		}

		if ( typeof current === 'object' && current !== null ) {
			continue;
		}

		patch[ key ] = value;
	}

	return patch as Partial< ProductListItem > & { id: number };
}

function snapshotOf( target: SaveTarget, patch: Record< string, unknown > ): Record< string, unknown > {
	const row = target.item as Record< string, unknown >;
	const snapshot: Record< string, unknown > = { id: target.item.id };

	for ( const key of Object.keys( patch ) ) {
		snapshot[ key ] = row[ key ];
	}

	return snapshot;
}

/** Turn resolved targets into the plan: payloads for the rows that change, counts for the rest. */
export function planTargets( targets: SaveTarget[], fields: ProductField[], settings: Settings, options: RowEditOptions = {} ): SavePlan {
	const plan: SavePlan = { writes: [], products: 0, variations: 0, unchanged: 0, stockSkipped: [], saleSkipped: [], notLowerSkipped: [], replacedSales: 0, endedRunningSales: 0, skippedItems: [] };
	const now = Date.now();

	for ( const target of targets ) {
		const own = resolveRowEdits( target.item, target.edits, options );
		const dropped = Object.keys( target.edits ).filter( ( key ) => ! ( key in own ) );

		if ( hasStockGatedEdit( target.edits ) && ! hasStockGatedEdit( own ) ) {
			plan.stockSkipped.push( target.item );
			plan.skippedItems.push( { id: target.item.id, reason: 'no_stock_management', fields: dropped } );
		}

		if ( hasSaleEdit( target.edits ) && ! hasSaleEdit( own ) ) {
			// Dropped by the "only where it gets cheaper" guard, or for having a sale already.
			if ( options.keepSale && hasSaleEdit( resolveRowEdits( target.item, target.edits, { ...options, keepSale: undefined } ) ) ) {
				plan.notLowerSkipped.push( target.item );
				plan.skippedItems.push( { id: target.item.id, reason: 'other', fields: dropped, message: __( 'Skipped: the new sale price would not be lower than the price it sells at now.', 'wp-woocommerce-products-list' ) } );
			} else {
				plan.saleSkipped.push( target.item );
				plan.skippedItems.push( { id: target.item.id, reason: 'has_sale', fields: dropped } );
			}
		}

		if ( Object.keys( own ).length === 0 ) {
			continue;
		}

		const payload = buildPayload( target.item, own, fields, settings, options );

		if ( ! hasPayload( payload ) ) {
			plan.unchanged += 1;
			continue;
		}

		const patch = optimisticPatch( target, payload );

		plan.writes.push( { target, payload, snapshot: snapshotOf( target, patch ) } );

		if ( isVariation( target.item ) ) {
			plan.variations += 1;
		} else {
			plan.products += 1;
		}

		if ( hasSale( target.item ) && hasSaleEdit( own ) ) {
			plan.replacedSales += 1;

			if ( saleIsActive( target.item, now ) ) {
				plan.endedRunningSales = ( plan.endedRunningSales ?? 0 ) + 1;
			}
		}
	}

	return plan;
}

/**
 * The plan for a selection with the variations already fetched (what the
 * modal shows as "Save N products, M variations" and in the summary).
 */
export function planSave(
	items: ProductListItem[],
	edits: Record< string, unknown >,
	fields: ProductField[],
	settings: Settings,
	options: RowEditOptions & { applyToVariations: boolean; variationsByParent?: ReadonlyMap< number, ProductListItem[] >; carriersOnly?: ReadonlySet< number > }
): SavePlan {
	const targets = resolveSaveTargetsWith( items, edits, fields, { applyToVariations: options.applyToVariations, variationsByParent: options.variationsByParent, carriersOnly: options.carriersOnly } );

	return planTargets( targets, fields, settings, options );
}

/** Prepare the per-row payloads; rows with nothing to send are left out. */
export async function prepareSave( deps: Pick< SaveDeps, 'fetchVariations' >, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: Pick< SaveOptions, 'applyToVariations' | 'prefetchedVariations' | 'enableManageStock' | 'skipExistingSales' | 'keepSale' | 'carriersOnly' > ): Promise< Prepared[] > {
	return ( await preparePlan( deps, items, edits, fields, settings, options ) ).writes;
}

async function preparePlan( deps: Pick< SaveDeps, 'fetchVariations' >, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: Pick< SaveOptions, 'applyToVariations' | 'prefetchedVariations' | 'enableManageStock' | 'skipExistingSales' | 'keepSale' | 'carriersOnly' > ): Promise< SavePlan > {
	const prefetched = options.prefetchedVariations;
	const fetchVariations: FetchVariations = ( parentId, fieldList ) => {
		const rows = prefetched?.get( parentId );

		return rows ? Promise.resolve( rows ) : deps.fetchVariations( parentId, fieldList );
	};
	const targets = await resolveSaveTargets( items, edits, fields, { applyToVariations: options.applyToVariations, fetchVariations, carriersOnly: options.carriersOnly } );

	return planTargets( targets, fields, settings, { enableManageStock: options.enableManageStock, skipExistingSales: options.skipExistingSales, keepSale: options.keepSale } );
}

export async function runSave( deps: SaveDeps, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: SaveOptions ): Promise< SaveResult > {
	const batchId = options.batchId ?? deps.newBatchId();
	const plan = await preparePlan( deps, items, edits, fields, settings, options );
	const prepared = plan.writes;
	const result: SaveResult = {
		updated: [],
		errors: [],
		batchId,
		unchanged: plan.unchanged,
		stockSkipped: plan.stockSkipped.length,
		saleSkipped: plan.saleSkipped.length,
		notLowerSkipped: plan.notLowerSkipped.length,
		replacedSales: plan.replacedSales,
		skippedItems: plan.skippedItems,
	};
	const total = prepared.length;
	let done = 0;

	options.onProgress?.( 0, total );

	if ( total === 0 ) {
		return result;
	}

	const requestOptions: SaveRequestOptions = { batchId, source: options.source, ...( options.fields?.length ? { fields: options.fields } : {} ) };
	const byId = new Map( prepared.map( ( entry ) => [ entry.target.item.id, entry ] ) );

	/*
	 * The returned rows go into the cache on the next task, not inside the
	 * request loop: patching re-renders the list (hundreds of expanded
	 * variation rows), and done synchronously that render sat between one
	 * response and the next request of its lane, seconds of idle network on
	 * a 261-variation campaign. Responses that land together share one
	 * render. Optimistic patches flush what is queued first, so the order
	 * of writes to a row never changes, and the save flushes before it
	 * resolves.
	 */
	let queued: Array< Partial< ProductListItem > & { id: number } > = [];
	let flushTimer: ReturnType< typeof setTimeout > | null = null;
	const flush = (): void => {
		if ( flushTimer !== null ) {
			clearTimeout( flushTimer );
			flushTimer = null;
		}

		if ( queued.length ) {
			const patches = queued;

			queued = [];
			deps.patchItems( patches );
		}
	};
	const queuePatches = ( patches: Array< Partial< ProductListItem > & { id: number } > ): void => {
		queued = queued.concat( patches );

		if ( flushTimer === null ) {
			flushTimer = setTimeout( flush, 0 );
		}
	};
	const patchNow = ( patches: Array< Partial< ProductListItem > & { id: number } > ): void => {
		flush();
		deps.patchItems( patches );
	};

	// One patch per response: every patch re-renders the list (and the
	// expanded variations), so 100 rows go into the cache in one go, not 100.
	const applyResponse = ( group: Prepared[], response: BatchResponse< RawProduct | RawVariation > ): void => {
		const seen = new Set< number >();
		const patches: Array< Partial< ProductListItem > & { id: number } > = [];

		for ( const entry of response.update ?? [] ) {
			if ( isBatchItemError( entry ) ) {
				const failed = entry as BatchItemError;
				const original = byId.get( failed.id );

				seen.add( failed.id );
				result.errors.push( { id: failed.id, message: humanizeError( failed.error.code, failed.error.message ), code: failed.error.code } );

				if ( original ) {
					patches.push( original.snapshot as Partial< ProductListItem > & { id: number } );
				}

				continue;
			}

			seen.add( entry.id );

			const original = byId.get( entry.id );
			const parentId = original ? parentIdOf( original.target.item ) : 0;
			const normalized = deps.normalizeRow ? deps.normalizeRow( entry, parentId > 0 ? parentId : undefined ) : ( entry as ProductListItem );
			const row = withoutUntouchedImages( normalized as Record< string, unknown >, original?.payload ?? {} ) as ProductListItem;

			patches.push( row );
			result.updated.push( { ...( original?.target.item ?? {} ), ...row } as ProductListItem );
		}

		for ( const entry of group ) {
			if ( ! seen.has( entry.target.item.id ) ) {
				result.errors.push( { id: entry.target.item.id, message: humanizeError( 'missing_result', '' ), code: 'missing_result' } );
				patches.push( entry.snapshot as Partial< ProductListItem > & { id: number } );
			}
		}

		if ( patches.length ) {
			queuePatches( patches );
		}
	};

	const failGroup = ( group: Prepared[], error: unknown ): void => {
		const code = errorCode( error );
		const message = humanizeError( code, errorMessage( error ) );

		for ( const entry of group ) {
			result.errors.push( { id: entry.target.item.id, message, code } );
		}

		queuePatches( group.map( ( entry ) => entry.snapshot as Partial< ProductListItem > & { id: number } ) );
	};

	const variations = prepared.filter( ( entry ) => isVariation( entry.target.item ) );
	const parents = prepared.filter( ( entry ) => ! isVariation( entry.target.item ) );

	const byParent = new Map< number, Prepared[] >();

	for ( const entry of variations ) {
		const parentId = parentIdOf( entry.target.item );
		const list = byParent.get( parentId ) ?? [];

		list.push( entry );
		byParent.set( parentId, list );
	}

	if ( deps.batchVariationsAcross ) {
		// Whole parents per request (the server syncs a parent's price and stock
		// once per request it appears in): a parent never shares out between two
		// requests in flight, so its sync always reads its final variations. A
		// parent larger than one request goes in requests of its own, one after
		// the other. Lanes that share no parent go out side by side.
		const ordered = Array.from( byParent.values() ).flat();
		const across = deps.batchVariationsAcross;
		const lanes = packVariationLanes( Array.from( byParent.values() ), deps.variationsBatchSize ?? deps.batchSize );

		// Every row shows its new value at once, not chunk by chunk.
		patchNow( ordered.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

		await runConcurrently(
			lanes.map( ( lane ) => async () => {
				for ( const group of lane ) {
					try {
						const response = await across(
							group.map( ( entry ) => ( { id: entry.target.item.id, parent_id: parentIdOf( entry.target.item ), ...entry.payload } ) ),
							requestOptions
						);

						applyResponse( group, response );
					} catch ( error ) {
						failGroup( group, error );
					}

					done += group.length;
					options.onProgress?.( done, total );
				}
			} ),
			deps.concurrency ?? DEFAULT_CONCURRENCY
		);
	} else {
		for ( const [ parentId, entries ] of byParent ) {
			for ( const group of chunk( entries, deps.batchSize ) ) {
				patchNow( group.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

				try {
					const response = await deps.batchVariations( parentId, group.map( ( entry ) => ( { id: entry.target.item.id, ...entry.payload } ) ), requestOptions );

					applyResponse( group, response );
				} catch ( error ) {
					failGroup( group, error );
				}

				done += group.length;
				options.onProgress?.( done, total );
			}
		}
	}

	// Products are independent of each other: their requests go out side by
	// side, cut so that every slot has work (100 rows, 3 at a time: 34+34+32,
	// never 50 then 50), and every row shows its new value at once.
	if ( parents.length ) {
		const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
		const size = Math.max( 1, Math.min( deps.batchSize, Math.ceil( parents.length / concurrency ) ) );

		patchNow( parents.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

		await runConcurrently(
			chunk( parents, size ).map( ( group ) => async () => {
				try {
					const response = await deps.batchProducts( group.map( ( entry ) => ( { id: entry.target.item.id, ...entry.payload } ) ), requestOptions );

					applyResponse( group, response );
				} catch ( error ) {
					failGroup( group, error );
				}

				done += group.length;
				options.onProgress?.( done, total );
			} ),
			concurrency
		);
	}

	flush();

	return result;
}
