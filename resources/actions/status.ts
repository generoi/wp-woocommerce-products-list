/**
 * Status changes through wc/v3 batch updates (logged by Rest\Saves), shown
 * before the request returns: publish / move to draft for products,
 * enable / disable for variations.
 *
 * Variations of any number of parents go through the cross-parent
 * `variations/batch` route in chunks of 100 (one or two requests for a
 * page of them, not one per parent); products through `products/batch`.
 * The rows a write returns are trimmed to what the list shows (`fields`),
 * as the edit modal's saves are: a status change on 100 products is tens
 * of kilobytes back, not the megabytes of full objects.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { drafts, published } from '@wordpress/icons';
import { addQueryArgs } from '@wordpress/url';
import { batchProducts, batchVariationsAcross, closeBatch, isRequestFailure, newBatchId, toRow } from '../api/client';
import type { BatchOptions, WriteSource } from '../api/client';
import { invalidateProducts, patchItems, removeItems } from '../store/products';
import { isVariation, parentIdOf } from '../edit/field-value';
import { saveFields } from '../edit/save';
import { undoBatch } from '../edit/undo';
import { canUndo } from '../edit/log-access';
import { outcomeUnknown, UNCERTAIN_CODE, uncertainMessage, withoutUntouchedImages } from '../edit/save-runner';
import { humanizeError, isConflictCode, isGoneCode } from '../edit/errors';
import { writeItem } from '../edit/expect';
import { failureMessage, failureNoticeActions, namesById, recordFailedRows } from '../edit/failed-rows';
import { hydrateSelection, withoutUnaskedIdentity } from '../edit/hydrate';
import { getSettings } from '../settings';
import { beginSaveJob, finishSaveJob, updateSaveJob } from '../store/save-activity';
import { isBatchItemError } from '../types';
import type { BatchResponse, ProductAction, ProductField, ProductListItem, ProductStatus, RawProduct, RawVariation } from '../types';
import type { ActionFactory, ProductActionsContext } from './context';
import { canEdit, errorMessage, isRealRow, realRows } from './context';
import { notify } from './notices';

type Patch = Partial< ProductListItem > & { id: number };

interface OptimisticOptions {
	/** The patch each row gets right away. */
	patch: ( item: ProductListItem ) => Patch;
	/** Refetch the page after (membership of the status tab changed). */
	refetch: boolean;
	success: ( count: number ) => string;
	/** The wc/v3 fields the returned rows are trimmed to; the field registry's row fields when given as fields. */
	fields?: string[] | ProductField[];
	/** Rows the action does not apply to are left out (a product already featured is not "marked as featured" again). */
	eligible?: ( item: ProductListItem ) => boolean;
}

function fieldList( fields: OptimisticOptions[ 'fields' ], patch: Record< string, unknown > ): string[] | undefined {
	if ( ! fields || fields.length === 0 ) {
		return undefined;
	}

	if ( typeof fields[ 0 ] === 'string' ) {
		return fields as string[];
	}

	return saveFields( fields as ProductField[], patch );
}

interface RowFailure {
	id: number;
	message: string;
	code?: string;
}

/** Whether the stored row holds every value of the patch (status / featured: plain scalars). */
function holdsPatch( row: ProductListItem, patch: Patch ): boolean {
	return Object.entries( patch ).every( ( [ key, value ] ) => key === 'id' || ( row as Record< string, unknown > )[ key ] === value );
}

/**
 * Patch now, send the batch, roll back the rows that failed. Resolves with the ids that were updated.
 *
 * It runs as a save does (docs/contracts.md §3.6): the list's save bar, row
 * locks and leave-page guard while it runs (`beginSaveJob`); every item
 * carries its expected value (`_wcpl_expect`, so a row another tab or user
 * changed meanwhile is refused with `wc_products_list_conflict`, re-read
 * and reported, never overwritten); an action of several requests sends the
 * planned header and closes its batch at the end. A request that failed
 * with an unknown outcome (offline, a 5xx) is settled by re-reading its rows:
 * the rows that hold the new value count as updated (Undo covers them), the
 * others show what is stored. Rows of the requests that went through stay updated.
 */
