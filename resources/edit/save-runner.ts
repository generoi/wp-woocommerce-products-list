/**
 * The save orchestration with its I/O injected, so it is unit-testable
 * without the REST client or the cache. save.ts wires the real ones in.
 *
 * Order: variations first (one `variations/batch` per parent, parents in
 * sequence, chunks of `batchSize`), then parents (`products/batch`, chunked).
 * Rows are patched optimistically before each request and replaced by the
 * returned objects after; failed rows roll back and are reported per id.
 */
import type { BatchItemError, BatchResponse, BatchResult, ProductField, ProductListItem, RawProduct, RawVariation, Settings } from '../types';
import { isBatchItemError } from '../types';
import type { FetchVariations } from './apply-to-variations';
import { resolveSaveTargets } from './apply-to-variations';
import type { SaveTarget } from './apply-to-variations';
import { isVariation, parentIdOf } from './field-value';
import { buildPayload, hasPayload } from './payload';

export interface SaveDeps {
	batchProducts( update: Array< { id: number } & Record< string, unknown > >, options: { batchId: string; source: 'quick' | 'bulk' } ): Promise< BatchResponse< RawProduct > >;
	batchVariations( parentId: number, update: Array< { id: number } & Record< string, unknown > >, options: { batchId: string; source: 'quick' | 'bulk' } ): Promise< BatchResponse< RawVariation > >;
	fetchVariations: FetchVariations;
	patchItems( items: Array< Partial< ProductListItem > & { id: number } > ): void;
	newBatchId(): string;
	batchSize: number;
}

export interface SaveOptions {
	applyToVariations: boolean;
	source: 'quick' | 'bulk';
	onProgress?( done: number, total: number ): void;
	/** Variations already fetched by the modal (keyed by parent id), so the save does not fetch them again. */
	prefetchedVariations?: ReadonlyMap< number, ProductListItem[] >;
}

interface Prepared {
	target: SaveTarget;
	payload: Record< string, unknown >;
	/** The row's values for the payload's top-level keys, to roll back to. */
	snapshot: Record< string, unknown >;
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

/** Prepare the per-row payloads; rows with nothing to send are left out. */
export async function prepareSave( deps: Pick< SaveDeps, 'fetchVariations' >, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: Pick< SaveOptions, 'applyToVariations' | 'prefetchedVariations' > ): Promise< Prepared[] > {
	const prefetched = options.prefetchedVariations;
	const fetchVariations: FetchVariations = ( parentId, fieldList ) => {
		const rows = prefetched?.get( parentId );

		return rows ? Promise.resolve( rows ) : deps.fetchVariations( parentId, fieldList );
	};
	const targets = await resolveSaveTargets( items, edits, fields, { applyToVariations: options.applyToVariations, fetchVariations } );

	return targets
		.map( ( target ) => {
			const payload = buildPayload( target.item, target.edits, fields, settings );
			const patch = optimisticPatch( target, payload );

			return { target, payload, snapshot: snapshotOf( target, patch ) };
		} )
		.filter( ( prepared ) => hasPayload( prepared.payload ) );
}

export async function runSave( deps: SaveDeps, items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: SaveOptions ): Promise< BatchResult > {
	const batchId = deps.newBatchId();
	const prepared = await prepareSave( deps, items, edits, fields, settings, options );
	const result: BatchResult = { updated: [], errors: [], batchId };
	const total = prepared.length;
	let done = 0;

	options.onProgress?.( 0, total );

	if ( total === 0 ) {
		return result;
	}

	const requestOptions = { batchId, source: options.source };
	const byId = new Map( prepared.map( ( entry ) => [ entry.target.item.id, entry ] ) );

	const applyResponse = ( group: Prepared[], response: BatchResponse< RawProduct | RawVariation > ): void => {
		const seen = new Set< number >();

		for ( const entry of response.update ?? [] ) {
			if ( isBatchItemError( entry ) ) {
				const failed = entry as BatchItemError;
				const original = byId.get( failed.id );

				seen.add( failed.id );
				result.errors.push( { id: failed.id, message: failed.error.message, code: failed.error.code } );

				if ( original ) {
					deps.patchItems( [ original.snapshot as Partial< ProductListItem > & { id: number } ] );
				}

				continue;
			}

			seen.add( entry.id );
			deps.patchItems( [ entry as Partial< ProductListItem > & { id: number } ] );

			const original = byId.get( entry.id );

			result.updated.push( { ...( original?.target.item ?? {} ), ...entry } as ProductListItem );
		}

		for ( const entry of group ) {
			if ( ! seen.has( entry.target.item.id ) ) {
				result.errors.push( { id: entry.target.item.id, message: 'No result returned for this item.', code: 'missing_result' } );
				deps.patchItems( [ entry.snapshot as Partial< ProductListItem > & { id: number } ] );
			}
		}
	};

	const failGroup = ( group: Prepared[], error: unknown ): void => {
		const message = errorMessage( error );
		const code = errorCode( error );

		for ( const entry of group ) {
			result.errors.push( { id: entry.target.item.id, message, code } );
			deps.patchItems( [ entry.snapshot as Partial< ProductListItem > & { id: number } ] );
		}
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
