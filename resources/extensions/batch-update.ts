/**
 * `window.wcProductsList.batchUpdate()`: an extension's write, run as the
 * list's own bulk saves run (docs/contracts.md §3.6, docs/extension-api.md):
 *
 * - a save-activity job: the list's bar, its rows locked, the leave-page
 *   guard, until every request is back (`beginSaveJob`);
 * - rows a save of this tab still holds are not sent (`wc_products_list_locked`,
 *   recorded as `skipped`, reason `locked`), as Undo refuses them;
 * - each item carries `_wcpl_expect`: the values of the row as the list
 *   loaded it (`writeItem()`, registered fields' `rest.expect` included),
 *   with the item's own `_wcpl_expect` on top (an extension that read the
 *   row itself passes what it read). A row changed meanwhile by another
 *   tab, user or writer is refused with 409 `wc_products_list_conflict`
 *   (its `data` has the values now), never overwritten. `{ expect: false }`
 *   sends only the item's own values (a deliberate overwrite);
 * - a write of several rows sends the planned header and closes its batch
 *   at the end, so History never reverts it half-written;
 * - rows that failed without a row on the server are posted as `failed`.
 */
import { doAction } from '@wordpress/hooks';
import { __ } from '@wordpress/i18n';
import { batchProducts, batchVariationsAcross, closeBatch, logSkipped, newBatchId, toRow } from '../api/client';
import type { BatchOptions, WriteSource } from '../api/client';
import { isServerLoggedItemError, lockedMessage } from '../edit/errors';
import { EXPECT_KEY, expectedValues } from '../edit/expect';
import { recordFailedRows } from '../edit/failed-rows';
import { findCachedRow, patchItems } from '../store/products';
import { beginSaveJob, finishSaveJob, isRowPending, updateSaveJob } from '../store/save-activity';
import type { BatchItemError, BatchResult, BatchUpdate, ProductListItem } from '../types';
import { isBatchItemError } from '../types';
import { ACTIONS } from './hooks';

export interface BatchUpdateOptions {
	/** `bulk` or `extension` (History's source); `quick` otherwise. */
	source?: string;
	/** False: no expected values from the loaded rows, only the ones an item passes itself as `_wcpl_expect`. */
	expect?: boolean;
}

export interface BatchUpdateDeps {
	batchProducts: typeof batchProducts;
	batchVariationsAcross: typeof batchVariationsAcross;
	closeBatch: typeof closeBatch;
	logSkipped: typeof logSkipped;
	findRow: ( id: number ) => ProductListItem | undefined;
	patchItems: typeof patchItems;
}

const DEFAULT_DEPS: BatchUpdateDeps = { batchProducts, batchVariationsAcross, closeBatch, logSkipped, findRow: findCachedRow, patchItems };

type Body = { id: number } & Record< string, unknown >;

/** The request item: the row's payload and its expected values (loaded row's, then the item's own). */
export function requestItem( row: Body, findRow: BatchUpdateDeps[ 'findRow' ], derive: boolean ): Body {
	const { [ EXPECT_KEY ]: given, parent_id: _parentId, ...rest } = row;
	const { id: _id, ...payload } = rest;
	const loaded = derive ? findRow( row.id ) : undefined;
	const expect = {
		...( loaded ? expectedValues( loaded, payload ) ?? {} : {} ),
		...( typeof given === 'object' && given !== null && ! Array.isArray( given ) ? ( given as Record< string, unknown > ) : {} ),
	};

	return { ...rest, id: row.id, ...( Object.keys( expect ).length ? { [ EXPECT_KEY ]: expect } : {} ) };
}