export async function optimisticBatch( items: ProductListItem[], options: OptimisticOptions ): Promise< number[] > {
	const rows = realRows( items ).filter( ( item ) => ! options.eligible || options.eligible( item ) );

	if ( ! rows.length ) {
		return [];
	}

	// A menu action (publish, disable variations, feature): History lists it under Actions, whatever the row count.
	const source: WriteSource = 'action';
	const okIds: number[] = [];

	const snapshots = new Map< number, Patch >();
	const patchOf = new Map< number, Patch >();
	const patches: Patch[] = [];

	for ( const item of rows ) {
		const patch = options.patch( item );
		const snapshot: Patch = { id: item.id };

		for ( const key of Object.keys( patch ) ) {
			( snapshot as Record< string, unknown > )[ key ] = ( item as Record< string, unknown > )[ key ];
		}

		snapshots.set( item.id, snapshot );
		patchOf.set( item.id, patch );
		patches.push( patch );
	}

	patchItems( patches );

	const settings = getSettings();
	const batchId = newBatchId();
	const { id: _id, ...sample } = patches[ 0 ] ?? { id: 0 };
	const fields = fieldList( options.fields, sample );
	const byRowId = new Map( rows.map( ( item ) => [ item.id, item ] ) );
	const productRows = rows.filter( ( item ) => ! isVariation( item ) );
	const variationRows = rows.filter( ( item ) => isVariation( item ) );
	const requests =
		( settings.caps.editOthers === false ? variationRows.length : Math.ceil( variationRows.length / Math.max( 1, settings.limits.actionBatchSize ) ) ) +
		Math.ceil( productRows.length / Math.max( 1, settings.limits.batchSize ) );
	// Several requests: the server keeps the batch `running` (History will not revert it half-written) until it is closed.
	const planned = requests > 1 ? rows.length : 0;
	let done = 0;
	const jobId = beginSaveJob( rows );
	const progress = ( offset: number ) => ( answered: number ) => updateSaveJob( jobId, offset + answered, rows.length );
	const requestOptions = ( offset: number ): BatchOptions => ( {
		batchId,
		source,
		...( fields ? { fields } : {} ),
		...( planned ? { planned } : {} ),
		onProgress: progress( offset ),
	} );

	updateSaveJob( jobId, 0, rows.length );

	const failed: RowFailure[] = [];
	/** Rows whose request failed with an unknown outcome: re-read before they are reported. */
	const uncertain: RowFailure[] = [];
	/** Rows refused because they changed meanwhile: re-read, so they show what is stored. */
	const conflicted: number[] = [];
	const rollback: Patch[] = [];
	let ok = 0;

	const absorb = ( response: BatchResponse< RawProduct | RawVariation >, sent: ProductListItem[] ) => {
		const seen = new Set< number >();
		const returned: Patch[] = [];

		for ( const row of response.update ?? [] ) {
			seen.add( row.id );

			if ( isBatchItemError( row ) ) {
				const { code, message } = row.error;

				if ( isRequestFailure( row.error.data ) && outcomeUnknown( { status: row.error.data.status, code } ) ) {
					uncertain.push( { id: row.id, code, message: humanizeError( code, message ) } );
					continue;
				}

				if ( isConflictCode( code ) ) {
					conflicted.push( row.id );
				}

				failed.push( { id: row.id, code, message: humanizeError( code, message ) } );
			} else {
				ok += 1;
				okIds.push( row.id );

				const item = byRowId.get( row.id );
				const parentId = item && isVariation( item ) ? parentIdOf( item ) : undefined;

				// The same normalisation as a list read (hierarchy keys, the `wcProductsList.item` filter), thumbnails kept.
				returned.push( withoutUntouchedImages( toRow( row, parentId ) as unknown as Record< string, unknown >, patchOf.get( row.id ) ?? {} ) as unknown as Patch );
			}
		}

		for ( const item of sent ) {
			if ( ! seen.has( item.id ) ) {
				failed.push( { id: item.id, message: __( 'No result returned for this item.', 'wp-woocommerce-products-list' ) } );
			}
		}

		// One patch per response, not one per row.
		if ( returned.length ) {
			patchItems( returned );
		}
	};

	const fail = ( sent: ProductListItem[], error: unknown ) => {
		const code = typeof ( error as { code?: unknown } | null )?.code === 'string' ? ( error as { code: string } ).code : undefined;
		const message = humanizeError( code, errorMessage( error ) );
		const into = outcomeUnknown( error ) ? uncertain : failed;

		sent.forEach( ( item ) => into.push( { id: item.id, message, ...( code ? { code } : {} ) } ) );
	};

	/** The request item: the patch and the value it was based on (`_wcpl_expect`). */
	const bodyOf = ( item: ProductListItem ) => {
		const { id: _patchId, ...payload } = patchOf.get( item.id ) ?? { id: item.id };

		return writeItem( item, payload );
	};

	try {
		if ( variationRows.length ) {
			try {
				absorb(
					await batchVariationsAcross(
						variationRows.map( ( item ) => ( { ...bodyOf( item ), parent_id: parentIdOf( item ) } ) ),
						requestOptions( done )
					),
					variationRows
				);
			} catch ( error ) {
				fail( variationRows, error );
			}

			done += variationRows.length;
			updateSaveJob( jobId, done, rows.length );
		}

		if ( productRows.length ) {
			try {
				absorb( await batchProducts( productRows.map( bodyOf ), requestOptions( done ) ), productRows );
			} catch ( error ) {
				fail( productRows, error );
			}

			done += productRows.length;
			updateSaveJob( jobId, done, rows.length );
		}

		failed.forEach( ( failure ) => {
			const snapshot = snapshots.get( failure.id );

			if ( snapshot ) {
				rollback.push( snapshot );
			}
		} );

		const reread = [ ...uncertain.map( ( entry ) => entry.id ), ...conflicted ];

		if ( reread.length ) {
			const keys = Array.from( new Set( [ 'id', 'date_modified_gmt', 'status', ...Object.keys( sample ) ] ) ).sort();
			let fresh: Map< number, ProductListItem > | null = null;

			try {
				const { items: read, missing } = await hydrateSelection(
					reread.map( ( id ) => byRowId.get( id ) ).filter( ( item ): item is ProductListItem => item !== undefined ),
					keys
				);
				const gone = new Set( missing );

				// Patched over the list row: only what was read, never the client's defaults for `type` and the hierarchy keys.
				fresh = new Map( read.filter( ( row ) => ! gone.has( row.id ) ).map( ( row ) => [ row.id, withoutUnaskedIdentity( row as Record< string, unknown >, keys ) as ProductListItem ] ) );
			} catch {
				fresh = null;
			}

			const current: Patch[] = [];

			for ( const entry of uncertain ) {
				const row = fresh?.get( entry.id );
				const patch = patchOf.get( entry.id );

				if ( ! fresh ) {
					// Nothing is known: the row shows what it had, and the message says it may have been saved.
					failed.push( { ...entry, message: uncertainMessage( entry.message ), code: UNCERTAIN_CODE } );
					rollback.push( snapshots.get( entry.id ) ?? { id: entry.id } );
					continue;
				}

				if ( ! row ) {
					failed.push( { id: entry.id, message: humanizeError( 'woocommerce_rest_product_invalid_id', '' ), code: 'woocommerce_rest_product_invalid_id' } );
					rollback.push( snapshots.get( entry.id ) ?? { id: entry.id } );
					continue;
				}

				current.push( { ...withoutUntouchedImages( row as Record< string, unknown >, patch ?? {} ), id: entry.id } as Patch );

				if ( patch && holdsPatch( row, patch ) ) {
					// The write went through before the answer was lost: it is in the batch, Undo covers it.
					ok += 1;
					okIds.push( entry.id );
				} else {
					failed.push( entry );
				}
			}

			for ( const id of conflicted ) {
				const row = fresh?.get( id );

				if ( row ) {
					current.push( { ...withoutUntouchedImages( row as Record< string, unknown >, patchOf.get( id ) ?? {} ), id } as Patch );
				}
			}

			// Snapshots first, then what is stored now.
			if ( rollback.length ) {
				patchItems( rollback.splice( 0 ) );
			}

			if ( current.length ) {
				patchItems( current );
			}
		}

		if ( rollback.length ) {
			patchItems( rollback );
		}
	} finally {
		if ( planned ) {
			await closeBatch( batchId );
		}

		finishSaveJob( jobId );
	}

	// Rows deleted meanwhile (another tab or user) leave the list; the server logged them as skipped.
	removeItems( failed.filter( ( failure ) => isGoneCode( failure.code ) ).map( ( failure ) => failure.id ) );

	if ( failed.length ) {
		// The rows the server has no row for (their request failed, or wc/v3 refused them) go into the batch as failed,
		// so History shows the attempt and which rows of it did not change (its own refusals it logged itself).
		recordFailedRows( batchId, source, failed, { fields: Object.keys( sample ) } );

		// Each failed row by name, with why (a clash with another tab or user first: those rows now show the other change).
		const ordered = [ ...failed.filter( ( failure ) => isConflictCode( failure.code ) ), ...failed.filter( ( failure ) => ! isConflictCode( failure.code ) ) ];

		notify.error(
			failureMessage( 'update', ordered, namesById( rows ) ),
			// As the editor's outcome notice: select the failed rows to try again, open the batch in History.
			{ id: `wc-pl-action-failed-${ batchId }`, actions: failureNoticeActions( batchId, failed ) }
		);
	}

	if ( ok ) {
		// The batch is in the change log: Undo reverts it (disable a colour's variations, feature 99 products…).
		const noticeId = `wc-pl-action-${ batchId }`;
		const history = settings.links.history ? [ { label: __( 'View in History', 'wp-woocommerce-products-list' ), url: addQueryArgs( settings.links.history, { batch: batchId } ) } ] : [];

		notify.success( options.success( ok ), {
			id: noticeId,
			// A change to many items keeps its Undo until dismissed or replaced by a newer one.
			...( ok > 1 && canUndo() ? { explicitDismiss: true } : {} ),
			actions: ! canUndo()
				? history
				: [
						{
							label: __( 'Undo', 'wp-woocommerce-products-list' ),
							onClick: () => {
								notify.remove( noticeId );
								void undoBatch( batchId );
							},
						},
						...history,
				  ],
		} );
	}

	if ( options.refetch && ok ) {
		invalidateProducts( { counts: true } );
	}

	return okIds;
}

