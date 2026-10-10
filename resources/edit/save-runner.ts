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
import { humanizeError, isConflictCode, isServerLoggedItemError } from './errors';
import { writeItem } from './expect';
import { isVariation, parentIdOf } from './field-value';
import { buildPayload, hasPayload, STOCK_DELTA_KEY } from './payload';
import { hasSale, hasSaleEdit, hasStockGatedEdit, resolveRowEdits, saleIsActive } from './row-rules';
import type { RowEditOptions } from './row-rules';

export interface SaveRequestOptions {
	batchId: string;
	source: 'quick' | 'bulk';
	/** The wc/v3 fields the returned rows are trimmed to (what the list shows); whole objects when missing. */
	fields?: string[];
	/** A save of several requests: the rows it writes in all (the batch stays `running` until `closeBatch`). */
	planned?: number;
}

export interface SaveDeps {
	batchProducts( update: Array< { id: number } & Record< string, unknown > >, options: SaveRequestOptions ): Promise< BatchResponse< RawProduct > >;
	batchVariations( parentId: number, update: Array< { id: number } & Record< string, unknown > >, options: SaveRequestOptions ): Promise< BatchResponse< RawVariation > >;
	/** Variations of any parents in one request (`POST /wc-products-list/v1/variations/batch`); when present it replaces the per-parent calls. */
	batchVariationsAcross?( update: Array< { id: number; parent_id: number } & Record< string, unknown > >, options: SaveRequestOptions ): Promise< BatchResponse< RawVariation > >;
	fetchVariations: FetchVariations;
	patchItems( items: Array< Partial< ProductListItem > & { id: number } > ): void;
	/** These rows' writes came back from the server (not the optimistic patches): the list unlocks them. */
	rowsWritten?( ids: number[] ): void;
	newBatchId(): string;
	batchSize: number;
	/** Rows per cross-parent variations request (the server's batch limit, 100); `batchSize` when missing. */
	variationsBatchSize?: number;
	/** Normalise a wc/v3 object a write returned the way list reads are (toRow: hierarchy keys, `wcProductsList.item` filter). */
	normalizeRow?( raw: RawProduct | RawVariation, parentId?: number ): ProductListItem;
	/** Cross-parent variation requests in flight at once (they are independent per chunk); `DEFAULT_CONCURRENCY` when missing. */
	concurrency?: number;
	/**
	 * Read these rows' stored values again (`fields` plus id and stamp), after
	 * a request failed as a whole with an outcome the client cannot know (the
	 * connection dropped, a gateway timeout, a 5xx after the commit). By id;
	 * rows that no longer exist are absent. Without it such rows roll back
	 * to their snapshots and are reported as failed.
	 */
	rereadRows?( items: ProductListItem[], fields: string[] ): Promise< Map< number, ProductListItem > >;
	/** Run `task` on the next macrotask (tests pass a synchronous one). */
	defer?( task: () => void ): void;
	/** The save of a batch sent with `planned` is over (`POST /log/batch/{id}/close`); awaited before the result is returned. */
	closeBatch?( batchId: string ): Promise< void >;
}

/**
 * The next macrotask, without the timer clamping of a hidden tab
 * (MessageChannel is not throttled the way setTimeout is).
 */
export function nextTask( task: () => void ): void {
	if ( typeof MessageChannel === 'function' ) {
		const channel = new MessageChannel();

		channel.port1.onmessage = () => {
			channel.port1.close();
			task();
		};
		channel.port2.postMessage( null );

		return;
	}

	setTimeout( task, 0 );
}

/** The error code of a row whose write may or may not have been stored (the re-read could not tell). */
export const UNCERTAIN_CODE = 'wc_products_list_uncertain';

/**
 * Whether a request that failed as a whole may still have been stored: no
 * HTTP answer at all (the connection dropped, a timeout), an unreadable
 * one, or a server/gateway error. A 4xx was refused before anything was
 * written.
 */
export function outcomeUnknown( error: unknown ): boolean {
	const status = Number( ( error as { status?: unknown } | null )?.status ?? 0 );
	const code = String( ( error as { code?: unknown } | null )?.code ?? '' );

	if ( status >= 400 && status < 500 ) {
		return false;
	}

	return status === 0 || status >= 500 || code === 'fetch_error' || code === 'invalid_json' || code === 'invalid_response';
}

