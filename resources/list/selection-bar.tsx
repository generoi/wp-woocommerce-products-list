/**
 * The selection controls in the toolbar: what is selected (with how many
 * of them are not in this view), "Select all N" for the whole list, "Bulk
 * edit" over the whole selection (DataViews' own footer only reaches the
 * page), and "Clear". The bulk edit opens the inline editor above the first
 * row with every selected row (`onEdit`).
 */
import { useMemo } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { Button } from '../ui';
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
	/** The list's actions: "Bulk edit" shows when the quick-edit action is among them (the user may edit). */
	actions: ProductAction[];
	/** Open the inline editor on these rows. */
	onEdit( rows: ProductListItem[] ): void;
}

/** "12 selected (4 not in this view)": on other pages, or filtered out since they were selected. */
export function selectionLabel( count: number, offPage: number ): string {
	/* translators: %d: number of selected rows */
	const selected = sprintf( _n( '%d selected', '%d selected', count, 'wp-woocommerce-products-list' ), count );

	if ( ! offPage ) {
		return selected;
	}

	return `${ selected } (${ sprintf(
		/* translators: %d: number of selected rows not shown in the list right now (other pages, or filtered out) */
		_n( '%d not in this view', '%d not in this view', offPage, 'wp-woocommerce-products-list' ),
		offPage
	) })`;
}

export function SelectionBar( { selection, total, pageProducts, query, actions, onEdit }: SelectionBarProps ) {
	const canEdit = useMemo( () => actions.some( ( action ) => action.id === 'quick-edit' ), [ actions ] );
	const count = selection.selection.length;
	const progress = selection.selectAllProgress;
	// Offered once something is selected, like the header checkbox's "select all on this page" it extends.
	const canSelectAll = ! progress && count > 0 && total > pageProducts && count < total;

	if ( ! count && ! progress && ! selection.selectAllError && ! canSelectAll ) {
		return null;
	}

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
			{ count > 0 && canEdit && (
				<Button size="compact" variant="primary" onClick={ () => onEdit( selection.rows ) }>
					{ count > 1 ? __( 'Bulk edit', 'wp-woocommerce-products-list' ) : __( 'Quick edit', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
			{ count > 0 && (
				<Button size="compact" variant="tertiary" onClick={ selection.clear }>
					{ __( 'Clear selection', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
		</div>
	);
}
