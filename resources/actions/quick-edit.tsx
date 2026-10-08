/**
 * Quick edit (one row) / bulk edit (many) inline in the table: the action
 * hands the rows to the screen, which places the editor row (a quick edit
 * in the row's place, the bulk editor above the first row) and mounts the
 * editor chunk into it. DataViews' bulk footer and the row menu both call
 * the callback; the selection bar's "Bulk edit" goes to the screen directly.
 */
import { pencil } from '@wordpress/icons';
import { __ } from '@wordpress/i18n';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { canEdit, isRealRow, realRows } from './context';
import '../edit/style.scss';

const TRANSLATION_FILTER = /^(?:missing|translated):([a-z]{2,8})$/i;

/**
 * The tab the editor opens on, from the list: a "Missing in Svenska"
 * translation filter means the Svenska tab (the user is there to fill it);
 * nothing otherwise (the editor then remembers the last tab used).
 */
export function initialTabFor( filters: Array< { field: string; value?: unknown } > | undefined ): string | undefined {
	for ( const filter of filters ?? [] ) {
		if ( filter.field !== 'translation' ) {
			continue;
		}

		const values = Array.isArray( filter.value ) ? filter.value : [ filter.value ];

		for ( const value of values ) {
			const match = typeof value === 'string' ? TRANSLATION_FILTER.exec( value ) : null;

			if ( match ) {
				return `i18n:${ match[ 1 ]!.toLowerCase() }`;
			}
		}
	}

	return undefined;
}

export const createQuickEditAction: ActionFactory = ( context ) => {
	const { settings } = context;

	if ( ! settings.caps.edit || ! context.openEditor ) {
		return null;
	}

	const action: ProductAction = {
		id: 'quick-edit',
		label: ( items ) => ( items.length > 1 ? __( 'Bulk edit', 'wp-woocommerce-products-list' ) : __( 'Quick edit', 'wp-woocommerce-products-list' ) ),
		icon: pencil,
		isPrimary: true,
		supportsBulk: true,
		isEligible: ( item ) => isRealRow( item ) && canEdit( item ),
		// Resolves at once: DataViews' footer button shows busy until the callback settles, and the editor outlives it.
		callback: ( items ) => {
			context.openEditor?.( realRows( items ) );
		},
	};

	return action;
};