function sameValue( wanted: unknown, stored: unknown ): boolean | null {
	if ( wanted === null || wanted === undefined || wanted === '' ) {
		return stored === null || stored === undefined || stored === '';
	}

	if ( typeof wanted === 'number' || typeof wanted === 'string' ) {
		if ( typeof stored !== 'number' && typeof stored !== 'string' ) {
			return false;
		}

		const a = Number( wanted );
		const b = Number( stored );

		// "21.9" and "21.90" are one price.
		return String( wanted ) === String( stored ) || ( String( wanted ).trim() !== '' && String( stored ).trim() !== '' && Number.isFinite( a ) && Number.isFinite( b ) && a === b );
	}

	if ( typeof wanted === 'boolean' ) {
		return stored === wanted;
	}

	if ( Array.isArray( wanted ) ) {
		if ( ! Array.isArray( stored ) ) {
			return false;
		}

		// Terms and images go by id; anything else is not compared.
		const ids = ( list: unknown[] ) => list.map( ( entry ) => ( typeof entry === 'object' && entry !== null && 'id' in entry ? Number( ( entry as { id: unknown } ).id ) : NaN ) );
		const a = ids( wanted );
		const b = ids( stored );

		if ( a.some( Number.isNaN ) || b.some( Number.isNaN ) ) {
			return null;
		}

		return a.length === b.length && a.every( ( id ) => b.includes( id ) );
	}

	if ( typeof wanted === 'object' ) {
		if ( typeof stored !== 'object' || stored === null || Array.isArray( stored ) ) {
			return false;
		}

		let known = false;

		for ( const [ key, value ] of Object.entries( wanted as Record< string, unknown > ) ) {
			const same = sameValue( value, ( stored as Record< string, unknown > )[ key ] );

			if ( same === false ) {
				return false;
			}

			known ||= same === true;
		}

		return known ? true : null;
	}

	return null;
}

/**
 * Whether a re-read row holds what the write sent: true when every key it
 * can compare matches (and there is one), false when one differs, null when
 * nothing could be compared (only a relative stock change, meta data).
 */
