/**
 * Variations under their parents on top of DataViews 20.
 *
 * Usage (list/products-screen.tsx):
 *
 *   const hierarchy = useHierarchy( parents, visibleFields );
 *   <HierarchyProvider value={ hierarchy }>
 *     <HierarchicalDataViews
 *       data={ hierarchy.rows }
 *       getItemParentId={ hierarchy.getItemParentId }
 *       getItemHasChildren={ hierarchy.getItemHasChildren }
 *       expandedItemIds={ hierarchy.expandedItemIds }
 *       onChangeExpandedItemIds={ hierarchy.onChangeExpandedItemIds }
 *       childrenState={ hierarchy.childrenState }
 *       onRetryChildren={ hierarchy.retry }
 *       ...dataViewsProps
 *     />
 *   </HierarchyProvider>
 *
 * The name field renders <NameCell item={ item }>{ link }</NameCell>.
 */
export { normalizeProduct, normalizeVariation, variationName, isNormalized, stripMeta } from './normalize';
export { flattenHierarchy, placeholderRow, placeholderMessage, projectedChildRows, EMPTY_CHILDREN } from './flatten';
export type { ChildrenState } from './flatten';
export {
	useHierarchy,
	getItemParentId,
	getItemHasChildren,
	getItemLevel,
	patchVariationRows,
	removeVariationRows,
	invalidateVariations,
	getChildrenState,
	subscribeChildren,
	subscribeExpandAllProgress,
	getExpandAllProgress,
	useExpandAllProgress,
	createLimiter,
	boundExpanded,
	parentsWithinRows,
	expandAllConfirmMessage,
	expansionSummary,
	EXPANDED_STORAGE_KEY,
	EXPAND_ALL_WARN_ROWS,
	EXPAND_ALL_MAX_ROWS,
	VARIATIONS_PER_PAGE,
	VARIATION_BASE_FIELDS,
} from './use-hierarchy';
export type { Hierarchy, HierarchyOptions, ExpandAllLimit, ExpandAllPlan, ExpandAllProgress, FetchVariations, VariationsResult } from './use-hierarchy';
export { HierarchyProvider, useHierarchyContext, useOptionalHierarchyContext, HierarchyViewProvider, useHierarchyView } from './context';
export type { HierarchyViewValue } from './context';
export { HierarchicalDataViews, withoutPlaceholderIds, isActionableRow } from './hierarchical-dataviews';
export type { HierarchicalDataViewsProps } from './hierarchical-dataviews';
export { Chevron, NameCell, rowDomId, ROW_ID_PREFIX } from './chevron';
export type { NameCellProps } from './chevron';
