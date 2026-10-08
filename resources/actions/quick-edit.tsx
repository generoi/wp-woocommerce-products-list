/** Quick edit (one row) / bulk edit (many) in a DataViews modal. */
import { Spinner } from '@wordpress/components';
import { lazy, Suspense } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { pencil } from '@wordpress/icons';
import type { RenderModalProps } from '../dataviews';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory } from './context';
import { canEdit, isRealRow, realRows } from './context';
import '../edit/style.scss';

/**
 * The modal (DataForm glue, numeric ops, save flow) loads on first use as
 * its own chunk: the list page stays under the size budget and most visits
 * never open it. The stylesheet is imported here, statically, so it ships
 * with the main bundle and the chunk carries no CSS of its own.
 */
const ProductEditModal = lazy( () => import( /* webpackChunkName: "edit" */ '../edit/product-edit-modal' ) );

export const createQuickEditAction: ActionFactory = ( { settings, fields } ) => {
	if ( ! settings.caps.edit ) {
		return null;
	}

	const RenderModal = ( props: RenderModalProps< ProductListItem > ) => (
		<Suspense fallback={ <div className="wc-pl-edit__loading"><Spinner /></div> }>
			<ProductEditModal { ...props } items={ realRows( props.items ) } fields={ fields } />
		</Suspense>
	);

	const action: ProductAction = {
		id: 'quick-edit',
		label: ( items ) => ( items.length > 1 ? __( 'Bulk edit', 'wp-woocommerce-products-list' ) : __( 'Quick edit', 'wp-woocommerce-products-list' ) ),
		icon: pencil,
		isPrimary: true,
		supportsBulk: true,
		isEligible: ( item ) => isRealRow( item ) && canEdit( item ),
		RenderModal,
		modalHeader: ( items ) =>
			items.length > 1
				? sprintf(
						/* translators: %d: number of rows */
						_n( 'Edit %d item', 'Edit %d items', items.length, 'wp-woocommerce-products-list' ),
						items.length
				  )
				: __( 'Quick edit', 'wp-woocommerce-products-list' ),
		modalSize: 'large',
		modalFocusOnMount: 'firstContentElement',
	};

	return action;
};