function statusAction( context: ProductActionsContext, id: string, label: string, status: ProductStatus, eligible: ( item: ProductListItem ) => boolean, icon: unknown, success: ( count: number ) => string, refetch = true ): ProductAction {
	const isEligible = ( item: ProductListItem ) => isRealRow( item ) && canEdit( item ) && eligible( item );

	return {
		id,
		label,
		icon,
		supportsBulk: true,
		isEligible,
		callback: ( items, { onActionPerformed } ) => {
			void optimisticBatch( items, {
				patch: ( item ) => ( { id: item.id, status } ),
				// On a status tab the rows leave the page; on "all" only the counts move.
				refetch,
				success,
				fields: context.fields,
				eligible: isEligible,
			} ).then( () => {
				onActionPerformed?.( items );
			} );
		},
	};
}

export const createPublishAction: ActionFactory = ( context ) => {
	if ( ! context.settings.caps.publish ) {
		return null;
	}

	return {
		...statusAction(
			context,
			'publish',
			__( 'Publish', 'wp-woocommerce-products-list' ),
			'publish',
			( item ) => item.status !== 'publish' && item.status !== 'trash',
			published,
			/* translators: %d: number of products */
			( count ) => sprintf( _n( '%d product published.', '%d products published.', count, 'wp-woocommerce-products-list' ), count )
		),
		scope: 'product',
	};
};

