/**
 * `saveEdits`: the contracted entry point, wiring the REST client, the
 * product cache and the settings into the save runner.
 */
import { doAction } from '@wordpress/hooks';
import { rowFields } from '../actions/context';
import { batchProducts, batchVariations, batchVariationsAcross, getVariations, newBatchId, toRow } from '../api/client';
import { ACTIONS } from '../extensions/hooks';
import { getSettings } from '../settings';
import { invalidateProducts, patchItems } from '../store/products';
import { finishSaveJob, markRowsSaved, startSaveJob, updateSaveJob } from '../store/save-activity';
import { getVisibleFieldIds } from '../store/rows';
import type { ProductField, ProductListItem } from '../types';
import { fetchAllVariations } from './apply-to-variations';
import { hydrateSelection } from './hydrate';
import type { SaveDeps, SaveOptions, SaveResult } from './save-runner';
import { runSave } from './save-runner';

export type { SaveOptions, SaveResult } from './save-runner';

function realDeps( jobId?: number ): SaveDeps {
	const settings = getSettings();

	return {
		batchProducts: ( update, options ) => batchProducts( update, options ),
		batchVariations: ( parentId, update, options ) => batchVariations( parentId, update, options ),
		batchVariationsAcross: ( update, options ) => batchVariationsAcross( update, options ),
		variationsBatchSize: settings.limits.actionBatchSize,
		fetchVariations: ( parentId, fields ) =>
			fetchAllVariations( parentId, fields, ( id, page, fieldList ) => getVariations( id, page, { perPage: settings.limits.perPageMax, fields: fieldList } ) ),
		patchItems,
		// Every written row is editable again in the list as soon as its chunk is back.
		rowsWritten: ( ids ) => {
			if ( jobId !== undefined ) {
				markRowsSaved( jobId, ids );
			}
		},
		newBatchId,
		batchSize: settings.limits.batchSize,
		normalizeRow: toRow,
		// After a request failed with an unknown outcome: what the rows hold now (by id; deleted rows absent).
		rereadRows: async ( items, fields ) => {
			const { items: rows, missing } = await hydrateSelection( items, fields );
			const gone = new Set( missing );

			return new Map( rows.filter( ( row ) => ! gone.has( row.id ) ).map( ( row ) => [ row.id, row ] ) );
		},
	};
}

/** Whether an edit changes which status tab the rows belong to. */
function changesStatus( edits: Record< string, unknown > ): boolean {
	return edits.status !== undefined;
}

/**
 * The wc/v3 keys a save asks back: the base row keys, the visible columns'
 * fields and the fields of the edited keys. The server trims each returned
 * row to them and builds nothing else (every batch sub-request gets the
 * list as its `_fields`): a status change on 100 variable products returns
 * no price ranges, galleries or translations. Every registered field when
 * no view is on screen (the extension API's `batchUpdate` outside the list).
 */
export function saveFields( fields: ProductField[], edits: Record< string, unknown >, visibleIds: string[] = getVisibleFieldIds() ): string[] {
	if ( visibleIds.length === 0 ) {
		return rowFields( fields );
	}

	const wanted = new Set( visibleIds );

	for ( const id of Object.keys( edits ) ) {
		// A bulk list op ('categories__op') and the schedule toggle name their field.
		wanted.add( id.replace( /__op$/, '' ) );
		wanted.add( id.split( '.' )[ 0 ] ?? id );
	}

	return rowFields( fields.filter( ( field ) => wanted.has( field.id ) ) );
}

export async function saveEdits( items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], options: SaveOptions ): Promise< SaveResult > {
	// The rows a write returns are trimmed to what the list shows plus what
	// was edited, never the full wc/v3 object (PHP Rows::trimBatchItem).
	// The list shows this save's progress and locks the rows it has not written yet, also once the panel is closed.
	// A variable parent stays locked until the whole save is done (its variations are written chunk by chunk).
	const pending = new Set< number >();

	items.forEach( ( item ) => {
		pending.add( item.id );

		if ( item.parent_id ) {
			pending.add( item.parent_id );
		}
	} );
	const jobId = startSaveJob( pending );
	let result: SaveResult;

	try {
		result = await runSave( realDeps( jobId ), items, edits, fields, getSettings(), {
			fields: saveFields( fields, edits ),
			...options,
			onProgress: ( done, total ) => {
				updateSaveJob( jobId, done, total );
				options.onProgress?.( done, total );
			},
		} );
	} finally {
		finishSaveJob( jobId );
	}

	if ( result.updated.length > 0 && changesStatus( edits ) ) {
		invalidateProducts( { counts: true } );
	}

	doAction( ACTIONS.saved, result, { source: options.source } );

	return result;
}
