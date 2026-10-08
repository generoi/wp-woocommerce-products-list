/** Open the classic editor; a variation opens its parent (edit_link already points there). */
import { __ } from '@wordpress/i18n';
import { sprintf } from '@wordpress/i18n';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory } from './context';
import { canEdit, isRealRow } from './context';

export function editLinkOf( item: ProductListItem, editProduct: string ): string | null {
	const link = item.wc_products_list?.edit_link;

	if ( link ) {
		return link;
	}

	const id = item._kind === 'variation' ? item._parentId ?? ( item as { parent_id?: number } ).parent_id : item.id;

	return id && editProduct ? sprintf( editProduct as '%d', id ) : null;
}

export const createEditAction: ActionFactory = ( { settings } ) => {
	if ( ! settings.caps.edit ) {
		return null;
	}

	const action: ProductAction = {
		id: 'edit',
		label: __( 'Edit', 'wp-woocommerce-products-list' ),
		supportsBulk: false,
		isEligible: ( item ) => isRealRow( item ) && canEdit( item ) && editLinkOf( item, settings.links.editProduct ) !== null,
		callback: ( items ) => {
			const item = items[ 0 ];
			const link = item ? editLinkOf( item, settings.links.editProduct ) : null;

			if ( link ) {
				window.location.assign( link );
			}
		},
	};

	return action;
};