export function payloadStored( row: Record< string, unknown >, payload: Record< string, unknown > ): boolean | null {
	let known = false;

	for ( const [ key, value ] of Object.entries( payload ) ) {
		if ( key === STOCK_DELTA_KEY || key === 'meta_data' ) {
			continue;
		}

		if ( ! ( key in row ) ) {
			continue;
		}

		const same = sameValue( value, row[ key ] );

		if ( same === false ) {
			return false;
		}

		known ||= same === true;
	}

	return known ? true : null;
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
	/**
	 * The caller writes more under `batchId` after this save (the editor's staged tools) and closes the batch itself
	 * (`closeBatch`) once those are done: every request sends the planned header, and the runner does not close it.
	 */
	keepBatchOpen?: boolean;
	/** Rows the caller writes under the batch after this save (added to the planned header). */
	plannedExtra?: number;
	/**
	 * The row a write's `_wcpl_expect` is read from (expect.ts): the editor passes the values each field showed when the
	 * user started editing it (shown-values.ts), never values loaded afterwards; the row itself when missing.
	 */
	expectBase?( item: ProductListItem ): ProductListItem;
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

/**
 * Whether a row's write replaces the sale it has: only a new sale price does (unticking "Schedule sale" or moving its
 * dates keeps the row's sale price), and a new sale whose price and dates the row already has is not sent and
 * replaces nothing. `own` is the row's resolved edits, `payload` what is sent for them.
 */
export function replacesSale( item: ProductListItem, own: Record< string, unknown >, payload: Record< string, unknown > ): boolean {
	return hasSale( item ) && hasSaleEdit( own ) && own.sale_price !== undefined && [ 'sale_price', 'date_on_sale_from', 'date_on_sale_to' ].some( ( key ) => key in payload );
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
			if ( replacesSale( target.item, own, payload ) ) {
				plan.replacedSales += 1;
			}

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

	options.onProgress?.( 0, total );

	if ( total === 0 ) {
		return result;
	}

	// A save of more than one row may take several requests: the server keeps the batch `running` (History will not revert it
	// half-written) until it is closed below. One row is one request, done when it ends. A batch the caller keeps open
	// (more writes follow under it) is planned with those writes and closed by the caller.
	const planned = options.keepBatchOpen ? total + Math.max( 0, options.plannedExtra ?? 0 ) : total > 1 && deps.closeBatch ? total : 0;
	const closes = planned > 0 && ! options.keepBatchOpen;
	const requestOptions: SaveRequestOptions = { batchId, source: options.source, ...( options.fields?.length ? { fields: options.fields } : {} ), ...( planned ? { planned } : {} ) };

	try {
		return await writePlan( deps, prepared, result, requestOptions, options, total );
	} finally {
		if ( closes ) {
			await deps.closeBatch!( batchId );
		}
	}
}

async function writePlan( deps: SaveDeps, prepared: Prepared[], result: SaveResult, requestOptions: SaveRequestOptions, options: SaveOptions, total: number ): Promise< SaveResult > {
	let done = 0;
	const byId = new Map( prepared.map( ( entry ) => [ entry.target.item.id, entry ] ) );

	/*
	 * The cache is written twice per save, not once per response: the
	 * optimistic values when the requests are on their way, and every
	 * returned row (and rollback) in one go when the last one is back. Each
	 * write re-renders the list (hundreds of expanded variation rows), and a
	 * render between two responses held the main thread for a second at a
	 * time while the next request of a lane waited. The optimistic patch
	 * runs on the next task, after the requests went out (a render in the
	 * same task ran before apiFetch's middleware chain reached fetch(), so
	 * the network sat idle behind it). A row's writes keep their order: a
	 * pending optimistic patch is applied before the final flush.
	 */
	const defer = deps.defer ?? nextTask;
	let queued: Array< Partial< ProductListItem > & { id: number } > = [];
	let optimistic: Array< Partial< ProductListItem > & { id: number } > = [];
	let optimisticScheduled = false;
	const applyOptimistic = (): void => {
		if ( optimistic.length ) {
			const patches = optimistic;

			optimistic = [];
			deps.patchItems( patches );
		}
	};
	const flush = (): void => {
		applyOptimistic();

		if ( queued.length ) {
			const patches = queued;

			queued = [];
			deps.patchItems( patches );
			deps.rowsWritten?.( patches.map( ( patch ) => patch.id ) );
		}
	};
	const queuePatches = ( patches: Array< Partial< ProductListItem > & { id: number } > ): void => {
		queued = queued.concat( patches );
	};
	const patchSoon = ( patches: Array< Partial< ProductListItem > & { id: number } > ): void => {
		optimistic = optimistic.concat( patches );

		if ( ! optimisticScheduled ) {
			optimisticScheduled = true;
			defer( () => {
				optimisticScheduled = false;
				applyOptimistic();
			} );
		}
	};
	/** Groups whose request failed as a whole with an outcome the client cannot know: re-read before they are reported. */
	const uncertain: Array< { group: Prepared[]; message: string; code?: string } > = [];
	/** Rows the server refused because they changed meanwhile: they show what is stored now, not the editor's old values. */
	const conflicted: Prepared[] = [];

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
				const conflict = isConflictCode( failed.error.code ) && typeof failed.error.data === 'object' && failed.error.data !== null;

				// A conflict keeps its data (the fields, the values stored now, the values the edit was based on): the editor shows them.
				result.errors.push( {
					id: failed.id,
					message: humanizeError( failed.error.code, failed.error.message ),
					code: failed.error.code,
					...( conflict ? { data: failed.error.data as Record< string, unknown > } : {} ),
					...( isServerLoggedItemError( failed.error.code, failed.error.data ) ? { logged: true } : {} ),
				} );

				if ( original ) {
					patches.push( original.snapshot as Partial< ProductListItem > & { id: number } );

					if ( isConflictCode( failed.error.code ) ) {
						conflicted.push( original );
					}
				}

				continue;
			}

			seen.add( entry.id );

			const original = byId.get( entry.id );
			const parentId = original ? parentIdOf( original.target.item ) : 0;
			const normalized = deps.normalizeRow ? deps.normalizeRow( entry, parentId > 0 ? parentId : undefined ) : ( entry as ProductListItem );
			const row = withoutUntouchedImages( normalized as Record< string, unknown >, original?.payload ?? {} ) as ProductListItem;

			patches.push( row );
			// The target may be a variation fetched with trimmed fields (a parent's "all its variations"), which
			// normalises to `images: []`: unless the save touched images, they are not part of the saved row.
			result.updated.push( { ...withoutUntouchedImages( ( original?.target.item ?? {} ) as Record< string, unknown >, original?.payload ?? {} ), ...row } as ProductListItem );
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

		if ( deps.rereadRows && outcomeUnknown( error ) ) {
			uncertain.push( { group, message, code } );

			return;
		}

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

		// Every row shows its new value at once, not chunk by chunk (once the requests are out).
		patchSoon( ordered.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

		await runConcurrently(
			lanes.map( ( lane ) => async () => {
				for ( const group of lane ) {
					try {
						const response = await across(
							group.map( ( entry ) => ( { ...writeItem( options.expectBase?.( entry.target.item ) ?? entry.target.item, entry.payload ), parent_id: parentIdOf( entry.target.item ) } ) ),
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
				patchSoon( group.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

				try {
					const response = await deps.batchVariations( parentId, group.map( ( entry ) => writeItem( options.expectBase?.( entry.target.item ) ?? entry.target.item, entry.payload ) ), requestOptions );

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

		patchSoon( parents.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

		await runConcurrently(
			chunk( parents, size ).map( ( group ) => async () => {
				try {
					const response = await deps.batchProducts( group.map( ( entry ) => writeItem( options.expectBase?.( entry.target.item ) ?? entry.target.item, entry.payload ) ), requestOptions );

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

	if ( uncertain.length ) {
		await settleUncertain( deps, uncertain, result, queuePatches );
	}

	if ( conflicted.length && deps.rereadRows ) {
		await refreshConflicted( deps, conflicted, queuePatches );
	}

	flush();

	return result;
}

/**
 * Rows refused with `wc_products_list_conflict` (changed by someone else
 * since they were loaded) are read again, so the list and a retry work on
 * the stored values; when the read fails they keep their snapshots.
 */
async function refreshConflicted( deps: SaveDeps, entries: Prepared[], queuePatches: ( patches: Array< Partial< ProductListItem > & { id: number } > ) => void ): Promise< void > {
	const keys = new Set< string >( [ 'id', 'date_modified_gmt', 'status' ] );

	for ( const entry of entries ) {
		for ( const key of Object.keys( entry.payload ) ) {
			keys.add( key === STOCK_DELTA_KEY ? 'stock_quantity' : key );
		}
	}

	try {
		const fresh = await deps.rereadRows!( entries.map( ( entry ) => entry.target.item ), Array.from( keys ).sort() );
		const patches: Array< Partial< ProductListItem > & { id: number } > = [];

		for ( const entry of entries ) {
			const row = fresh.get( entry.target.item.id );

			if ( row ) {
				patches.push( { ...withoutUntouchedImages( row as Record< string, unknown >, entry.payload ), id: entry.target.item.id } as Partial< ProductListItem > & { id: number } );
			}
		}

		if ( patches.length ) {
			queuePatches( patches );
		}
	} catch {
		// The snapshots stay; the error already says to reload.
	}
}

/**
 * The rows of requests that failed with an unknown outcome, read again:
 * a row that holds what was sent is reported as updated (a retry of a
 * relative op would otherwise apply it a second time), a row that does
 * not is a plain failure and shows its stored values; a row the re-read
 * cannot decide on (or that could not be read) fails with
 * `UNCERTAIN_CODE`, and the editor asks before a relative op runs on it again.
 */
async function settleUncertain(
	deps: SaveDeps,
	groups: Array< { group: Prepared[]; message: string; code?: string } >,
	result: SaveResult,
	queuePatches: ( patches: Array< Partial< ProductListItem > & { id: number } > ) => void
): Promise< void > {
	const entries = groups.flatMap( ( { group, message, code } ) => group.map( ( entry ) => ( { entry, message, code } ) ) );
	const keys = new Set< string >( [ 'id', 'date_modified_gmt', 'status' ] );

	for ( const { entry } of entries ) {
		for ( const key of Object.keys( entry.payload ) ) {
			keys.add( key === STOCK_DELTA_KEY ? 'stock_quantity' : key );
		}
	}

	let fresh: Map< number, ProductListItem > | null = null;

	try {
		fresh = await deps.rereadRows!( entries.map( ( { entry } ) => entry.target.item ), Array.from( keys ).sort() );
	} catch {
		fresh = null;
	}

	for ( const { entry, message, code } of entries ) {
		const id = entry.target.item.id;
		const row = fresh?.get( id );

		if ( ! fresh ) {
			result.errors.push( { id, message: uncertainMessage( message ), code: UNCERTAIN_CODE } );
			queuePatches( [ entry.snapshot as Partial< ProductListItem > & { id: number } ] );
			continue;
		}

		if ( ! row ) {
			result.errors.push( { id, message: humanizeError( 'woocommerce_rest_product_invalid_id', '' ), code: 'woocommerce_rest_product_invalid_id' } );
			queuePatches( [ entry.snapshot as Partial< ProductListItem > & { id: number } ] );
			continue;
		}

		const stored = payloadStored( row as Record< string, unknown >, entry.payload );
		const before = ( entry.target.item as { date_modified_gmt?: unknown } ).date_modified_gmt;
		const after = ( row as { date_modified_gmt?: unknown } ).date_modified_gmt;
		const touched = typeof before === 'string' && before !== '' && typeof after === 'string' && after !== '' && before !== after;
		const patch = { ...withoutUntouchedImages( row as Record< string, unknown >, entry.payload ), id } as Partial< ProductListItem > & { id: number };

		if ( stored === true || ( stored === null && touched ) ) {
			// The write went through before the answer was lost.
			result.updated.push( { ...withoutUntouchedImages( entry.target.item as Record< string, unknown >, entry.payload ), ...row } as ProductListItem );
			queuePatches( [ patch ] );
			continue;
		}

		// The row shows what is stored now, whatever the request did.
		queuePatches( [ patch ] );

		if ( stored === false && ! touched ) {
			result.errors.push( { id, message, ...( code ? { code } : {} ) } );
		} else {
			result.errors.push( { id, message: uncertainMessage( message ), code: UNCERTAIN_CODE } );
		}
	}
}

export function uncertainMessage( message: string ): string {
	return `${ message } ${ __( 'It may have been saved anyway: check its current values before you update it again.', 'wp-woocommerce-products-list' ) }`;
}
