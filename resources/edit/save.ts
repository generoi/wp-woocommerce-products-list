/**
 * `saveEdits`: the contracted entry point, wiring the REST client, the
 * product cache and the settings into the save runner.
 */
import { doAction } from '@wordpress/hooks';
import { rowFields } from '../actions/context';
import { batchProducts, batchVariations, batchVariationsAcross, closeBatch, getVariations, newBatchId, toRow } from '../api/client';
import { ACTIONS } from '../extensions/hooks';
import { getSettings } from '../settings';
import { invalidateProducts, patchItems } from '../store/products';
import { beginSaveJob, finishSaveJob, markRowsSaved, updateSaveJob } from '../store/save-activity';
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
		// The written rows are released once every chunk is back (the runner reports them when the save ends).
		rowsWritten: ( ids ) => {
			if ( jobId !== undefined ) {
				markRowsSaved( jobId, ids );
			}
		},
		newBatchId,
		// The batch of a save of several requests stays `running` on the server until this (before the snackbar offers Undo).
		closeBatch,
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

export interface SaveEditsOptions extends SaveOptions {
	/** A job from `beginSaveJob`: the save reports to it and leaves finishing it to the caller. */
	saveJob?: number;
}

export async function saveEdits( items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], options: SaveEditsOptions ): Promise< SaveResult > {
	// The rows a write returns are trimmed to what the list shows plus what
	// was edited, never the full wc/v3 object (PHP Rows::trimBatchItem).
	// The list shows this save's progress and locks its rows until the save ends, also once the panel is closed.
	const { saveJob, ...saveOptions } = options;
	const jobId = saveJob ?? beginSaveJob( items );
	let result: SaveResult;

	try {
		result = await runSave( realDeps( jobId ), items, edits, fields, getSettings(), {
			fields: saveFields( fields, edits ),
			...saveOptions,
			onProgress: ( done, total ) => {
				updateSaveJob( jobId, done, total );
				saveOptions.onProgress?.( done, total );
			},
		} );
	} finally {
		if ( saveJob === undefined ) {
			finishSaveJob( jobId );
		}
	}

	if ( result.updated.length > 0 && changesStatus( edits ) ) {
		invalidateProducts( { counts: true } );
	}

	doAction( ACTIONS.saved, result, { source: options.source } );

	return result;
}
