import { dispatch } from '@wordpress/data';
import domReady from '@wordpress/dom-ready';
import { createRoot } from '@wordpress/element';
import { installGlobalErrorReporting } from './api/report-error';
import { App } from './app';
import { createExtensionApi } from './extensions/api';
import { runBatchUpdate } from './extensions/batch-update';
import type { BatchUpdateOptions } from './extensions/batch-update';
import { getSettings } from './settings';
import { cache } from './store/query-cache';
import { COUNTS_KEY, invalidateProducts, patchItems, PRODUCTS_PREFIX, VARIATIONS_PREFIX } from './store/products';
import { getCurrentRows } from './store/rows';
import type { BatchResult, BatchUpdate } from './types';
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
 * Save through the same runner as bulk edit (extensions/batch-update.ts):
 * the list's indicator, row locks and leave guard while it runs, expected
 * values from the loaded rows, the planned header and the failed rows
 * recorded in History.
 */
function batchUpdate( update: BatchUpdate, options: BatchUpdateOptions = {} ): Promise< BatchResult > {
	return runBatchUpdate( update, options );
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
