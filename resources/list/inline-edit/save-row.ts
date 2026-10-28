/**
 * One row's edits from the table itself (an image, a price typed into its
 * cell), saved as quick edit saves them (`saveEdits`: the list's progress
 * bar and row lock, the clash check against the values the list loaded, a
 * History batch) and reported in one snackbar with Undo.
 */
import { __, sprintf } from '@wordpress/i18n';
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

	notify.success(
		sprintf( /* translators: 1: field names ("Price and Sale price"), 2: product name */ __( '%1$s of %2$s saved.', 'wp-woocommerce-products-list' ), fieldList( labels ), name ),
		{
			id: INLINE_SAVED_NOTICE_ID,
			actions: canUndo()
				? [
						{
							label: __( 'Undo', 'wp-woocommerce-products-list' ),
							onClick: () => void undoBatch( result.batchId, { focus: captureFocusOrigin() } ),
						},
				  ]
				: undefined,
		}
	);

	return { ok: true, row };
}
