import { dispatch } from '@wordpress/data';
import domReady from '@wordpress/dom-ready';
import { createRoot } from '@wordpress/element';
import { doAction } from '@wordpress/hooks';
import { batchProducts, batchVariationsAcross, newBatchId, toRow } from './api/client';
import { installGlobalErrorReporting } from './api/report-error';
import { App } from './app';
import { createExtensionApi } from './extensions/api';
import { ACTIONS } from './extensions/hooks';
import { getSettings } from './settings';
import { cache } from './store/query-cache';
import { COUNTS_KEY, invalidateProducts, patchItems, PRODUCTS_PREFIX, VARIATIONS_PREFIX } from './store/products';
import { getCurrentRows } from './store/rows';
import type { BatchItemError, BatchResult, BatchUpdate, ProductListItem } from './types';
import { isBatchItemError } from './types';
import { createNoticesApi } from './ui/use-notices';
import './style.scss';

/**
 * Boot order (docs/contracts.md §7): the extension API exists and
 * `wcProductsList.ready` has fired before the app mounts, so extension
 * scripts enqueued with the `wc-products-list` dependency can register
 * fields and actions first.
 */

/** Refetch what is on screen; resolves once the rows are back. */
async function refresh( options: { counts?: boolean } = {} ): Promise< void > {
	invalidateProducts( { counts: options.counts } );
	const keys = [ ...cache.keys( PRODUCTS_PREFIX ), ...cache.keys( VARIATIONS_PREFIX ), ...( options.counts ? [ COUNTS_KEY ] : [] ) ];

	await Promise.all(
		keys.map( ( key ) => {
			const entry = cache.get( key );

			return entry?.isFetching ? new Promise< void >( ( resolve ) => {
				const unsubscribe = cache.subscribe( key, () => {
					if ( ! cache.get( key )?.isFetching ) {
						unsubscribe();
						resolve();
					}
				} );
			} ) : Promise.resolve();
		} )
	);
}

/**
 * Save through the same path as bulk edit: variations first (one request
 * per parent), then parents, all under one batch id. edit/save.ts builds
 * on the same client calls with validation and progress on top.
 */
async function batchUpdate( update: BatchUpdate, options: { source?: string } = {} ): Promise< BatchResult > {
	const batchId = newBatchId();
	const source = ( options.source === 'bulk' || options.source === 'extension' ? options.source : 'quick' ) as 'quick' | 'bulk' | 'extension';
	const result: BatchResult = { updated: [], errors: [], batchId };
	const collect = ( rows: Array< ProductListItem | BatchItemError > ) => {
		for ( const row of rows ) {
			if ( isBatchItemError( row ) ) {
				result.errors.push( { id: row.id, message: row.error.message, code: row.error.code } );
			} else {
				result.updated.push( row );
			}
		}
	};

	try {
		// Every variation of every parent in one cross-parent request per 100 rows.
		const variationRows = Object.entries( update.variations ?? {} ).flatMap( ( [ parentId, rows ] ) => rows.map( ( row ) => ( { ...row, parent_id: Number( parentId ) } ) ) );

		if ( variationRows.length ) {
			const parentOf = new Map( variationRows.map( ( row ) => [ row.id, row.parent_id ] ) );
			const response = await batchVariationsAcross( variationRows, { batchId, source } );

			collect( ( response.update ?? [] ).map( ( row ) => ( isBatchItemError( row ) ? row : toRow( row, parentOf.get( row.id ) ) ) ) );
		}

		if ( update.products?.length ) {
			const response = await batchProducts( update.products, { batchId, source } );
			collect( ( response.update ?? [] ).map( ( row ) => ( isBatchItemError( row ) ? row : toRow( row ) ) ) );
		}
	} catch ( error ) {
		const message = error instanceof Error ? error.message : String( error );
		const pending = [ ...( update.products ?? [] ), ...Object.values( update.variations ?? {} ).flat() ].filter( ( row ) => ! result.updated.some( ( u ) => u.id === row.id ) );
		pending.forEach( ( row ) => result.errors.push( { id: row.id, message } ) );
	}

	if ( result.updated.length ) {
		patchItems( result.updated );
	}

	doAction( ACTIONS.saved, result, { source } );

	return result;
}

// createExtensionApi() assigns window.wcProductsList and fires
// `wcProductsList.ready` itself, once.
createExtensionApi( {
	settings: getSettings(),
	refresh,
	patchItems,
	batchUpdate,
	notices: createNoticesApi( dispatch ),
	getItems: getCurrentRows,
} );

installGlobalErrorReporting();

domReady( () => {
	const root = document.getElementById( 'wc-products-list-root' );

	if ( ! root ) {
		return;
	}

	createRoot( root ).render( <App /> );
} );
