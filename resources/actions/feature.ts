/** Toggle the featured flag, optimistically, through a batch update. */
import { __, _n, sprintf } from '@wordpress/i18n';
import { starEmpty, starFilled } from '@wordpress/icons';
import type { ProductAction } from '../types';
import type { ActionFactory } from './context';
import { canEdit, isRealRow } from './context';
import { optimisticBatch } from './status';

function featureAction( id: string, label: string, featured: boolean, icon: unknown ): ProductAction {
	return {
		id,
		label,
		icon,
		supportsBulk: true,
		scope: 'product',
		isEligible: ( item ) => isRealRow( item ) && canEdit( item ) && Boolean( item.featured ) !== featured && item.status !== 'trash',
		callback: ( items, { onActionPerformed } ) => {
			void optimisticBatch( items, {
				patch: ( item ) => ( { id: item.id, featured } ),
				refetch: false,
				success: ( count ) =>
					featured
						? /* translators: %d: number of products */
						  sprintf( _n( '%d product marked as featured.', '%d products marked as featured.', count, 'wp-woocommerce-products-list' ), count )
						: /* translators: %d: number of products */
						  sprintf( _n( '%d product is no longer featured.', '%d products are no longer featured.', count, 'wp-woocommerce-products-list' ), count ),
			} ).then( () => onActionPerformed?.( items ) );
		},
	};
}

export const createFeatureAction: ActionFactory = ( { settings } ) =>
	settings.caps.edit ? featureAction( 'feature', __( 'Mark as featured', 'wp-woocommerce-products-list' ), true, starFilled ) : null;

export const createUnfeatureAction: ActionFactory = ( { settings } ) =>
	settings.caps.edit ? featureAction( 'unfeature', __( 'Remove from featured', 'wp-woocommerce-products-list' ), false, starEmpty ) : null;
