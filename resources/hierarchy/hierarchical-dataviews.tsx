/**
 * DataViews 20 plus the hierarchy props of gutenberg#83316
 * (`getItemParentId`, `getItemHasChildren`, `expandedItemIds`,
 * `onChangeExpandedItemIds`). Published DataViews only knows `getItemLevel`
 * + `view.showLevels`, so this wrapper:
 *
 * - takes `data` already flattened by useHierarchy (parents, expanded
 *   children, placeholders), which is also what upstream expects once it
 *   hides collapsed descendants itself;
 * - wires `getItemLevel` from `_level` so `showLevels: true` works the day
 *   the chevron is dropped;
 * - keeps placeholder rows out of the selection (the header checkbox
 *   selects every row in `data`);
 * - disables DataViews' item click (a button inside the title link would be
 *   invalid HTML): the name field renders its own link;
 * - provides HierarchyViewContext for the name field's chevron.
 *
 * Migration: see docs/hierarchy-upstream.md.
 */
import { useCallback, useMemo } from '@wordpress/element';
import { DataViews } from '../dataviews';
import type { DataViewsProps } from '../dataviews';
import { isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import { HierarchyViewProvider } from './context';
import type { HierarchyViewValue } from './context';
import { getItemLevel as defaultGetItemLevel } from './use-hierarchy';

export type HierarchicalDataViewsProps = DataViewsProps< ProductListItem > & HierarchyViewValue;

const neverClickable = () => false;

/** Selection ids of placeholder rows look like "12:loading"; real ids are numeric. */
export function withoutPlaceholderIds( ids: string[] ): string[] {
	return ids.filter( ( id ) => ! id.includes( ':' ) );
}

export function HierarchicalDataViews( props: HierarchicalDataViewsProps ) {
	const {
		getItemParentId,
		getItemHasChildren,
		expandedItemIds,
		onChangeExpandedItemIds,
		childrenState,
		onRetryChildren,
		onChangeSelection,
		selection,
		getItemLevel = defaultGetItemLevel,
		isItemClickable = neverClickable,
		...dataViewsProps
	} = props;

	const viewValue = useMemo< HierarchyViewValue >(
		() => ( { getItemParentId, getItemHasChildren, expandedItemIds, onChangeExpandedItemIds, childrenState, onRetryChildren } ),
		[ getItemParentId, getItemHasChildren, expandedItemIds, onChangeExpandedItemIds, childrenState, onRetryChildren ]
	);

	const handleSelection = useCallback(
		( ids: string[] ) => {
			onChangeSelection?.( withoutPlaceholderIds( ids ) );
		},
		[ onChangeSelection ]
	);

	const cleanSelection = useMemo( () => ( selection ? withoutPlaceholderIds( selection ) : selection ), [ selection ] );

	return (
		<HierarchyViewProvider value={ viewValue }>
			<DataViews< ProductListItem >
				{ ...( dataViewsProps as DataViewsProps< ProductListItem > ) }
				getItemLevel={ getItemLevel }
				isItemClickable={ isItemClickable }
				selection={ cleanSelection }
				onChangeSelection={ onChangeSelection ? handleSelection : undefined }
			/>
		</HierarchyViewProvider>
	);
}

/** True for rows DataViews should not offer actions on. */
export function isActionableRow( item: ProductListItem ): boolean {
	return ! isPlaceholderRow( item );
}
