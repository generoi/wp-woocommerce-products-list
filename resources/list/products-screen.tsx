/**
 * The Catalog screen: status tabs, the hierarchical DataViews table over
 * the current page of products, and the snackbar stack. Rows come from the
 * query cache (previous page stays visible while the next loads), the
 * hierarchy splices expanded variations in, actions come from actions/.
 */
import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { addAction, removeAction } from '@wordpress/hooks';
import { __ } from '@wordpress/i18n';
import useProductActions from '../actions';
import { ApiError } from '../api/errors';
import type { View } from '../dataviews';
import { ACTIONS } from '../extensions/hooks';
import { HierarchyProvider } from '../hierarchy/context';
import { footerCountLabel } from '../hierarchy/footer-count';
import { HierarchicalDataViews } from '../hierarchy/hierarchical-dataviews';
import { useHierarchy } from '../hierarchy/use-hierarchy';
import { useCounts, useProductList } from '../store/products';
import { setCurrentRows } from '../store/rows';
import { useView } from '../store/view';
import { getItemId, isProductRow } from '../types';
import type { BatchResult, ProductField, ProductListItem, ProductRow, Settings } from '../types';
import { Button, Notice, Notices, Spinner } from '../ui';
import { DEFAULT_LAYOUTS, PER_PAGE_SIZES } from './default-view';
import { EmptyState } from './empty-state';
import { StatusTabs } from './status-tabs';

export interface ProductsScreenProps {
	fields: ProductField[];
	settings: Settings;
}

const PANEL_ID = 'wc-products-list-panel';

function getItemLevel( item: ProductListItem ): number {
	return item._level;
}

/** What to tell the user when a list request failed while rows are still on screen. */
export function listErrorMessage( error: Error ): { message: string; reload: boolean } {
	if ( error instanceof ApiError && ( error.code === 'rest_cookie_invalid_nonce' || error.isForbidden ) ) {
		return { message: __( 'Your session has expired. Reload the page to keep working.', 'wp-woocommerce-products-list' ), reload: true };
	}

	return { message: error.message || __( 'The products could not be loaded.', 'wp-woocommerce-products-list' ), reload: false };
}