export async function runBatchUpdate( update: BatchUpdate, options: BatchUpdateOptions = {}, deps: BatchUpdateDeps = DEFAULT_DEPS ): Promise< BatchResult > {
	const batchId = newBatchId();
	const source: WriteSource = options.source === 'bulk' || options.source === 'extension' ? options.source : 'quick';
	const result: BatchResult = { updated: [], errors: [], batchId };
	const derive = options.expect !== false;
	const variationRows = Object.entries( update.variations ?? {} ).flatMap( ( [ parentId, rows ] ) => ( rows ?? [] ).map( ( row ) => ( { ...( row as Body ), parent_id: Number( parentId ) } ) ) );
	const productRows = ( update.products ?? [] ).map( ( row ) => ( { ...( row as Body ), parent_id: 0 } ) );
	// A save of this tab still writes these rows: not sent, never interleaved with it (Undo refuses them the same way).
	const busy = [ ...variationRows, ...productRows ].filter( ( row ) => isRowPending( row.id ) || isRowPending( row.parent_id ) );
	const busyIds = new Set( busy.map( ( row ) => row.id ) );
	const variations = variationRows.filter( ( row ) => ! busyIds.has( row.id ) );
	const products = productRows.filter( ( row ) => ! busyIds.has( row.id ) );
	const total = variations.length + products.length;

	for ( const row of busy ) {
		result.errors.push( { id: row.id, message: lockedMessage(), code: 'wc_products_list_locked' } );
	}

	if ( busy.length ) {
		void deps.logSkipped( batchId, source, busy.map( ( row ) => ( { id: row.id, reason: 'locked' as const, message: lockedMessage() } ) ) );
	}

	if ( ! total ) {
		doAction( ACTIONS.saved, result, { source } );

		return result;
	}

	const collect = ( rows: Array< ProductListItem | BatchItemError > ) => {
		for ( const row of rows ) {
			if ( isBatchItemError( row ) ) {
				const data = typeof row.error.data === 'object' && row.error.data !== null ? ( row.error.data as Record< string, unknown > ) : undefined;

				result.errors.push( { id: row.id, message: row.error.message, code: row.error.code, ...( data ? { data } : {} ), ...( isServerLoggedItemError( row.error.code, row.error.data ) ? { logged: true } : {} ) } );
			} else {
				result.updated.push( row );
			}
		}
	};
	// Several rows: the server keeps the batch `running` until it is closed (History will not revert it half-written).
	const planned = total > 1 ? total : 0;
	const jobId = beginSaveJob( [ ...variations, ...products ] );
	let done = 0;
	const requestOptions = ( offset: number ): BatchOptions => ( {
		batchId,
		source,
		...( planned ? { planned } : {} ),
		onProgress: ( answered: number ) => updateSaveJob( jobId, offset + answered, total ),
	} );
	const failAll = ( rows: Body[], error: unknown ) => {
		const message = error instanceof Error ? error.message : String( ( error as { message?: unknown } | null )?.message ?? error );
		const code = typeof ( error as { code?: unknown } | null )?.code === 'string' ? ( error as { code: string } ).code : 'request_failed';

		rows.forEach( ( row ) => result.errors.push( { id: row.id, message, code } ) );
	};

	updateSaveJob( jobId, 0, total );

	try {
		if ( variations.length ) {
			const parentOf = new Map( variations.map( ( row ) => [ row.id, row.parent_id ] ) );

			try {
				const response = await deps.batchVariationsAcross(
					variations.map( ( row ) => ( { ...requestItem( row, deps.findRow, derive ), parent_id: row.parent_id } ) ),
					requestOptions( done )
				);

				collect( ( response.update ?? [] ).map( ( row ) => ( isBatchItemError( row ) ? row : toRow( row, parentOf.get( row.id ) ) ) ) );
			} catch ( error ) {
				failAll( variations, error );
			}

			done += variations.length;
			updateSaveJob( jobId, done, total );
		}

		if ( products.length ) {
			try {
				const response = await deps.batchProducts(
					products.map( ( row ) => requestItem( row, deps.findRow, derive ) ),
					requestOptions( done )
				);

				collect( ( response.update ?? [] ).map( ( row ) => ( isBatchItemError( row ) ? row : toRow( row ) ) ) );
			} catch ( error ) {
				failAll( products, error );
			}

			done += products.length;
			updateSaveJob( jobId, done, total );
		}
	} finally {
		if ( planned ) {
			await deps.closeBatch( batchId );
		}

		finishSaveJob( jobId );
	}

	// Rows sent but missing from the answers count as failed too.
	const answered = new Set( [ ...result.updated.map( ( row ) => row.id ), ...result.errors.map( ( error ) => error.id ) ] );

	for ( const row of [ ...variations, ...products ] ) {
		if ( ! answered.has( row.id ) ) {
			result.errors.push( { id: row.id, message: __( 'No result returned for this item.', 'wp-woocommerce-products-list' ), code: 'missing_result' } );
		}
	}

	// The rows the server has no row for (their request failed, or wc/v3 refused them); its own refusals it logged itself.
	recordFailedRows(
		batchId,
		source,
		result.errors.filter( ( error ) => ! busyIds.has( error.id ) ),
		{ post: deps.logSkipped }
	);

	if ( result.updated.length ) {
		deps.patchItems( result.updated );
	}

	doAction( ACTIONS.saved, result, { source } );

	return result;
}
