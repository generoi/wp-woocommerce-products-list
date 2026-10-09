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
import { batchProducts, batchVariationsAcross, newBatchId, toRow } from '../api/client';
import type { BatchOptions, WriteSource } from '../api/client';
import { invalidateProducts, patchItems } from '../store/products';
import { isVariation, parentIdOf } from '../edit/field-value';
import { saveFields } from '../edit/save';
import { undoBatch } from '../edit/undo';
import { canUndo } from '../edit/log-access';
import { withoutUntouchedImages } from '../edit/save-runner';
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

/** Patch now, send the batch, roll back the rows that failed. Resolves with the ids that were updated. */
export async function optimisticBatch( items: ProductListItem[], options: OptimisticOptions ): Promise< number[] > {
	const rows = realRows( items ).filter( ( item ) => ! options.eligible || options.eligible( item ) );

	if ( ! rows.length ) {
		return [];
	}

	// A menu action (publish, disable variations, feature): History lists it under Actions, whatever the row count.
	const source: WriteSource = 'action';
	const okIds: number[] = [];

	const snapshots = new Map< number, Patch >();
	const patches: Patch[] = [];

	for ( const item of rows ) {
		const patch = options.patch( item );
		const snapshot: Patch = { id: item.id };

		for ( const key of Object.keys( patch ) ) {
			( snapshot as Record< string, unknown > )[ key ] = ( item as Record< string, unknown > )[ key ];
		}

		snapshots.set( item.id, snapshot );
		patches.push( patch );
	}

	patchItems( patches );

	const batchId = newBatchId();
	const { id: _id, ...sample } = patches[ 0 ] ?? { id: 0 };
	const fields = fieldList( options.fields, sample );
	const requestOptions: BatchOptions = { batchId, source, ...( fields ? { fields } : {} ) };
	const byRowId = new Map( rows.map( ( item ) => [ item.id, item ] ) );
	const products = patches.filter( ( patch ) => {
		const item = byRowId.get( patch.id );

		return ! item || ! isVariation( item );
	} );
	const variations = patches.filter( ( patch ) => ! products.includes( patch ) );

	const failed: Array< { id: number; message: string } > = [];
	let ok = 0;

	const absorb = ( response: BatchResponse< RawProduct | RawVariation >, sent: Patch[] ) => {
		const seen = new Set< number >();
		const returned: Patch[] = [];

		for ( const row of response.update ?? [] ) {
			seen.add( row.id );

			if ( isBatchItemError( row ) ) {
				failed.push( { id: row.id, message: row.error.message } );
			} else {
				ok += 1;
				okIds.push( row.id );

				const item = byRowId.get( row.id );
				const parentId = item && isVariation( item ) ? parentIdOf( item ) : undefined;

				// The same normalisation as a list read (hierarchy keys, the `wcProductsList.item` filter), thumbnails kept.
				returned.push( withoutUntouchedImages( toRow( row, parentId ) as unknown as Record< string, unknown >, sent.find( ( patch ) => patch.id === row.id ) ?? {} ) as unknown as Patch );
			}
		}

		for ( const patch of sent ) {
			if ( ! seen.has( patch.id ) ) {
				failed.push( { id: patch.id, message: __( 'No result returned for this item.', 'wp-woocommerce-products-list' ) } );
			}
		}

		// One patch per response, not one per row.
		if ( returned.length ) {
			patchItems( returned );
		}
	};

	const fail = ( sent: Patch[], error: unknown ) => {
		const message = errorMessage( error );

		sent.forEach( ( patch ) => failed.push( { id: patch.id, message } ) );
	};

	if ( variations.length ) {
		try {
			absorb(
				await batchVariationsAcross(
					variations.map( ( patch ) => {
						const item = byRowId.get( patch.id );

						return { ...patch, parent_id: item ? parentIdOf( item ) : 0 };
					} ),
					requestOptions
				),
				variations
			);
		} catch ( error ) {
			fail( variations, error );
		}
	}

	if ( products.length ) {
		try {
			absorb( await batchProducts( products, requestOptions ), products );
		} catch ( error ) {
			fail( products, error );
		}
	}

	if ( failed.length ) {
		patchItems( failed.map( ( failure ) => snapshots.get( failure.id ) ).filter( ( snapshot ): snapshot is Patch => snapshot !== undefined ) );
		notify.error(
			sprintf(
				/* translators: 1: number of rows that failed, 2: the first error message */
				_n( '%1$d item could not be updated: %2$s', '%1$d items could not be updated: %2$s', failed.length, 'wp-woocommerce-products-list' ),
				failed.length,
				failed[ 0 ]?.message ?? ''
			)
		);
	}

	if ( ok ) {
		// The batch is in the change log: Undo reverts it (disable a colour's variations, feature 99 products…).
		const noticeId = `wc-pl-action-${ batchId }`;

		notify.success( options.success( ok ), {
			id: noticeId,
			actions: ! canUndo() ? [] : [
				{
					label: __( 'Undo', 'wp-woocommerce-products-list' ),
					onClick: () => {
						notify.remove( noticeId );
						void undoBatch( batchId );
					},
				},
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