export function ProductsScreen( { fields, settings }: ProductsScreenProps ) {
	const { view, setView, tab, setTab, isModified, resetView } = useView( fields, settings );
	const list = useProductList( view, tab, fields );
	const { counts } = useCounts();
	const parents = useMemo( () => list.items.filter( isProductRow ) as ProductRow[], [ list.items ] );
	// Variations are fetched with the visible columns' fields only, like the products.
	const visibleFields = useMemo( () => {
		const ids = new Set( [ ...( view.fields ?? [] ), view.titleField, view.mediaField, view.descriptionField ].filter( Boolean ) );

		return fields.filter( ( field ) => ids.has( field.id ) );
	}, [ fields, view.fields, view.titleField, view.mediaField, view.descriptionField ] );
	const hierarchy = useHierarchy( parents, visibleFields );
	const [ selection, setSelection ] = useState< string[] >( [] );
	const actions = useProductActions( { fields, settings, view, tab, hierarchy, selection, onChangeSelection: setSelection } );

	// Rows that left the page (new page, tab, filter, trash) leave the selection too.
	useEffect( () => {
		const ids = new Set( hierarchy.rows.map( getItemId ) );
		setSelection( ( current ) => {
			const kept = current.filter( ( id ) => ids.has( id ) );

			return kept.length === current.length ? current : kept;
		} );
	}, [ hierarchy.rows ] );

	// A new page, tab, search, filter or sort is a new list: nothing stays
	// selected across it, as in the classic list table. The previous rows
	// remain visible while the next load, so this cannot wait for them.
	const listKey = JSON.stringify( [ view.page, view.perPage, tab, view.search ?? '', view.filters ?? [], view.sort ?? null ] );
	useEffect( () => {
		setSelection( ( current ) => ( current.length ? [] : current ) );
	}, [ listKey ] );

	// Saved rows leave the selection, so the next bulk action cannot
	// silently target what the last one already changed; rows that failed
	// stay selected for a retry.
	useEffect( () => {
		const namespace = 'wcProductsList/screen-selection';
		const onSaved = ( result: BatchResult ) => {
			const saved = new Set( ( result?.updated ?? [] ).map( ( row ) => String( row.id ) ) );

			if ( saved.size ) {
				setSelection( ( current ) => {
					const kept = current.filter( ( id ) => ! saved.has( id ) );

					return kept.length === current.length ? current : kept;
				} );
			}
		};

		addAction( ACTIONS.saved, namespace, onSaved );

		return () => {
			removeAction( ACTIONS.saved, namespace );
		};
	}, [] );

	// `window.wcProductsList.getItems()` reads what is on screen.
	useEffect( () => {
		setCurrentRows( hierarchy.rows );
	}, [ hierarchy.rows ] );
	useEffect( () => () => setCurrentRows( [] ), [] );

	const hasQuery = Boolean( view.search ) || ( view.filters?.length ?? 0 ) > 0;
	const clearQuery = useCallback( () => setView( { ...view, search: '', filters: [], page: 1 } as View ), [ setView, view ] );

	const hasExpandable = parents.some( ( item ) => item._hasChildren );
	const countLabel = useMemo( () => footerCountLabel( { data: hierarchy.rows, selection, totalItems: list.total } ), [ hierarchy.rows, selection, list.total ] );
	const header = (
		<div className="wc-products-list__header">
			<span className="wc-products-list__count" aria-live="polite">
				{ countLabel }
			</span>
			{ list.isFetching && ! list.isLoading && <Spinner /> }
			{ hasExpandable && (
				<>
					<Button size="compact" variant="tertiary" onClick={ () => void hierarchy.expandAll() }>
						{ __( 'Expand all', 'wp-woocommerce-products-list' ) }
					</Button>
					<Button size="compact" variant="tertiary" onClick={ () => hierarchy.collapseAll() } disabled={ hierarchy.expandedItemIds.length === 0 }>
						{ __( 'Collapse all', 'wp-woocommerce-products-list' ) }
					</Button>
				</>
			) }
			{ settings.links.history && (
				<Button size="compact" variant="tertiary" href={ settings.links.history } className="wc-products-list__history-link">
					{ __( 'History', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
			{ settings.caps.edit && (
				<Button size="compact" variant="secondary" href={ settings.links.newProduct }>
					{ __( 'Add new', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
		</div>
	);

	// A failed request while the previous rows are still on screen: say so
	// (the table's empty state only shows when there is nothing to show).
	const staleError = list.error && list.items.length > 0 ? listErrorMessage( list.error ) : null;

	return (
		<HierarchyProvider value={ hierarchy }>
			<div className={ `wc-products-list${ list.isFetching ? ' is-fetching' : '' }${ staleError ? ' is-stale' : '' }` }>
				<StatusTabs tab={ tab } onChange={ setTab } counts={ counts } settings={ settings } panelId={ PANEL_ID } />
				{ staleError && (
					<Notice
						status="error"
						isDismissible={ false }
						className="wc-products-list__stale-notice"
						actions={
							staleError.reload
								? [ { label: __( 'Reload', 'wp-woocommerce-products-list' ), onClick: () => window.location.reload() } ]
								: [ { label: __( 'Retry', 'wp-woocommerce-products-list' ), onClick: () => void list.refetch().catch( () => {} ) } ]
						}
					>
						{ staleError.message }{ ' ' }
						{ __( 'The rows shown may be out of date.', 'wp-woocommerce-products-list' ) }
					</Notice>
				) }
				<div id={ PANEL_ID } role="tabpanel" aria-labelledby={ `wc-products-list-tab-${ tab }` } className="wc-products-list__panel">
					<HierarchicalDataViews
						data={ hierarchy.rows }
						fields={ fields }
						view={ view }
						onChangeView={ setView }
						actions={ actions }
						isLoading={ list.isLoading }
						paginationInfo={ { totalItems: list.total, totalPages: list.totalPages } }
						defaultLayouts={ DEFAULT_LAYOUTS }
						selection={ selection }
						onChangeSelection={ setSelection }
						getItemId={ getItemId }
						getItemLevel={ getItemLevel }
						config={ { perPageSizes: PER_PAGE_SIZES } }
						searchLabel={ __( 'Search name or SKU', 'wp-woocommerce-products-list' ) }
						empty={ <EmptyState tab={ tab } hasQuery={ hasQuery } onClear={ clearQuery } settings={ settings } error={ list.error } /> }
						onReset={ isModified ? resetView : false }
						header={ header }
						getItemParentId={ hierarchy.getItemParentId }
						getItemHasChildren={ hierarchy.getItemHasChildren }
						expandedItemIds={ hierarchy.expandedItemIds }
						onChangeExpandedItemIds={ hierarchy.onChangeExpandedItemIds }
						childrenState={ hierarchy.childrenState }
						onRetryChildren={ hierarchy.retry }
					/>
				</div>
				<Notices />
			</div>
		</HierarchyProvider>
	);
}

export default ProductsScreen;
