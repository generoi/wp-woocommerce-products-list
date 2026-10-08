/**
 * The Catalog screen: status tabs, the hierarchical DataViews table over
 * the current page of products, and the snackbar stack. Rows come from the
 * query cache (previous page stays visible while the next loads), the
 * hierarchy splices expanded variations in, actions come from actions/.
 */
import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import useProductActions from '../actions';
import type { View } from '../dataviews';
import { HierarchyProvider } from '../hierarchy/context';
import { HierarchicalDataViews } from '../hierarchy/hierarchical-dataviews';
import { useHierarchy } from '../hierarchy/use-hierarchy';
import { useCounts, useProductList } from '../store/products';
import { useView } from '../store/view';
import { getItemId, isProductRow } from '../types';
import type { ProductField, ProductListItem, ProductRow, Settings } from '../types';
import { Button, Notices, Spinner } from '../ui';
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

	const hasQuery = Boolean( view.search ) || ( view.filters?.length ?? 0 ) > 0;
	const clearQuery = useCallback( () => setView( { ...view, search: '', filters: [], page: 1 } as View ), [ setView, view ] );

	const hasExpandable = parents.some( ( item ) => item._hasChildren );
	const header = (
		<div className="wc-products-list__header">
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
			{ settings.caps.edit && (
				<Button size="compact" variant="secondary" href={ settings.links.newProduct }>
					{ __( 'Add new', 'wp-woocommerce-products-list' ) }
				</Button>
			) }
		</div>
	);

	return (
		<HierarchyProvider value={ hierarchy }>
			<div className={ `wc-products-list${ list.isFetching ? ' is-fetching' : '' }` }>
				<StatusTabs tab={ tab } onChange={ setTab } counts={ counts } settings={ settings } panelId={ PANEL_ID } />
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
					/>
				</div>
				<Notices />
			</div>
		</HierarchyProvider>
	);
}

export default ProductsScreen;
