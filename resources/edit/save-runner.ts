/**
 * The save orchestration with its I/O injected, so it is unit-testable
 * without the REST client or the cache. save.ts wires the real ones in.
 *
 * `planSave` is the synchronous half: which rows get written with what,
 * which are skipped (do not manage stock, already on sale) and which are
 * unchanged. The modal shows the plan before Save; `runSave` executes it.
 *
 * Order: variations first, then parents (`products/batch`, chunked). The
 * variations go through the cross-parent `variations/batch` route in
 * chunks of `variationsBatchSize` (a scheduled sale over a page of
 * variable products is one or two requests, not one per parent); without
 * that dep they go one `variations/batch` per parent in sequence.
 * Rows are patched optimistically before each request and replaced by the
 * returned objects after; failed rows roll back and are reported per id.
 */
import type { BatchItemError, BatchResponse, BatchResult, ProductField, ProductListItem, RawProduct, RawVariation, Settings } from '../types';
import { isBatchItemError } from '../types';
import type { FetchVariations } from './apply-to-variations';
import { resolveSaveTargets, resolveSaveTargetsWith } from './apply-to-variations';
import type { SaveTarget } from './apply-to-variations';
import { humanizeError } from './errors';
import { isVariation, parentIdOf } from './field-value';
import { buildPayload, hasPayload } from './payload';
import { hasSale, hasSaleEdit, hasStockGatedEdit, resolveRowEdits } from './row-rules';
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
}

export interface SaveOptions extends RowEditOptions {
	applyToVariations: boolean;
	source: 'quick' | 'bulk';
	/** Trim the rows a write returns to these wc/v3 fields (a 100-row page is tens of KB instead of a megabyte). */
	fields?: string[];
	onProgress?( done: number, total: number ): void;
	/** Variations already fetched by the modal (keyed by parent id), so the save does not fetch them again. */
	prefetchedVariations?: ReadonlyMap< number, ProductListItem[] >;
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
	/** Rows written whose existing sale the edits replace. */
	replacedSales: number;
}

/** What `runSave` reports: the batch result plus what the plan left out. */
export interface SaveResult extends BatchResult {
	unchanged: number;
	stockSkipped: number;
	saleSkipped: number;
	replacedSales: number;
}

function chunk< T >( list: T[], size: number ): T[][] {
	const chunks: T[][] = [];
	const step = Math.max( 1, size );

	for ( let index = 0; index < list.length; index += step ) {
		chunks.push( list.slice( index, index + step ) );
	}

	return chunks;
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
	const plan: SavePlan = { writes: [], products: 0, variations: 0, unchanged: 0, stockSkipped: [], saleSkipped: [], replacedSales: 0 };

	for ( const target of targets ) {
		const own = resolveRowEdits( target.item, target.edits, options );

		if ( hasStockGatedEdit( target.edits ) && ! hasStockGatedEdit( own ) ) {
			plan.stockSkipped.push( target.item );
		}

		if ( hasSaleEdit( target.edits ) && ! hasSaleEdit( own ) ) {
			plan.saleSkipped.push( target.item );
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
	options: RowEditOptions & { applyToVariations: boolean; variationsByParent?: ReadonlyMap< number, ProductListItem[] > }
): SavePlan {
	const targets = resolveSaveTargetsWith( items, edits, fields, { applyToVariations: options.applyToVariations, variationsByParent: options.variationsByParent } );

	return planTargets( targets, fields, settings, options );
}

/** Prepare the per-row payloads; rows with nothing to send are left out. */
export async function prepareSave( deps: Pick< SaveDeps, 'fetchVariations' >, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: Pick< SaveOptions, 'applyToVariations' | 'prefetchedVariations' | 'enableManageStock' | 'skipExistingSales' > ): Promise< Prepared[] > {
	return ( await preparePlan( deps, items, edits, fields, settings, options ) ).writes;
}

async function preparePlan( deps: Pick< SaveDeps, 'fetchVariations' >, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: Pick< SaveOptions, 'applyToVariations' | 'prefetchedVariations' | 'enableManageStock' | 'skipExistingSales' > ): Promise< SavePlan > {
	const prefetched = options.prefetchedVariations;
	const fetchVariations: FetchVariations = ( parentId, fieldList ) => {
		const rows = prefetched?.get( parentId );

		return rows ? Promise.resolve( rows ) : deps.fetchVariations( parentId, fieldList );
	};
	const targets = await resolveSaveTargets( items, edits, fields, { applyToVariations: options.applyToVariations, fetchVariations } );

	return planTargets( targets, fields, settings, { enableManageStock: options.enableManageStock, skipExistingSales: options.skipExistingSales } );
}

export async function runSave( deps: SaveDeps, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: SaveOptions ): Promise< SaveResult > {
	const batchId = deps.newBatchId();
	const plan = await preparePlan( deps, items, edits, fields, settings, options );
	const prepared = plan.writes;
	const result: SaveResult = {
		updated: [],
		errors: [],
		batchId,
		unchanged: plan.unchanged,
		stockSkipped: plan.stockSkipped.length,
		saleSkipped: plan.saleSkipped.length,
		replacedSales: plan.replacedSales,
	};
	const total = prepared.length;
	let done = 0;

	options.onProgress?.( 0, total );

	if ( total === 0 ) {
		return result;
	}

	const requestOptions: SaveRequestOptions = { batchId, source: options.source, ...( options.fields?.length ? { fields: options.fields } : {} ) };
	const byId = new Map( prepared.map( ( entry ) => [ entry.target.item.id, entry ] ) );

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
			deps.patchItems( patches );
		}
	};

	const failGroup = ( group: Prepared[], error: unknown ): void => {
		const code = errorCode( error );
		const message = humanizeError( code, errorMessage( error ) );

		for ( const entry of group ) {
			result.errors.push( { id: entry.target.item.id, message, code } );
		}

		deps.patchItems( group.map( ( entry ) => entry.snapshot as Partial< ProductListItem > & { id: number } ) );
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
		// Grouped by parent so each request touches as few parents as possible
		// (the server syncs a parent once per request it appears in).
		const ordered = Array.from( byParent.values() ).flat();

		for ( const group of chunk( ordered, deps.variationsBatchSize ?? deps.batchSize ) ) {
			deps.patchItems( group.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

			try {
				const response = await deps.batchVariationsAcross(
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
	} else {
		for ( const [ parentId, entries ] of byParent ) {
			for ( const group of chunk( entries, deps.batchSize ) ) {
				deps.patchItems( group.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

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

	for ( const group of chunk( parents, deps.batchSize ) ) {
		deps.patchItems( group.map( ( entry ) => optimisticPatch( entry.target, entry.payload ) ) );

		try {
			const response = await deps.batchProducts( group.map( ( entry ) => ( { id: entry.target.item.id, ...entry.payload } ) ), requestOptions );

			applyResponse( group, response );
		} catch ( error ) {
			failGroup( group, error );
		}

		done += group.length;
		options.onProgress?.( done, total );
	}

	return result;
}
