/**
 * Two contexts, two audiences:
 *
 * - HierarchyViewContext is what HierarchicalDataViews provides to whatever
 *   renders inside DataViews (the name field's chevron): the #83316 props
 *   plus the children state. When upstream DataViews ships hierarchy, this
 *   context and the chevron go away together.
 * - HierarchyContext is the full useHierarchy value (expandAll, retry,
 *   variationIdsOf, selectVariations) for the toolbar, actions and bulk
 *   edit, provided by HierarchyProvider around the screen.
 */
import { createContext, useContext } from '@wordpress/element';
import type { ReactNode } from 'react';
import type { ProductListItem } from '../types/product';
import type { ChildrenState } from './flatten';
import type { Hierarchy } from './use-hierarchy';

export interface HierarchyViewValue {
	getItemParentId( item: ProductListItem ): number | null;
	getItemHasChildren( item: ProductListItem ): boolean;
	expandedItemIds: number[];
	onChangeExpandedItemIds( ids: number[] ): void;
	childrenState?: ReadonlyMap< number, ChildrenState >;
	/** Reload one parent's children after an error. */
	onRetryChildren?( parentId: number ): void;
	/** Variation rows the current search matched by SKU (hierarchy/search-match.ts). */
	searchMatchIds?: ReadonlySet< number >;
}

const HierarchyContext = createContext< Hierarchy | null >( null );
const HierarchyViewContext = createContext< HierarchyViewValue | null >( null );

export function HierarchyProvider( { value, children }: { value: Hierarchy; children: ReactNode } ) {
	return <HierarchyContext.Provider value={ value }>{ children }</HierarchyContext.Provider>;
}

export function useHierarchyContext(): Hierarchy {
	const value = useContext( HierarchyContext );

	if ( ! value ) {
		throw new Error( 'useHierarchyContext() needs a <HierarchyProvider> above it.' );
	}

	return value;
}

/** Null outside a provider, so a field can render without the hierarchy (tests, grid previews). */
export function useOptionalHierarchyContext(): Hierarchy | null {
	return useContext( HierarchyContext );
}

export function HierarchyViewProvider( { value, children }: { value: HierarchyViewValue; children: ReactNode } ) {
	return <HierarchyViewContext.Provider value={ value }>{ children }</HierarchyViewContext.Provider>;
}

/** Null when rendered outside HierarchicalDataViews. */
export function useHierarchyView(): HierarchyViewValue | null {
	return useContext( HierarchyViewContext );
}
