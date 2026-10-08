/**
 * The selection controls in the toolbar: what is selected (with how many
 * of them sit on other pages), "Select all N" for the whole list, "Bulk
 * edit" over the whole selection (DataViews' own footer only reaches the
 * page), and "Clear". The bulk edit opens the quick-edit action's modal
 * with every selected row.
 */
import { useCallback, useMemo, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { Button, Modal } from '../ui';
import type { ProductAction, ProductListItem, QueryParams } from '../types';
import type { SelectionApi } from './selection';

export interface SelectionBarProps {
	selection: SelectionApi;
	/** Products matching the current list query. */
	total: number;
	/** Products on this page. */
	pageProducts: number;
	/** The current list request, for "Select all". */
	query: QueryParams;
	actions: ProductAction[];
}

/** "12 selected (4 on other pages)". */
export function selectionLabel( count: number, offPage: number ): string {
	/* translators: %d: number of selected rows */
	const selected = sprintf( _n( '%d selected', '%d selected', count, 'wp-woocommerce-products-list' ), count );

	if ( ! offPage ) {
		return selected;
	}

	return `${ selected } (${ sprintf(
		/* translators: %d: number of selected rows on other pages */
		_n( '%d on another page', '%d on other pages', offPage, 'wp-woocommerce-products-list' ),
		offPage
	) })`;
}

export function SelectionBar( { selection, total, pageProducts, query, actions }: SelectionBarProps ) {
	const [ editing, setEditing ] = useState( false );
	const edit = useMemo( () => actions.find( ( action ) => action.id === 'quick-edit' ), [ actions ] );
	const count = selection.selection.length;
	const progress = selection.selectAllProgress;
	// Offered once something is selected, like the header checkbox's "select all on this page" it extends.
	const canSelectAll = ! progress && count > 0 && total > pageProducts && count < total;
	const close = useCallback( () => setEditing( false ), [] );

	if ( ! count && ! progress && ! selection.selectAllError && ! canSelectAll ) {
		return null;
	}

	const modalHeader = edit && 'RenderModal' in edit ? ( typeof edit.modalHeader === 'function' ? edit.modalHeader( selection.rows ) : edit.modalHeader ) : undefined;

	return (
		<div className="wc-products-list__selection" role="group" aria-label={ __( 'Selection', 'wp-woocommerce-products-list' ) }>
			{ count > 0 && (
				<span className="wc-products-list__selection-count" aria-live="polite">
					{ selectionLabel( count, selection.offPageCount ) }
				</span>
			) }
			{ progress && (
				<span className="wc-products-list__selection-progress" role="status">
					{ sprintf(
						/* translators: 1: products loaded so far, 2: products in total */
						__( 'Selecting %1$s of %2$s…', 'wp-woocommerce-products-list' ),
						progress.loaded.toLocaleString(),
						progress.total.toLocaleString()
					) }
					<Button size="compact" variant="link" onClick={ selection.cancelSelectAll }>
						{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
					</Button>
				</span>
			) }
			{ canSelectAll && (
				<Button size="compact" variant="link" className="wc-products-list__select-all" onClick={ () => void selection.selectAllMatching( query, total ) }>
					{ sprintf(
						/* translators: %s: number of products matching the list */
						_n( 'Select all %s product', 'Select all %s products', total, 'wp-woocommerce-products-list' ),
						total.toLocaleString()
					) }
				</Button>
			) }
			{ selection.selectAllError && (
				<span className="wc-products-list__selection-error" role="alert">
					{ selection.selectAllError }
				</span>
			) }
			{ count > 0 && edit && 'RenderModal' in edit && (
				<Button size="compact" variant="primary" onClick={ () => setEditing( true ) }>
					{ count > 1 ? __( 'Bulk edit', 'wp-woocommerce-products-list' ) : __( 'Quick edit', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
			{ count > 0 && (
				<Button size="compact" variant="tertiary" onClick={ selection.clear }>
					{ __( 'Clear selection', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
			{ editing && edit && 'RenderModal' in edit && (
				<Modal
					title={ modalHeader || ( typeof edit.label === 'function' ? edit.label( selection.rows ) : edit.label ) }
					onRequestClose={ close }
					focusOnMount={ edit.modalFocusOnMount ?? true }
					size={ edit.modalSize ?? 'medium' }
					overlayClassName="dataviews-action-modal dataviews-action-modal__quick-edit wc-products-list__selection-modal"
				>
					<edit.RenderModal items={ selection.rows as ProductListItem[] } closeModal={ close } onActionPerformed={ () => {} } />
				</Modal>
			) }
		</div>
	);
}
