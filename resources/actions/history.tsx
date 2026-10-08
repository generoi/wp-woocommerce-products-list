/** Per-row change history (what the list logged for this product or variation). */
import { __ } from '@wordpress/i18n';
import type { RenderModalProps } from '../dataviews';
import { RowHistoryModal } from '../history/row-history-modal';
import type { ProductAction, ProductListItem } from '../types';
import type { ActionFactory } from './context';
import { isRealRow, nameOf } from './context';

export const createHistoryAction: ActionFactory = () => {
	const action: ProductAction = {
		id: 'history',
		label: __( 'History', 'wp-woocommerce-products-list' ),
		supportsBulk: false,
		isEligible: isRealRow,
		RenderModal: ( props: RenderModalProps< ProductListItem > ) => <RowHistoryModal { ...props } />,
		modalHeader: ( items ) => ( items[ 0 ] ? `${ __( 'History', 'wp-woocommerce-products-list' ) }: ${ nameOf( items[ 0 ] ) }` : __( 'History', 'wp-woocommerce-products-list' ) ),
		modalSize: 'large',
	};

	return action;
};
