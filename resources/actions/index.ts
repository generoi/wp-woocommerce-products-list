/**
 * The actions the list offers, in menu order: core actions, then the
 * declarative ones from the settings payload (`POST /actions/{id}`), then
 * those registered through `window.wcProductsList.registerAction`, then
 * the `wcProductsList.actions` filter. Capability keys and scope are
 * enforced here so action files only state intent.
 */
import { useEffect, useMemo, useRef } from '@wordpress/element';
import { applyFilters } from '@wordpress/hooks';
import { runAction } from '../api/client';
import { getRegisteredActions, useRegistryVersion } from '../extensions/api';
import type { Hierarchy } from '../hierarchy/use-hierarchy';
import { actionsFromSettings } from '../extensions/declarative';
import { FILTERS } from '../extensions/hooks';
import { invalidateProducts, patchItems } from '../store/products';
import type { ProductAction, Settings } from '../types';
import type { ActionFactory, ProductActionsContext } from './context';
import { errorMessage, rowFields, summarize, withScope } from './context';
import { createDeleteAction } from './delete';
import { createDuplicateAction } from './duplicate';
import { createEditAction } from './edit';
import { createExpandAction } from './expand';
import { createFeatureAction, createUnfeatureAction } from './feature';
import { createHistoryAction } from './history';
import { notify } from './notices';
import { createQuickEditAction } from './quick-edit';
import { createRestoreAction } from './restore';
import { createSelectVariationsAction } from './select-variations';
import { createDisableVariationAction, createDraftAction, createEnableVariationAction, createPublishAction } from './status';
import { createTrashAction } from './trash';
import { createViewAction } from './view';

export type { ProductActionsContext } from './context';

const CORE: ActionFactory[] = [
	createQuickEditAction,
	createEditAction,
	createViewAction,
	createExpandAction,
	createSelectVariationsAction,
	createPublishAction,
	createDraftAction,
	createEnableVariationAction,
	createDisableVariationAction,
	createFeatureAction,
	createUnfeatureAction,
	createDuplicateAction,
	createHistoryAction,
	createRestoreAction,
	createTrashAction,
	createDeleteAction,
];

function allowed( action: ProductAction, settings: Settings ): boolean {
	if ( ! action.capability ) {
		return true;
	}

	return settings.caps[ action.capability as keyof Settings[ 'caps' ] ] === true;
}

/** Declarative (PHP) actions run on the server; returned rows refresh the cache. */
function declarativeActions( context: ProductActionsContext ): ProductAction[] {
	const fields = rowFields( context.fields );

	return actionsFromSettings( context.settings, async ( action, ids, args ) => {
		try {
			const response = await runAction( action, ids, args, { fields } );
			const { ok, failed } = summarize( response );

			if ( response.items.length ) {
				patchItems( response.items );
			}

			if ( failed.length ) {
				notify.error( failed[ 0 ]?.message ?? '' );
			} else if ( ok.length ) {
				invalidateProducts( { counts: true } );
			}

			return response;
		} catch ( error ) {
			notify.error( errorMessage( error ) );
			throw error;
		}
	} );
}

export function buildProductActions( context: ProductActionsContext ): ProductAction[] {
	const core = CORE.map( ( factory ) => factory( context ) ).filter( ( action ): action is ProductAction => action !== null );
	const all = [ ...core, ...declarativeActions( context ), ...getRegisteredActions() ];
	const filtered = applyFilters( FILTERS.actions, all, context.settings );
	const list = Array.isArray( filtered ) ? ( filtered as ProductAction[] ) : all;

	return list.filter( ( action ) => allowed( action, context.settings ) ).map( withScope );
}

/**
 * A hierarchy facade with a stable identity: `useHierarchy` returns a new
 * object every render, but the actions list must not be rebuilt on every
 * expand or selection change (DataViews re-renders its menus when it is).
 * Methods read the latest hierarchy at call time.
 */
function useStableHierarchy( hierarchy: Hierarchy ): Hierarchy {
	const ref = useRef( hierarchy );

	useEffect( () => {
		ref.current = hierarchy;
	} );

	return useMemo< Hierarchy >(
		() => ( {
			get rows() {
				return ref.current.rows;
			},
			get expandedItemIds() {
				return ref.current.expandedItemIds;
			},
			get childrenState() {
				return ref.current.childrenState;
			},
			onChangeExpandedItemIds: ( ids ) => ref.current.onChangeExpandedItemIds( ids ),
			isExpanded: ( id ) => ref.current.isExpanded( id ),
			toggle: ( id ) => ref.current.toggle( id ),
			expand: ( id ) => ref.current.expand( id ),
			collapse: ( id ) => ref.current.collapse( id ),
			retry: ( id ) => ref.current.retry( id ),
			expandAll: ( options ) => ref.current.expandAll( options ),
			collapseAll: () => ref.current.collapseAll(),
			getItemParentId: ( item ) => ref.current.getItemParentId( item ),
			getItemHasChildren: ( item ) => ref.current.getItemHasChildren( item ),
			getItemLevel: ( item ) => ref.current.getItemLevel( item ),
			childrenOf: ( parentId ) => ref.current.childrenOf( parentId ),
			variationIdsOf: ( ids ) => ref.current.variationIdsOf( ids ),
			selectVariations: ( parentId, current ) => ref.current.selectVariations( parentId, current ),
		} ),
		[]
	);
}

export function useProductActions( context: ProductActionsContext ): ProductAction[] {
	const version = useRegistryVersion();
	const { fields, settings, view, tab, selection, onChangeSelection } = context;
	const hierarchy = useStableHierarchy( context.hierarchy );
	const selectionRef = useRef( selection );
	const changeSelectionRef = useRef( onChangeSelection );
	const hasSelectionHandler = typeof onChangeSelection === 'function';

	useEffect( () => {
		selectionRef.current = selection;
		changeSelectionRef.current = onChangeSelection;
	} );

	return useMemo(
		() =>
			buildProductActions( {
				fields,
				settings,
				view,
				tab,
				hierarchy,
				get selection() {
					return selectionRef.current;
				},
				onChangeSelection: hasSelectionHandler ? ( ids ) => changeSelectionRef.current?.( ids ) : undefined,
			} ),
		// `version` re-derives the list when an extension registers an action after mount;
		// view and tab do not change what the actions do, selection is read through the ref.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ fields, settings, hierarchy, hasSelectionHandler, version ]
	);
}

export default useProductActions;
