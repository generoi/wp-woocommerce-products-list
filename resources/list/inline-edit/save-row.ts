/**
 * One row's edits from the table itself (an image, a price typed into its
 * cell), saved as quick edit saves them (`saveEdits`: the list's progress
 * bar and row lock, the clash check against the values the list loaded, a
 * History batch) and reported in one snackbar with Undo.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import { notify } from '../../actions/notices';
import { captureFocusOrigin } from '../../edit/focus';
import { itemLabel } from '../../edit/item-label';
import { isVariation } from '../../edit/field-value';
import { canUndo } from '../../edit/log-access';
import { saveEdits } from '../../edit/save';
import { undoBatch } from '../../edit/undo';
import { finishSaveJob, startSaveJob } from '../../store/save-activity';
import type { ProductField, ProductListItem } from '../../types';

export const INLINE_SAVED_NOTICE_ID = 'wc-pl-inline-saved';

/** Saves this close together share one snackbar, and its Undo takes all of them back (a column repriced row by row). */
const GROUP_MS = 30000;

let recent: { batches: string[]; rows: Set< number >; at: number } | null = null;

/** For tests. */
export function resetRecentSaves(): void {
	recent = null;
}

/** Undoes the batches newest first, one after another (each is its own revert in History). */
async function undoAll( batches: string[] ): Promise< void > {
	const focus = captureFocusOrigin();

	for ( const batchId of batches.slice().reverse() ) {
		await undoBatch( batchId, { focus } );
	}
}

export interface RowSaveOutcome {
	ok: boolean;
	/** The row as saved (the server's answer merged in), when it saved. */
	row?: ProductListItem;
	/** Why it did not save. */
	message?: string;
	/** The server's error code (`wc_products_list_conflict` when someone else changed the row meanwhile). */
	code?: string;
	/** Nothing to save: the values equal the row's. */
	unchanged?: boolean;
}

/** "Price" or "Price and Sale price" or "Name, SKU and Price". */
export function fieldList( labels: string[] ): string {
	if ( labels.length <= 1 ) {
		return labels[ 0 ] ?? '';
	}

	/* translators: 1: comma-separated field names, 2: the last field name */
	return sprintf( __( '%1$s and %2$s', 'wp-woocommerce-products-list' ), labels.slice( 0, -1 ).join( ', ' ), labels[ labels.length - 1 ] ?? '' );
}

export async function saveRow( item: ProductListItem, edits: Record< string, unknown >, fields: ProductField[] ): Promise< RowSaveOutcome > {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const labels = Object.keys( edits ).map( ( id ) => {
		const field = byId.get( id );

		// A variation has one image.
		if ( id === 'images' && isVariation( item ) ) {
			return __( 'Image', 'wp-woocommerce-products-list' );
		}

		return ( field?.edit && field.edit.label ) || field?.label || id;
	} );
	const name = itemLabel( item );
	let result;

	// Only this row is locked while it saves: a bulk save also locks a variation's parent, and with it every sibling
	// (hierarchy/chevron.tsx), which would take the next row's input away from the keyboard as Enter moves down to it.
	// The server still serialises writes per product.
	const job = startSaveJob( [ item.id ] );

	try {
		result = await saveEdits( [ item ], edits, fields, { applyToVariations: false, source: 'quick', saveJob: job } );
	} catch ( caught ) {
		const message = caught instanceof Error ? caught.message : String( ( caught as { message?: unknown } | null )?.message ?? caught );

		notify.error( sprintf( /* translators: 1: product name, 2: error */ __( '%1$s was not saved: %2$s', 'wp-woocommerce-products-list' ), name, message ), { id: INLINE_SAVED_NOTICE_ID } );

		return { ok: false, message };
	} finally {
		finishSaveJob( job );
	}

	const error = result.errors.find( ( entry ) => entry.id === item.id ) ?? result.errors[ 0 ];

	if ( error ) {
		notify.error( sprintf( /* translators: 1: product name, 2: error */ __( '%1$s was not saved: %2$s', 'wp-woocommerce-products-list' ), name, error.message ), { id: INLINE_SAVED_NOTICE_ID } );

		return { ok: false, message: error.message, code: error.code };
	}

	const row = result.updated.find( ( entry ) => entry.id === item.id );

	if ( ! row ) {
		return { ok: true, unchanged: true };
	}

	const now = Date.now();

	recent = recent && now - recent.at < GROUP_MS ? { batches: [ ...recent.batches, result.batchId ], rows: new Set( [ ...recent.rows, item.id ] ), at: now } : { batches: [ result.batchId ], rows: new Set( [ item.id ] ), at: now };

	const batches = recent.batches;
	const message =
		batches.length > 1
			? sprintf(
					/* translators: 1: number of saves, 2: number of products and variations */
					_n( '%1$d change saved in the table (%2$d item).', '%1$d changes saved in the table (%2$d items).', recent.rows.size, 'wp-woocommerce-products-list' ),
					batches.length,
					recent.rows.size
			  )
			: sprintf( /* translators: 1: field names ("Price and Sale price"), 2: product name */ __( '%1$s of %2$s saved.', 'wp-woocommerce-products-list' ), fieldList( labels ), name );

	notify.success( message, {
		id: INLINE_SAVED_NOTICE_ID,
		actions: canUndo()
			? [
					{
						label: batches.length > 1 ? __( 'Undo all', 'wp-woocommerce-products-list' ) : __( 'Undo', 'wp-woocommerce-products-list' ),
						onClick: () => {
							recent = null;
							void undoAll( batches );
						},
					},
			  ]
			: undefined,
	} );

	return { ok: true, row };
}
