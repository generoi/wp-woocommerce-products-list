/**
 * The Catalog screen: status tabs, the hierarchical DataViews table over
 * the current page of products, and the snackbar stack. Rows come from the
 * query cache (previous page stays visible while the next loads), the
 * hierarchy splices expanded variations in, actions come from actions/.
 * The selection lives in list/selection.ts and spans pages; DataViews sees
 * the page's part of it and its bulk actions are widened to the whole.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import useProductActions from '../actions';
import { ApiError } from '../api/errors';
import type { View } from '../dataviews';
import { HierarchyProvider } from '../hierarchy/context';
import { footerCountLabel } from '../hierarchy/footer-count';
import { HierarchicalDataViews } from '../hierarchy/hierarchical-dataviews';
import { useExpandAllProgress, useHierarchy } from '../hierarchy/use-hierarchy';
import { useCounts, useProductList } from '../store/products';
import { setCurrentRows, setVisibleFieldIds } from '../store/rows';
import { useView } from '../store/view';
import { getItemId, isProductRow } from '../types';
import type { ProductField, ProductListItem, ProductRow, Settings } from '../types';
import { Button, Notice, Notices, Spinner } from '../ui';
import { DEFAULT_LAYOUTS, PER_PAGE_SIZES } from './default-view';
import { EmptyState } from './empty-state';
import { useSelection } from './selection';
import { SelectionBar } from './selection-bar';
import { StatusTabs } from './status-tabs';
import { withWholeSelection } from './whole-selection';
import type { WholeSelection } from './whole-selection';

export interface ProductsScreenProps {
	fields: ProductField[];
	settings: Settings;
}

const PANEL_ID = 'wc-products-list-panel';

const TABLE_ID = 'wc-products-list-table';

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

/**
 * "Expand all", and while it loads "Loading variations… 37 of 100". Reads
 * the progress from its own store so the counter re-renders this button,
 * never the table.
 */
function ExpandAllButton( { onClick }: { onClick: () => void } ) {
	const progress = useExpandAllProgress();

	return (
		<>
			<Button size="compact" variant="tertiary" onClick={ onClick } disabled={ progress !== null } isBusy={ progress !== null }>
				{ __( 'Expand all', 'wp-woocommerce-products-list' ) }
			</Button>
			{ progress ? (
				<span className="wc-products-list__expand-progress" role="status" aria-live="polite">
					{ sprintf(
						/* translators: 1: products loaded so far, 2: products being expanded */
						__( 'Loading variations… %1$d of %2$d', 'wp-woocommerce-products-list' ),
						progress.done,
						progress.total
					) }
				</span>
			) : null }
		</>
	);
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
	// The selection spans pages, searches, filters and sorts; a status tab is another list.
	const selected = useSelection( hierarchy.rows, tab );
	const { selection } = selected;
	const baseActions = useProductActions( { fields, settings, view, tab, hierarchy, selection, onChangeSelection: selected.set } );

	// DataViews' bulk actions see the page's selected rows; widen them to the
	// whole selection, read at call time (the actions list is built once).
	const whole = useMemo< WholeSelection >( () => {
		const onPage = selection.slice( 0, selection.length - selected.offPageCount );

		return { onPage, offPage: selected.rows.slice( onPage.length ) };
	}, [ selection, selected.offPageCount, selected.rows ] );
	const wholeRef = useRef( whole );
	useLayoutEffect( () => {
		wholeRef.current = whole;
	} );
	const actions = useMemo( () => withWholeSelection( baseActions, () => wholeRef.current ), [ baseActions ] );

	// `window.wcProductsList.getItems()` reads what is on screen.
	useEffect( () => {
		setCurrentRows( hierarchy.rows );
	}, [ hierarchy.rows ] );
	useEffect( () => () => setCurrentRows( [] ), [] );
	// A save asks the server for the visible columns only (edit/save.ts).
	useEffect( () => {
		setVisibleFieldIds( visibleFields.map( ( field ) => field.id ) );
	}, [ visibleFields ] );
	useEffect( () => () => setVisibleFieldIds( [] ), [] );

	const hasQuery = Boolean( view.search ) || ( view.filters?.length ?? 0 ) > 0;
	const clearQuery = useCallback( () => setView( { ...view, search: '', filters: [], page: 1 } as View ), [ setView, view ] );

	const hasExpandable = parents.some( ( item ) => item._hasChildren );
	const countLabel = useMemo( () => footerCountLabel( { data: hierarchy.rows, selection: [], totalItems: list.total } ), [ hierarchy.rows, list.total ] );
	const header = (
		<div className="wc-products-list__header">
			<span className="wc-products-list__count" aria-live="polite">
				{ countLabel }
			</span>
			{ list.isFetching && ! list.isLoading && <Spinner /> }
			<SelectionBar selection={ selected } total={ list.total } pageProducts={ parents.length } query={ list.query } actions={ actions } />
			{ hasExpandable && (
				<>
					<ExpandAllButton onClick={ () => void hierarchy.expandAll() } />
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
	// DataViews shows its bulk-actions footer for the page's selected rows; snackbars move above it.
	const hasPageSelection = selection.length > selected.offPageCount;

	return (
		<HierarchyProvider value={ hierarchy }>
			<div className={ `wc-products-list${ list.isFetching ? ' is-fetching' : '' }${ staleError ? ' is-stale' : '' }${ hasPageSelection ? ' has-footer' : '' }` }>
				<a className="wc-products-list__skip screen-reader-text" href={ `#${ TABLE_ID }` }>
					{ __( 'Skip to products', 'wp-woocommerce-products-list' ) }
				</a>
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
					<div id={ TABLE_ID } tabIndex={ -1 } className="wc-products-list__table-anchor" />
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
						onChangeSelection={ selected.onPageSelectionChange }
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
