/**
 * `saveEdits`: the contracted entry point, wiring the REST client, the
 * product cache and the settings into the save runner.
 */
import { doAction } from '@wordpress/hooks';
import { batchProducts, batchVariations, getVariations, newBatchId } from '../api/client';
import { ACTIONS } from '../extensions/hooks';
import { getSettings } from '../settings';
import { invalidateProducts, patchItems } from '../store/products';
import type { BatchResult, ProductField, ProductListItem } from '../types';
import { fetchAllVariations } from './apply-to-variations';
import type { SaveDeps, SaveOptions } from './save-runner';
import { runSave } from './save-runner';

export type { SaveOptions } from './save-runner';

function realDeps(): SaveDeps {
	const settings = getSettings();

	return {
		batchProducts: ( update, options ) => batchProducts( update, options ),
		batchVariations: ( parentId, update, options ) => batchVariations( parentId, update, options ),
		fetchVariations: ( parentId, fields ) =>
			fetchAllVariations( parentId, fields, ( id, page, fieldList ) => getVariations( id, page, { perPage: settings.limits.perPageMax, fields: fieldList } ) ),
		patchItems,
		newBatchId,
		batchSize: settings.limits.batchSize,
	};
}

/** Whether an edit changes which status tab the rows belong to. */
function changesStatus( edits: Record< string, unknown > ): boolean {
	return edits.status !== undefined;
}

export async function saveEdits( items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], options: SaveOptions ): Promise< BatchResult > {
	const result = await runSave( realDeps(), items, edits, fields, getSettings(), options );

	if ( result.updated.length > 0 && changesStatus( edits ) ) {
		invalidateProducts( { counts: true } );
	}

	doAction( ACTIONS.saved, result, { source: options.source } );

	return result;
}
