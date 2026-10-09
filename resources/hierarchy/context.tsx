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
import { createContext, useCallback, useContext, useLayoutEffect, useState, useSyncExternalStore } from '@wordpress/element';
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
	/** A variation-level filter narrows the expanded parents ("3 of 15 variations match"). */
	variationFilterActive?: boolean;
	/** List every variation of one parent despite the filter. */
	onShowAllChildren?( parentId: number ): void;
	/** Narrow one parent to the matching variations again. */
	onShowMatchingChildren?( parentId: number ): void;
}

const HierarchyContext = createContext< Hierarchy | null >( null );
const HierarchyViewContext = createContext< HierarchyViewValue | null >( null );

/**
 * The same value as a store, for the cells DataViews renders once per row
 * (NameCell, Chevron): each subscribes to what its own row shows (is this
 * parent expanded, its children state, a search match), so expanding one
 * parent, or a slice of Expand all landing, re-renders the cells whose row
 * changed instead of every name cell on a 600-row page.
 */
interface HierarchyViewStore {
	get(): HierarchyViewValue | null;
	/** The expanded ids as a set, for O(1) lookups per row. */
	expanded(): ReadonlySet< number >;
	subscribe( listener: () => void ): () => void;
}

const EMPTY_SET: ReadonlySet< number > = new Set();

const NULL_STORE: HierarchyViewStore = {
	get: () => null,
	expanded: () => EMPTY_SET,
	subscribe: () => () => {},
};

const HierarchyViewStoreContext = createContext< HierarchyViewStore >( NULL_STORE );

function createViewStore( initial: HierarchyViewValue ): HierarchyViewStore & { set( value: HierarchyViewValue ): void; flush(): void } {
	let value = initial;
	let dirty = false;
	let expandedSource: number[] | null = null;
	let expandedSet: ReadonlySet< number > = EMPTY_SET;
	const listeners = new Set< () => void >();

	return {
		get: () => value,
		expanded: () => {
			if ( expandedSource !== value.expandedItemIds ) {
				expandedSource = value.expandedItemIds;
				expandedSet = new Set( value.expandedItemIds );
			}

			return expandedSet;
		},
		subscribe: ( listener ) => {
			listeners.add( listener );

			return () => {
				listeners.delete( listener );
			};
		},
		set: ( next ) => {
			if ( next !== value ) {
				value = next;
				dirty = true;
			}
		},
		flush: () => {
			if ( dirty ) {
				dirty = false;
				listeners.forEach( ( listener ) => listener() );
			}
		},
	};
}

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
	const [ store ] = useState( () => createViewStore( value ) );
	// Cells rendering in this pass (new rows) read the new value; the memoised
	// rows that do not render hear about it from the layout effect below.
	store.set( value );

	useLayoutEffect( () => {
		store.flush();
	} );

	return (
		<HierarchyViewStoreContext.Provider value={ store }>
			<HierarchyViewContext.Provider value={ value }>{ children }</HierarchyViewContext.Provider>
		</HierarchyViewStoreContext.Provider>
	);
}

/** What one row's name cell shows of the hierarchy; re-renders only when that changes. */
export interface HierarchyRowView {
	/** The whole value, read at render time (callbacks, getItemHasChildren); not a subscription. */
	view: HierarchyViewValue | null;
	expanded: boolean;
	state: ChildrenState | undefined;
	searchMatch: boolean;
	variationFilterActive: boolean;
}

/**
 * The hierarchy as one row (product or variation `id`) sees it, through
 * per-row subscriptions: a change elsewhere in the tree does not re-render
 * this row's cell.
 */
export function useHierarchyRowView( id: number ): HierarchyRowView {
	const store = useContext( HierarchyViewStoreContext );
	const subscribe = store.subscribe;
	const expanded = useSyncExternalStore( subscribe, useCallback( () => store.expanded().has( id ), [ store, id ] ) );
	const state = useSyncExternalStore( subscribe, useCallback( () => store.get()?.childrenState?.get( id ), [ store, id ] ) );
	const searchMatch = useSyncExternalStore( subscribe, useCallback( () => store.get()?.searchMatchIds?.has( id ) === true, [ store, id ] ) );
	const variationFilterActive = useSyncExternalStore( subscribe, useCallback( () => store.get()?.variationFilterActive === true, [ store ] ) );

	return { view: store.get(), expanded, state, searchMatch, variationFilterActive };
}

/** The current value at event time (a click handler of a cell that did not re-render). */
export function useHierarchyViewGetter(): () => HierarchyViewValue | null {
	return useContext( HierarchyViewStoreContext ).get;
}

/** Null when rendered outside HierarchicalDataViews. */
export function useHierarchyView(): HierarchyViewValue | null {
	return useContext( HierarchyViewContext );
}