export const createDraftAction: ActionFactory = ( context ) => {
	if ( ! context.settings.caps.edit ) {
		return null;
	}

	return {
		...statusAction(
			context,
			'draft',
			__( 'Move to draft', 'wp-woocommerce-products-list' ),
			'draft',
			( item ) => item.status !== 'draft' && item.status !== 'trash',
			drafts,
			/* translators: %d: number of products */
			( count ) => sprintf( _n( '%d product moved to draft.', '%d products moved to draft.', count, 'wp-woocommerce-products-list' ), count )
		),
		scope: 'product',
	};
};

/** Variations: Active (publish) / Inactive (private). */
export const createEnableVariationAction: ActionFactory = ( context ) => {
	if ( ! context.settings.caps.edit ) {
		return null;
	}

	return {
		...statusAction(
			context,
			'enable',
			__( 'Enable', 'wp-woocommerce-products-list' ),
			'publish',
			( item ) => item.status === 'private',
			published,
			/* translators: %d: number of variations */
			( count ) => sprintf( _n( '%d variation enabled.', '%d variations enabled.', count, 'wp-woocommerce-products-list' ), count ),
			false
		),
		scope: 'variation',
	};
};

export const createDisableVariationAction: ActionFactory = ( context ) => {
	if ( ! context.settings.caps.edit ) {
		return null;
	}

	return {
		...statusAction(
			context,
			'disable',
			__( 'Disable', 'wp-woocommerce-products-list' ),
			'private',
			( item ) => item.status !== 'private',
			drafts,
			/* translators: %d: number of variations */
			( count ) => sprintf( _n( '%d variation disabled.', '%d variations disabled.', count, 'wp-woocommerce-products-list' ), count ),
			false
		),
		scope: 'variation',
	};
};
