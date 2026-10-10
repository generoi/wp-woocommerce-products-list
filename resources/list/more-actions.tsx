/**
 * Split view: beside the editor panel the bulk-actions footer had room for
 * a block of wrapped buttons with "Move to Trash" next to "Clear sale price".
 * There the footer keeps the primary actions (Quick/Bulk edit) and the
 * selection bar offers the rest in a "More actions" menu over the whole
 * selection, destructive actions last in a group of their own.
 */
import { DropdownMenu, MenuGroup, MenuItem } from '@wordpress/components';
import { useRegistry } from '@wordpress/data';
import { useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { moreVertical } from '@wordpress/icons';
import { Modal } from '../ui';
import type { ProductAction, ProductListItem } from '../types';

/** Actions that remove products or variations: listed last, apart, in red. */
export const DESTRUCTIVE_ACTION_IDS: readonly string[] = [ 'trash', 'delete', 'delete-variations' ];

export function isDestructiveAction( action: Pick< ProductAction, 'id' > & { isDestructive?: boolean } ): boolean {
	return Boolean( action.isDestructive ) || DESTRUCTIVE_ACTION_IDS.includes( action.id );
}

/** Destructive actions after the others, each group in its own order (row menus and the footer read them in this order). */
export function destructiveLast< A extends Pick< ProductAction, 'id' > & { isDestructive?: boolean } >( actions: A[] ): A[] {
	return [ ...actions.filter( ( action ) => ! isDestructiveAction( action ) ), ...actions.filter( isDestructiveAction ) ];
}

/** The bulk actions the "More actions" menu offers for these rows: not the primary ones (inline), only those some row is eligible for. */
export function moreActionsFor( actions: ProductAction[], rows: ProductListItem[] ): { regular: ProductAction[]; destructive: ProductAction[] } {
	const eligible = actions.filter( ( action ) => action.supportsBulk && ! action.isPrimary && rows.some( ( row ) => ! action.isEligible || action.isEligible( row ) ) );

	return { regular: eligible.filter( ( action ) => ! isDestructiveAction( action ) ), destructive: eligible.filter( isDestructiveAction ) };
}

/**
 * Whether the bulk actions other than the primary ones are offered in the selection bar's "More actions" menu instead
 * of the footer: in split view, and whenever the selection holds rows that are not on this page. DataViews' footer
 * decides which actions to show from the page's selected rows only, so with every page row already featured it offers
 * no "Mark as featured" for the rows selected on other pages; the menu judges the whole selection (`moreActionsFor()`).
 */
export function usesMoreActionsMenu( panelOpen: boolean, offPageCount: number ): boolean {
	return panelOpen || offPageCount > 0;
}

/** The footer's actions in split view: the ones the menu offers no longer show as footer buttons. */
export function withoutFooterBulk( actions: ProductAction[] ): ProductAction[] {
	return actions.map( ( action ) => ( action.supportsBulk && ! action.isPrimary ? ( { ...action, supportsBulk: false } as ProductAction ) : action ) );
}

function labelOf( action: ProductAction, items: ProductListItem[] ): string {
	return typeof action.label === 'function' ? action.label( items ) : action.label;
}

export function MoreActionsMenu( { actions, rows }: { actions: ProductAction[]; rows: ProductListItem[] } ) {
	const registry = useRegistry();
	const { regular, destructive } = useMemo( () => moreActionsFor( actions, rows ), [ actions, rows ] );
	const [ modal, setModal ] = useState< { action: ProductAction; items: ProductListItem[] } | null >( null );

	if ( ! regular.length && ! destructive.length && ! modal ) {
		return null;
	}

	const run = ( action: ProductAction ) => {
		const items = rows.filter( ( row ) => ! action.isEligible || action.isEligible( row ) );

		if ( 'RenderModal' in action ) {
			setModal( { action, items } );

			return;
		}

		if ( 'callback' in action && typeof action.callback === 'function' ) {
			void action.callback( items, { registry } as Parameters< typeof action.callback >[ 1 ] );
		}
	};

	const item = ( action: ProductAction, onClose: () => void ) => (
		<MenuItem
			key={ action.id }
			isDestructive={ isDestructiveAction( action ) }
			onClick={ () => {
				onClose();
				run( action );
			} }
		>
			{ labelOf( action, rows ) }
		</MenuItem>
	);

	const ModalBody = modal && 'RenderModal' in modal.action ? modal.action.RenderModal : null;
	const header = modal && 'RenderModal' in modal.action ? ( typeof modal.action.modalHeader === 'function' ? modal.action.modalHeader( modal.items ) : modal.action.modalHeader ) : undefined;

	return (
		<>
			{ ( regular.length > 0 || destructive.length > 0 ) && (
				<DropdownMenu
					icon={ moreVertical }
					text={ __( 'More actions', 'wp-woocommerce-products-list' ) }
					label={ __( 'More actions', 'wp-woocommerce-products-list' ) }
					toggleProps={ { size: 'compact', variant: 'secondary', className: 'wc-products-list__more-actions' } }
				>
					{ ( { onClose } ) => (
						<>
							{ regular.length > 0 && <MenuGroup>{ regular.map( ( action ) => item( action, onClose ) ) }</MenuGroup> }
							{ destructive.length > 0 && <MenuGroup>{ destructive.map( ( action ) => item( action, onClose ) ) }</MenuGroup> }
						</>
					) }
				</DropdownMenu>
			) }
			{ modal && ModalBody && (
				<Modal title={ header || labelOf( modal.action, modal.items ) } onRequestClose={ () => setModal( null ) } size="medium">
					<ModalBody items={ modal.items } closeModal={ () => setModal( null ) } />
				</Modal>
			) }
		</>
	);
}
