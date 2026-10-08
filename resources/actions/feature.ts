/** Toggle the featured flag, optimistically, through a batch update. */
import { __, _n, sprintf } from '@wordpress/i18n';
import { starEmpty, starFilled } from '@wordpress/icons';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory, ProductActionsContext } from './context';
import { canEdit, dropFromSelection, isRealRow } from './context';
import { optimisticBatch } from './status';

function featureAction( context: ProductActionsContext, id: string, label: string, featured: boolean, icon: unknown ): ProductAction {
	// Rows that already have the flag are not written (a whole-list selection may hold any mix).
	const isEligible = ( item: ProductListItem ) => isRealRow( item ) && canEdit( item ) && Boolean( item.featured ) !== featured && item.status !== 'trash';

	return {
		id,
		label,
		icon,
		supportsBulk: true,
		scope: 'product',
		isEligible,
		callback: ( items, { onActionPerformed } ) => {
			void optimisticBatch( items, {
				patch: ( item ) => ( { id: item.id, featured } ),
				refetch: false,
				fields: context.fields,
				eligible: isEligible,
				success: ( count ) =>
					featured
						? /* translators: %d: number of products */
						  sprintf( _n( '%d product marked as featured.', '%d products marked as featured.', count, 'wp-woocommerce-products-list' ), count )
						: /* translators: %d: number of products */
						  sprintf( _n( '%d product is no longer featured.', '%d products are no longer featured.', count, 'wp-woocommerce-products-list' ), count ),
			} ).then( ( okIds ) => {
				dropFromSelection( context, okIds );
				onActionPerformed?.( items );
			} );
		},
	};
}

export const createFeatureAction: ActionFactory = ( context ) =>
	context.settings.caps.edit ? featureAction( context, 'feature', __( 'Mark as featured', 'wp-woocommerce-products-list' ), true, starFilled ) : null;

export const createUnfeatureAction: ActionFactory = ( context ) =>
	context.settings.caps.edit ? featureAction( context, 'unfeature', __( 'Remove from featured', 'wp-woocommerce-products-list' ), false, starEmpty ) : null;
