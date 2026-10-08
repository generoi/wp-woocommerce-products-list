/**
 * The actions the list offers, in menu order: core actions, then the
 * declarative ones from the settings payload (`POST /actions/{id}`), then
 * those registered through `window.wcProductsList.registerAction`, then
 * the `wcProductsList.actions` filter. Capability keys and scope are
 * enforced here so action files only state intent.
 */
import { useEffect, useMemo, useRef } from '@wordpress/element';
import { applyFilters } from '@wordpress/hooks';
import { __, _n, sprintf } from '@wordpress/i18n';
import { runAction } from '../api/client';
import type { ActionResponse, ActionResult } from '../api/client';
import { isEditorHostedAction } from '../edit/hosted-actions';
import { undoBatch } from '../edit/undo';
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
import { createSelectOutOfStockVariationsAction, createSelectVariationsAction } from './select-variations';
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
	createSelectOutOfStockVariationsAction,
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

/** Fields the handler changed on one ok result; an older PHP side without `changed` counts as a change, so Undo is still offered. */
function changedFields( result: ActionResult ): number {
	return typeof result.changed === 'number' ? result.changed : 1;
}

/** "Copy translations: 2 items updated, 1 already had these values." */
export function declarativeSummary( label: string, changed: number, unchanged: number ): string {
	let summary: string;

	if ( changed === 0 ) {
		summary = sprintf(
			/* translators: %d: number of items the action left as they were */
			_n( 'nothing changed, %d item already had these values.', 'nothing changed, %d items already had these values.', unchanged, 'wp-woocommerce-products-list' ),
			unchanged
		);
	} else if ( unchanged === 0 ) {
		summary = sprintf(
			/* translators: %d: number of items updated */
			_n( '%d item updated.', '%d items updated.', changed, 'wp-woocommerce-products-list' ),
			changed
		);
	} else {
		summary = sprintf(
			/* translators: 1: items updated, 2: items the action left as they were */
			__( '%1$d updated, %2$d already had these values.', 'wp-woocommerce-products-list' ),
			changed,
			unchanged
		);
	}

	/* translators: 1: action label, 2: what happened ("2 items updated.") */
	return sprintf( __( '%1$s: %2$s', 'wp-woocommerce-products-list' ), label, summary );
}

/**
 * Runs a declarative (PHP) action on the server and reports it like a bulk
 * save: the returned rows patch the cache, the counts refresh, a snackbar
 * says how many items changed and offers Undo (the log's revert of the
 * action's batch), and a failure names the first error. Rejects on a
 * request error so the action's modal can stay open and show it.
 */
export async function runDeclarativeAction( action: string, label: string, ids: number[], args: Record< string, unknown >, fields: string[] ): Promise< ActionResponse > {
	let response: ActionResponse;

	try {
		response = await runAction( action, ids, args, { fields } );
	} catch ( error ) {
		notify.error( errorMessage( error ) );
		throw error;
	}

	const { ok, failed } = summarize( response );

	if ( response.items.length ) {
		patchItems( response.items );
	}

	if ( ok.length ) {
		invalidateProducts( { counts: true } );
	}

	if ( failed.length ) {
		notify.error(
			ok.length
				? sprintf(
						/* translators: 1: items updated, 2: items that failed, 3: the first failure's message */
						__( '%1$d updated, %2$d failed: %3$s', 'wp-woocommerce-products-list' ),
						ok.length,
						failed.length,
						failed[ 0 ]?.message ?? ''
				  )
				: failed[ 0 ]?.message ?? ''
		);

		return response;
	}

	if ( ! ok.length ) {
		return response;
	}

	const changed = response.results.filter( ( result ) => result.ok && changedFields( result ) > 0 ).length;
	const id = `wc-pl-action-${ response.batch_id }`;

	notify.success(
		declarativeSummary( label, changed, ok.length - changed ),
		changed > 0
			? {
					id,
					actions: [
						{
							label: __( 'Undo', 'wp-woocommerce-products-list' ),
							onClick: () => {
								notify.remove( id );
								void undoBatch( response.batch_id );
							},
						},
					],
			  }
			: { id }
	);

	return response;
}

/** Declarative (PHP) actions run on the server; returned rows refresh the cache, a snackbar with Undo reports the outcome. */
function declarativeActions( context: ProductActionsContext ): ProductAction[] {
	const fields = rowFields( context.fields );
	const labels = new Map( context.settings.actions.map( ( def ) => [ def.id, def.label || def.id ] ) );

	// Per-language tools (copy / clear a language) run inline in the editor's language tab, not from a dialog.
	const hosted = new Set( context.openEditor ? context.settings.actions.filter( isEditorHostedAction ).map( ( def ) => def.id ) : [] );

	return actionsFromSettings( context.settings, ( action, ids, args ) => runDeclarativeAction( action, labels.get( action ) ?? action, ids, args, fields ) ).filter( ( action ) => ! hosted.has( action.id ) );
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
			selectVariations: ( parentId, current, where ) => ref.current.selectVariations( parentId, current, where ),
		} ),
		[]
	);
}

export function useProductActions( context: ProductActionsContext ): ProductAction[] {
	const version = useRegistryVersion();
	const { fields, settings, view, tab, selection, onChangeSelection, openEditor } = context;
	const hierarchy = useStableHierarchy( context.hierarchy );
	const selectionRef = useRef( selection );
	const viewRef = useRef( view );
	const changeSelectionRef = useRef( onChangeSelection );
	const openEditorRef = useRef( openEditor );
	const hasSelectionHandler = typeof onChangeSelection === 'function';
	const hasEditor = typeof openEditor === 'function';

	useEffect( () => {
		selectionRef.current = selection;
		viewRef.current = view;
		changeSelectionRef.current = onChangeSelection;
		openEditorRef.current = openEditor;
	} );

	return useMemo(
		() =>
			buildProductActions( {
				fields,
				settings,
				// Read at call time too: the quick edit opens on the tab the current filter points at.
				get view() {
					return viewRef.current;
				},
				tab,
				hierarchy,
				get selection() {
					return selectionRef.current;
				},
				onChangeSelection: hasSelectionHandler ? ( ids ) => changeSelectionRef.current?.( ids ) : undefined,
				openEditor: hasEditor ? ( items ) => openEditorRef.current?.( items ) : undefined,
			} ),
		// `version` re-derives the list when an extension registers an action after mount;
		// view and tab do not change what the actions do, selection and the editor are read through refs.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ fields, settings, hierarchy, hasSelectionHandler, hasEditor, version ]
	);
}

export default useProductActions;
