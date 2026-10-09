/**
 * Add every variation of the selected variable products to the selection
 * (expanding them first: DataViews keeps only ids that are in `data`).
 * Needs the screen's `onChangeSelection`; without it the action is hidden.
 */
import { __ } from '@wordpress/i18n';
import type { ProductAction, VariationRow } from '../types';
import type { ActionFactory, ProductActionsContext } from './context';
import { idsOf, isRealRow } from './context';
import { notify } from './notices';

function selectVariationsAction( context: ProductActionsContext, id: string, label: string, where?: ( variation: VariationRow ) => boolean ): ProductAction | null {
	const { hierarchy, onChangeSelection } = context;

	if ( ! onChangeSelection ) {
		return null;
	}

	return {
		id,
		label,
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && item._hasChildren,
		callback: ( items ) => {
			void ( async () => {
				// Read at call time: the action list is built once per field set.
				const current = context.selection ?? [];

				try {
					// All parents at once: one expand, the loads in parallel.
					onChangeSelection( await hierarchy.selectVariations( idsOf( items ), current, where ) );
				} catch ( error ) {
					notify.error( error instanceof Error ? error.message : __( 'The variations could not be loaded.', 'wp-woocommerce-products-list' ) );
				}
			} )();
		},
	};
}

export const createSelectVariationsAction: ActionFactory = ( context ) => selectVariationsAction( context, 'select-variations', __( 'Select all variations', 'wp-woocommerce-products-list' ) );

/** The restock case: only the sizes that are out of stock, so a bulk quantity applies to them alone. */
export const createSelectOutOfStockVariationsAction: ActionFactory = ( context ) =>
	selectVariationsAction( context, 'select-variations-outofstock', __( 'Select out-of-stock variations', 'wp-woocommerce-products-list' ), ( variation ) => variation.stock_status === 'outofstock' );
