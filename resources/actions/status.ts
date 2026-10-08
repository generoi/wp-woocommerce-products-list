/**
 * Status changes through wc/v3 batch updates (logged by Rest\Saves), shown
 * before the request returns: publish / move to draft for products,
 * enable / disable for variations.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { drafts, published } from '@wordpress/icons';
import { batchProducts, batchVariations, newBatchId } from '../api/client';
import { invalidateProducts, patchItems } from '../store/products';
import { isVariation, parentIdOf } from '../edit/field-value';
import { isBatchItemError } from '../types';
import type { BatchResponse, ProductAction, ProductListItem, ProductStatus, RawProduct, RawVariation } from '../types';
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
}

/** Patch now, send the batch, roll back the rows that failed. */
export async function optimisticBatch( items: ProductListItem[], options: OptimisticOptions ): Promise< void > {
	const rows = realRows( items );

	if ( ! rows.length ) {
		return;
	}

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
	const byRowId = new Map( rows.map( ( item ) => [ item.id, item ] ) );
	const products = patches.filter( ( patch ) => {
		const item = byRowId.get( patch.id );

		return ! item || ! isVariation( item );
	} );
	const variations = patches.filter( ( patch ) => ! products.includes( patch ) );
	const byParent = new Map< number, Patch[] >();

	for ( const patch of variations ) {
		const item = byRowId.get( patch.id );
		const parentId = item ? parentIdOf( item ) : 0;

		byParent.set( parentId, [ ...( byParent.get( parentId ) ?? [] ), patch ] );
	}

	const failed: Array< { id: number; message: string } > = [];
	let ok = 0;

	const absorb = ( response: BatchResponse< RawProduct | RawVariation >, sent: Patch[] ) => {
		const seen = new Set< number >();

		for ( const row of response.update ?? [] ) {
			seen.add( row.id );

			if ( isBatchItemError( row ) ) {
				failed.push( { id: row.id, message: row.error.message } );
			} else {
				ok += 1;
				patchItems( [ row as Patch ] );
			}
		}

		for ( const patch of sent ) {
			if ( ! seen.has( patch.id ) ) {
				failed.push( { id: patch.id, message: __( 'No result returned for this item.', 'wp-woocommerce-products-list' ) } );
			}
		}
	};

	const fail = ( sent: Patch[], error: unknown ) => {
		const message = errorMessage( error );

		sent.forEach( ( patch ) => failed.push( { id: patch.id, message } ) );
	};

	for ( const [ parentId, sent ] of byParent ) {
		try {
			absorb( await batchVariations( parentId, sent, { batchId, source: 'quick' } ), sent );
		} catch ( error ) {
			fail( sent, error );
		}
	}

	if ( products.length ) {
		try {
			absorb( await batchProducts( products, { batchId, source: 'quick' } ), products );
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
		notify.success( options.success( ok ) );
	}

	if ( options.refetch && ok ) {
		invalidateProducts( { counts: true } );
	}
}

function statusAction( context: ProductActionsContext, id: string, label: string, status: ProductStatus, eligible: ( item: ProductListItem ) => boolean, icon: unknown, success: ( count: number ) => string ): ProductAction {
	return {
		id,
		label,
		icon,
		supportsBulk: true,
		isEligible: ( item ) => isRealRow( item ) && canEdit( item ) && eligible( item ),
		callback: ( items, { onActionPerformed } ) => {
			void optimisticBatch( items, {
				patch: ( item ) => ( { id: item.id, status } ),
				// On a status tab the rows leave the page; on "all" only the counts move.
				refetch: true,
				success,
			} ).then( () => onActionPerformed?.( items ) );
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
			( count ) => sprintf( _n( '%d variation enabled.', '%d variations enabled.', count, 'wp-woocommerce-products-list' ), count )
		),
		scope: 'variation',
		callback: ( items, { onActionPerformed } ) => {
			void optimisticBatch( items, {
				patch: ( item ) => ( { id: item.id, status: 'publish' } ),
				refetch: false,
				/* translators: %d: number of variations */
				success: ( count ) => sprintf( _n( '%d variation enabled.', '%d variations enabled.', count, 'wp-woocommerce-products-list' ), count ),
			} ).then( () => onActionPerformed?.( items ) );
		},
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
			() => ''
		),
		scope: 'variation',
		callback: ( items, { onActionPerformed } ) => {
			void optimisticBatch( items, {
				patch: ( item ) => ( { id: item.id, status: 'private' } ),
				refetch: false,
				/* translators: %d: number of variations */
				success: ( count ) => sprintf( _n( '%d variation disabled.', '%d variations disabled.', count, 'wp-woocommerce-products-list' ), count ),
			} ).then( () => onActionPerformed?.( items ) );
		},
	};
};
