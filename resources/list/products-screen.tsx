/**
 * The Catalog screen: status tabs, the hierarchical DataViews table over
 * the current page of products, and the snackbar stack. Rows come from the
 * query cache (previous page stays visible while the next loads), the
 * hierarchy splices expanded variations in, actions come from actions/.
 * The selection lives in list/selection.ts and spans pages; DataViews sees
 * the page's part of it and its bulk actions are widened to the whole.
 *
 * Quick and bulk edit open in a slide-in panel beside the list
 * (edit/editor-panel.tsx), a split view: the list narrows and stays usable.
 * The screen owns the session (which row, or the bulk selection; the
 * bulk editor follows the live selection) in a store that only the panel
 * (EditorMount) renders from, and asks the editor's leave guard before a
 * view change swaps the rows under it, a collapse removes the edited
 * variation, or another editor opens. Opening, switching and closing the
 * editor re-render neither this screen nor the table.
 */
import { __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import useProductActions from '../actions';
import { realRows } from '../actions/context';
import { notify } from '../actions/notices';
import { initialTabFor } from '../actions/quick-edit';
import { ApiError } from '../api/errors';
import type { View } from '../dataviews';
import { EditorHostProvider } from '../edit/editor-context';
import type { EditorHost, LeaveGuard } from '../edit/editor-context';
import { markEditorOpen } from '../edit/editor-panel';
import { findEditedRow, viewChangesRows } from '../edit/editor-session';
import type { EditorSession } from '../edit/editor-session';
import { captureFocusOrigin } from '../edit/focus';
import type { FocusOrigin } from '../edit/focus';
import { rowDomId } from '../hierarchy/chevron';
import { HierarchyProvider } from '../hierarchy/context';
import { footerCountLabel } from '../hierarchy/footer-count';
import { HierarchicalDataViews } from '../hierarchy/hierarchical-dataviews';
import { useSearchReveal } from '../hierarchy/search-match';
import { EXPAND_ALL_MAX_ROWS, expandAllConfirmMessage, expansionSummary, getChildrenState, useExpandAllProgress, useHierarchy } from '../hierarchy/use-hierarchy';
import type { ExpandAllPlan, NextExpandPlan } from '../hierarchy/use-hierarchy';
import { useCounts, useProductList } from '../store/products';
import { setCurrentRows, setVisibleFieldIds } from '../store/rows';
import { useView } from '../store/view';
import type { StatusTabId } from './default-view';
import { getItemId, isProductRow } from '../types';
import type { ProductField, ProductListItem, ProductRow, Settings } from '../types';
import { Button, ErrorBoundary, Notice, Notices, Spinner } from '../ui';
import { ColumnsMenu } from './columns-menu';
import { DEFAULT_LAYOUTS, PER_PAGE_SIZES } from './default-view';
import { EmptyState } from './empty-state';
import { useSearchEcho } from './search-echo';
import { useSelection } from './selection';
import type { SelectionApi } from './selection';
import { useVariationFilter } from './variation-filter';
import { SelectionBar } from './selection-bar';
import { fromSplitView, toSplitView } from './split-view';
import { destructiveLast, usesMoreActionsMenu, withoutFooterBulk } from './more-actions';
import { StatusTabs } from './status-tabs';
import { withWholeSelection } from './whole-selection';
import type { WholeSelection } from './whole-selection';
import { SaveActivityBar } from './save-activity-bar';
import { isRowPending, useLockVersion } from '../store/save-activity';

export interface ProductsScreenProps {
	fields: ProductField[];
	settings: Settings;
}

const PANEL_ID = 'wc-products-list-panel';

const TABLE_ID = 'wc-products-list-table';

function getItemLevel( item: ProductListItem ): number {
	return item._level;
}

/**
 * What to tell the user when a list request failed while rows are still on
 * screen. Only a nonce the server refused twice (api/client.ts refreshes it
 * once) is an expired session; a 403 for anything else is the server's own
 * reason (a capability a shop manager lacks), never "session expired".
 */
export function listErrorMessage( error: Error ): { message: string; reload: boolean } {
	if ( error instanceof ApiError && error.code === 'rest_cookie_invalid_nonce' ) {
		return { message: __( 'Your session has expired. Reload the page to keep working.', 'wp-woocommerce-products-list' ), reload: true };
	}

	if ( error instanceof ApiError && error.isForbidden ) {
		return { message: error.message || __( 'You are not allowed to view these products.', 'wp-woocommerce-products-list' ), reload: false };
	}

	return { message: error.message || __( 'The products could not be loaded.', 'wp-woocommerce-products-list' ), reload: false };
}

/**
 * Where keyboard focus returns after a quick edit of `row` closes: the
 * row's place in the table body (its actions button, by position, since a
 * save or a refetch may re-render the row meanwhile), falling back to
 * whatever has focus now.
 */
export function focusOriginForRow( row: ProductListItem, doc: Document = document ): FocusOrigin {
	const origin = captureFocusOrigin( doc );
	const tr = doc.getElementById( rowDomId( row ) )?.closest( 'tr' ) ?? null;
	const body = tr?.parentElement;
	const rowIndex = tr && body ? Array.from( body.children ).indexOf( tr ) : -1;

	return rowIndex >= 0 ? { ...origin, rowIndex, label: null } : origin;
}

/** The "Expand next" button's label and its description (what happens to the products open now). */
export function expandNextLabels( next: NextExpandPlan, maxRows: number = EXPAND_ALL_MAX_ROWS ): { label: string; description: string } {
	const label = sprintf(
		/* translators: %d: number of products */
		_n( 'Expand next %d', 'Expand next %d', next.count, 'wp-woocommerce-products-list' ),
		next.count
	);
	const description =
		next.replaces > 0
			? sprintf(
					/* translators: 1: products that open, 2: products that collapse, 3: row limit */
					_n(
						'Expands the next %1$d product and collapses the %2$d expanded now, so the page stays under %3$d rows. Selected variations stay selected.',
						'Expands the next %1$d products and collapses the %2$d expanded now, so the page stays under %3$d rows. Selected variations stay selected.',
						next.count,
						'wp-woocommerce-products-list'
					),
					next.count,
					next.replaces,
					maxRows
			  )
			: sprintf(
					/* translators: %d: number of products */
					_n( 'Expands the next %d product.', 'Expands the next %d products.', next.count, 'wp-woocommerce-products-list' ),
					next.count
			  );

	return { label, description };
}

/**
 * "Expand all", and while it loads "Loading variations… 37 of 100". Reads
 * the progress from its own store so the counter re-renders this button,
 * never the table. When Expand all stopped at the row limit, "17 of 100
 * expanded" and "Expand next 49" follow it.
 */
export function ExpandAllButton( { onClick, summary, next, onExpandNext }: { onClick: () => void; summary?: { expanded: number; total: number } | null; next?: NextExpandPlan | null; onExpandNext?: () => void } ) {
	const progress = useExpandAllProgress();
	// After Expand all stopped at the row limit (or a few were opened by hand): "17 of 100 expanded" stays next to the button.
	const partial = ! progress && summary && summary.expanded > 0 && summary.expanded < summary.total ? summary : null;

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
			{ partial ? (
				<span className="wc-products-list__expand-progress wc-products-list__expand-summary">
					{ sprintf(
						/* translators: 1: expanded products, 2: expandable products on the page */
						__( '%1$d of %2$d expanded', 'wp-woocommerce-products-list' ),
						partial.expanded,
						partial.total
					) }
				</span>
			) : null }
			{ partial && next && onExpandNext ? <ExpandNextButton next={ next } onClick={ onExpandNext } /> : null }
		</>
	);
}

function ExpandNextButton( { next, onClick }: { next: NextExpandPlan; onClick: () => void } ) {
	const { label, description } = expandNextLabels( next );

	return (
		<Button size="compact" variant="tertiary" onClick={ onClick } description={ description } className="wc-products-list__expand-next">
			{ label }
		</Button>
	);
}

/** The screen's h1, like core admin screens: where a heading jump lands first. */
export function CatalogTitle() {
	return <h1 className="wp-heading-inline wc-products-list__title">{ __( 'All Products (New)', 'wp-woocommerce-products-list' ) }</h1>;
}

/** The keyboard shortcut to the bulk edit button: Alt+B (Option+B), from anywhere on the screen but the editor and text fields. */
export const BULK_EDIT_SHORTCUT = 'Alt+B';

export function isBulkEditShortcut( event: Pick< KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code' | 'key' > ): boolean {
	return event.altKey && ! event.ctrlKey && ! event.metaKey && ! event.shiftKey && ( event.code === 'KeyB' || event.key === 'b' || event.key === 'B' );
}

/**
 * Expand the page's variable products (as far as Expand all may) and add
 * their loaded variations, the ones the variation-level filters let
 * through, to the selection: "Colour: Black with wool" → every black
 * variation on the page, ready for Bulk edit, Disable or Trash.
 */
export async function selectMatchingVariations(
	parents: ProductRow[],
	hierarchy: { expandAll(): Promise< boolean >; isExpanded( id: number ): boolean },
	selection: Pick< SelectionApi, 'addRows' >,
	children: () => ReadonlyMap< number, { status: string; items: ProductListItem[] } > = getChildrenState
): Promise< number > {
	await hierarchy.expandAll();

	const state = children();
	const rows = parents
		.filter( ( parent ) => parent._hasChildren && hierarchy.isExpanded( parent.id ) )
		.flatMap( ( parent ) => {
			const entry = state.get( parent.id );

			return entry?.status === 'loaded' ? entry.items : [];
		} );

	selection.addRows( rows );

	return rows.length;
}

/** The open editor session, outside React state: the screen reads it in its guards, only EditorMount renders from it. */
export interface SessionStore {
	get(): EditorSession | null;
	set( next: EditorSession | null ): void;
	subscribe( listener: () => void ): () => void;
}

export function createSessionStore(): SessionStore {
	let current: EditorSession | null = null;
	const listeners = new Set< () => void >();

	return {
		get: () => current,
		set( next ) {
			if ( next === current ) {
				return;
			}

			current = next;
			listeners.forEach( ( listener ) => listener() );
		},
		subscribe( listener ) {
			listeners.add( listener );

			return () => listeners.delete( listener );
		},
	};
}

export interface EditorMountProps {
	store: SessionStore;
	fields: ProductField[];
	/** The rows on screen (a quick edit's row is looked up here). */
	rows: ProductListItem[];
	childrenState: ReturnType< typeof useHierarchy >[ 'childrenState' ];
	parents: ProductRow[];
	selected: Pick< SelectionApi, 'rows' | 'offPageCount' >;
	listTotal: number;
	advance( row: ProductListItem ): void;
	removeItem( id: number ): void;
	setGuard( guard: LeaveGuard | null ): void;
}

/**
 * The editor panel for the session in `store`: builds the EditorHost (the
 * edited row, or the live selection for a bulk edit) and closes a session
 * whose row left the list. A session change re-renders this and the
 * panel only, never the table.
 */
export function EditorMount( { store, fields, rows, childrenState, parents, selected, listTotal, advance, removeItem, setGuard }: EditorMountProps ) {
	const session = useSyncExternalStore( store.subscribe, store.get );
	// While the editor saves, a refetch or an emptied selection never unmounts it: the save reports into it.
	const [ busy, setBusyState ] = useState( false );
	const setBusy = useCallback( ( next: boolean ) => setBusyState( next ), [] );
	const close = useCallback( () => {
		setBusyState( false );
		store.set( null );
	}, [ store ] );

	useEffect( () => {
		if ( ! session ) {
			setBusyState( false );
		}
	}, [ session ] );

	// The edited row left the list (trashed, refetched away): the editor cannot stay; an emptied bulk selection has nothing to edit.
	// A variation whose parent is still refetching its rows is not gone yet, and a running save is never cut off.
	const lastEditedRef = useRef< ProductListItem | null >( null );
	useEffect( () => {
		if ( ! session || busy ) {
			return;
		}

		const found = session.mode === 'quick' ? findEditedRow( rows, session.id ) : undefined;

		if ( found ) {
			lastEditedRef.current = found;
		}

		const last = lastEditedRef.current;
		const parentId = session.mode === 'quick' && last?.id === session.id ? last._parentId : null;
		const reloading = parentId !== null && parents.some( ( parent ) => parent.id === parentId ) && childrenState.get( parentId )?.status !== 'loaded' && childrenState.get( parentId )?.status !== 'error';

		if ( session.mode === 'quick' && ! found && ! reloading ) {
			store.set( null );
			notify.info( __( 'The product being edited is no longer in the list; the quick edit was closed.', 'wp-woocommerce-products-list' ) );
		} else if ( session.mode === 'bulk' && selected.rows.length === 0 ) {
			store.set( null );
		}
	}, [ session, busy, rows, childrenState, parents, selected.rows.length, store ] );

	const editedRow = useMemo( () => ( session?.mode === 'quick' ? findEditedRow( rows, session.id ) : undefined ), [ session, rows ] );
	const items = useMemo( () => ( session?.mode === 'bulk' ? selected.rows : editedRow ? [ editedRow ] : [] ), [ session, selected.rows, editedRow ] );
	const host = useMemo< EditorHost | null >(
		() =>
			session
				? {
						session,
						fields,
						items,
						offPageCount: session.mode === 'bulk' ? selected.offPageCount : 0,
						// "Every product in the list": the selection is exactly this list (Select all), not a selection gathered across searches that happens to outnumber it.
						wholeList: session.mode === 'bulk' && selected.offPageCount > 0 && listTotal > 0 && selected.rows.length === listTotal && selected.rows.length > parents.length,
						close,
						advance,
						removeItem,
						setGuard,
						setBusy,
				  }
				: null,
		[ session, fields, items, selected.offPageCount, selected.rows.length, listTotal, parents.length, close, advance, removeItem, setGuard, setBusy ]
	);

	return <EditorHostProvider value={ host } />;
}

export function ProductsScreen( { fields, settings }: ProductsScreenProps ) {
	const { view, setView, tab, setTab, isModified, resetView } = useView( fields, settings );
	// A search the editor's guard refused is taken back out of the search box.
	const { shownView, reject: rejectViewChange } = useSearchEcho( view );
	const list = useProductList( view, tab, fields );
	const { counts } = useCounts();
	const parents = useMemo( () => list.items.filter( isProductRow ) as ProductRow[], [ list.items ] );
	// Variations are fetched with the visible columns' fields only, like the products.
	const visibleFields = useMemo( () => {
		const ids = new Set( [ ...( view.fields ?? [] ), view.titleField, view.mediaField, view.descriptionField ].filter( Boolean ) );

		return fields.filter( ( field ) => ids.has( field.id ) );
	}, [ fields, view.fields, view.titleField, view.mediaField, view.descriptionField ] );
	// Expand all asks in an in-page dialog, not window.confirm (which blocks the tab and every script on it).
	const [ expandConfirm, setExpandConfirm ] = useState< { plan: ExpandAllPlan; resolve: ( ok: boolean ) => void } | null >( null );
	const confirmExpandAll = useCallback( ( _rows: number, plan: ExpandAllPlan ) => new Promise< boolean >( ( resolve ) => setExpandConfirm( { plan, resolve } ) ), [] );
	const answerExpandAll = useCallback( ( ok: boolean ) => {
		setExpandConfirm( ( current ) => {
			current?.resolve( ok );

			return null;
		} );
	}, [] );
	// "Colour: Black", "Any variation: Out of stock": expanded parents list the matching variations only.
	const variationFilter = useVariationFilter( view, fields );
	const variationFilterSpec = useMemo( () => ( { key: variationFilter.key, params: variationFilter.params } ), [ variationFilter.key, variationFilter.params ] );
	const hierarchyOptions = useMemo( () => ( { confirmExpandAll, variationFilter: variationFilterSpec } ), [ confirmExpandAll, variationFilterSpec ] );
	const hierarchy = useHierarchy( parents, visibleFields, hierarchyOptions );
	// The selection spans pages, searches, filters and sorts; a status tab is another list.
	// A variation SKU / barcode search opens the parent at the matching variation.
	const searchMatchIds = useSearchReveal( {
		search: view.search,
		parents,
		rows: hierarchy.rows,
		isFetching: list.isFetching,
		isExpanded: hierarchy.isExpanded,
		expand: hierarchy.expand,
	} );
	const selected = useSelection( hierarchy.rows, tab );
	const { selection } = selected;

	// The editor panel: one session at a time, in a store of its own so that opening, switching and
	// closing it re-render the panel (EditorMount) and not this screen or its table. Its leave guard
	// (the discard confirm) is asked before the rows change under it.
	const [ sessionStore ] = useState( createSessionStore );
	const guardRef = useRef< LeaveGuard | null >( null );
	const viewRef = useRef( view );
	const selectedRef = useRef( selected );
	const rowsRef = useRef( hierarchy.rows );
	useLayoutEffect( () => {
		viewRef.current = view;
		selectedRef.current = selected;
		rowsRef.current = hierarchy.rows;
	} );
	const setGuard = useCallback( ( guard: LeaveGuard | null ) => {
		guardRef.current = guard;
	}, [] );
	/** Close the editor if it lets us (clean, or the user discards); false means it stays and the caller gives up. */
	const leaveEditor = useCallback( async (): Promise< boolean > => {
		if ( ! sessionStore.get() ) {
			return true;
		}

		const ok = guardRef.current ? await guardRef.current() : true;

		if ( ok ) {
			sessionStore.set( null );
		}

		return ok;
	}, [ sessionStore ] );
	const openEditor = useCallback(
		( items: ProductListItem[] ) => {
			const all = realRows( items );
			// Rows a save in flight has not written yet are locked: editing them now would race that save.
			const rows = all.filter( ( row ) => ! isRowPending( row.id ) && ! isRowPending( row.parent_id ) );

			if ( rows.length < all.length ) {
				notify.info(
					rows.length
						? __( 'Some selected rows are still being updated; they were left out.', 'wp-woocommerce-products-list' )
						: __( 'These rows are still being updated. Edit them once the update is done.', 'wp-woocommerce-products-list' )
				);
			}

			if ( ! rows.length ) {
				return;
			}

			markEditorOpen();

			void ( async () => {
				const current = sessionStore.get();

				if ( current?.mode === 'quick' && rows.length === 1 && current.id === rows[ 0 ]!.id ) {
					return;
				}

				// Switching: ask the open editor, then hand the panel the new session straight away. Closing
				// first (session null) would unmount the panel and restyle the whole list twice for nothing.
				if ( current && guardRef.current && ! ( await guardRef.current() ) ) {
					return;
				}

				const initialTab = initialTabFor( viewRef.current.filters as Array< { field: string; value?: unknown } > | undefined );

				if ( rows.length === 1 ) {
					sessionStore.set( { mode: 'quick', id: rows[ 0 ]!.id, initialTab, origin: focusOriginForRow( rows[ 0 ]! ) } );

					return;
				}

				// The bulk editor edits the selection: make it these rows.
				selectedRef.current.set( rows.map( getItemId ) );
				sessionStore.set( { mode: 'bulk', initialTab, origin: captureFocusOrigin() } );
			} )();
		},
		[ sessionStore ]
	);
	const advanceEditor = useCallback(
		( row: ProductListItem ) => {
			sessionStore.set( { mode: 'quick', id: row.id, initialTab: sessionStore.get()?.initialTab, origin: focusOriginForRow( row ) } );
		},
		[ sessionStore ]
	);
	const removeFromSelection = useCallback( ( id: number ) => {
		const current = selectedRef.current;

		current.set( current.selection.filter( ( entry ) => entry !== String( id ) ) );
	}, [] );

	// A view change that swaps the rows (page, search, sort, filters) first closes the editor; column and layout changes leave it open.
	const guardedSetView = useCallback(
		( next: View ) => {
			if ( ! sessionStore.get() || ! viewChangesRows( viewRef.current, next ) ) {
				setView( next );

				return;
			}

			void leaveEditor().then( ( ok ) => {
				if ( ok ) {
					setView( next );
				} else {
					rejectViewChange( next );
				}
			} );
		},
		[ setView, leaveEditor, rejectViewChange, sessionStore ]
	);
	// Split view: while the panel is open the table keeps name, SKU, price, stock and the translation
	// columns readable (list/split-view.ts); the saved view keeps every column. Re-renders on open and close only.
	const panelOpen = useSyncExternalStore( sessionStore.subscribe, () => sessionStore.get() !== null );
	const tableView = useMemo( () => ( panelOpen ? toSplitView( shownView ) : shownView ), [ panelOpen, shownView ] );
	const setTableView = useCallback( ( next: View ) => guardedSetView( sessionStore.get() ? fromSplitView( next, viewRef.current ) : next ), [ guardedSetView, sessionStore ] );
	const guardedSetTab = useCallback(
		( next: StatusTabId ) => {
			if ( ! sessionStore.get() ) {
				setTab( next );

				return;
			}

			void leaveEditor().then( ( ok ) => {
				if ( ok ) {
					setTab( next );
				}
			} );
		},
		[ setTab, leaveEditor, sessionStore ]
	);
	// Collapsing the parent of the variation being edited takes that row out of the list: ask first.
	const { onChangeExpandedItemIds } = hierarchy;
	const guardedSetExpanded = useCallback(
		( ids: number[] ) => {
			const current = sessionStore.get();
			const parentId = current?.mode === 'quick' ? findEditedRow( rowsRef.current, current.id )?._parentId : null;

			if ( ! parentId || ids.includes( parentId ) ) {
				onChangeExpandedItemIds( ids );

				return;
			}

			void leaveEditor().then( ( ok ) => {
				if ( ok ) {
					onChangeExpandedItemIds( ids );
				}
			} );
		},
		[ onChangeExpandedItemIds, leaveEditor, sessionStore ]
	);
	// "Expand next" may collapse the parent of the variation being edited: ask first, as for any collapse.
	const guardedExpandNext = useCallback( async () => {
		const current = sessionStore.get();
		const parentId = current?.mode === 'quick' ? findEditedRow( rowsRef.current, current.id )?._parentId : null;

		if ( parentId && hierarchy.nextExpand && hierarchy.nextExpand.replaces > 0 && ! ( await leaveEditor() ) ) {
			return;
		}

		await hierarchy.expandNext?.();
	}, [ hierarchy, leaveEditor, sessionStore ] );
	// Every way to collapse (the chevron, Collapse all, the row action) goes through the same guard.
	const guardedHierarchy = useMemo(
		() => ( {
			...hierarchy,
			onChangeExpandedItemIds: guardedSetExpanded,
			collapse: ( id: number ) => guardedSetExpanded( hierarchy.expandedItemIds.filter( ( other ) => other !== id ) ),
			collapseAll: () => guardedSetExpanded( [] ),
			toggle: ( id: number ) => ( hierarchy.expandedItemIds.includes( id ) ? guardedSetExpanded( hierarchy.expandedItemIds.filter( ( other ) => other !== id ) ) : hierarchy.toggle( id ) ),
		} ),
		[ hierarchy, guardedSetExpanded ]
	);

	const baseActions = useProductActions( { fields, settings, view, tab, hierarchy: guardedHierarchy, selection, onChangeSelection: selected.set, openEditor } );

	// DataViews' bulk actions see the page's selected rows; widen them to the
	// whole selection, read at call time (the actions list is built once).
	// "On page" is what DataViews can pass: the selected rows it shows. A
	// selected variation under a collapsed parent is not among them, so it
	// rides along with the other pages' rows (label and editor agree).
	const whole = useMemo< WholeSelection >( () => {
		const shown = new Set( hierarchy.rows.map( getItemId ) );
		const onPage = selection.filter( ( id ) => shown.has( id ) );

		return { onPage, offPage: selected.rows.filter( ( row ) => ! shown.has( getItemId( row ) ) ), onPageRows: selected.rows.filter( ( row ) => shown.has( getItemId( row ) ) ) };
	}, [ selection, selected.rows, hierarchy.rows ] );
	const wholeRef = useRef( whole );
	useLayoutEffect( () => {
		wholeRef.current = whole;
	} );
	// DataViews memoises a row's actions on [actions, item]: rebuilt when rows are locked or released, so a row rendered
	// while a save held it (and never written, e.g. held back for a clash) gets its edit actions back when the save ends.
	const lockVersion = useLockVersion();
	// Destructive actions (Move to Trash, Delete permanently) come last in row menus and the footer.
	// eslint-disable-next-line react-hooks/exhaustive-deps -- lockVersion only makes DataViews re-run isEligible (which reads the locks itself).
	const actions = useMemo( () => withWholeSelection( destructiveLast( baseActions ), () => wholeRef.current ), [ baseActions, lockVersion ] );
	// Split view, or rows selected on other pages: the footer keeps Bulk edit; the other bulk actions are in the selection
	// bar's "More actions" menu, which offers what fits the whole selection (the footer judges the page's rows only).
	const moreActionsMenu = usesMoreActionsMenu( panelOpen, selected.offPageCount );
	const tableActions = useMemo( () => ( moreActionsMenu ? withoutFooterBulk( actions ) : actions ), [ moreActionsMenu, actions ] );

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
	const clearQuery = useCallback( () => guardedSetView( { ...view, search: '', filters: [], page: 1 } as View ), [ guardedSetView, view ] );

	const hasExpandable = parents.some( ( item ) => item._hasChildren );

	// Alt+B from a row (or anywhere on the screen outside the editor and text fields) opens the editor on the selection.
	const canEditSelection = useMemo( () => actions.some( ( action ) => action.id === 'quick-edit' ), [ actions ] );
	useEffect( () => {
		const onKeyDown = ( event: KeyboardEvent ) => {
			if ( ! isBulkEditShortcut( event ) || ! canEditSelection ) {
				return;
			}

			const target = event.target as HTMLElement | null;
			const inField = target?.matches?.( 'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]' );

			const onScreen = target === document.body || Boolean( target?.closest?.( '.wc-products-list' ) );

			if ( inField || ! onScreen || target?.closest?.( '.wc-pl-editor-panel, [role="dialog"]' ) ) {
				return;
			}

			const rows = selectedRef.current.rows;

			if ( ! rows.length ) {
				return;
			}

			event.preventDefault();
			openEditor( rows );
		};

		document.addEventListener( 'keydown', onKeyDown );

		return () => document.removeEventListener( 'keydown', onKeyDown );
	}, [ canEditSelection, openEditor ] );

	const [ selectingMatching, setSelectingMatching ] = useState( false );
	const onSelectMatching = useCallback( () => {
		setSelectingMatching( true );
		void selectMatchingVariations( parents, hierarchy, selected )
			.then( ( count ) => {
				notify.info(
					sprintf(
						/* translators: %d: number of variations added to the selection */
						_n( '%d matching variation selected.', '%d matching variations selected.', count, 'wp-woocommerce-products-list' ),
						count
					)
				);
			} )
			.finally( () => setSelectingMatching( false ) );
	}, [ parents, hierarchy, selected ] );
	// No "0 products" before the first answer: the table shows its own loading state.
	const countLabel = useMemo(
		() => ( list.isLoading && ! hierarchy.rows.length ? __( 'Loading products…', 'wp-woocommerce-products-list' ) : footerCountLabel( { data: hierarchy.rows, selection: [], totalItems: list.total } ) ),
		[ hierarchy.rows, list.total, list.isLoading ]
	);
	const header = (
		<div className="wc-products-list__header">
			<span className="wc-products-list__count" aria-live="polite">
				{ countLabel }
			</span>
			{ list.isFetching && ! list.isLoading && <Spinner /> }
			<SelectionBar selection={ selected } total={ list.total } pageProducts={ parents.length } query={ list.query } actions={ actions } onEdit={ openEditor } shortcut={ BULK_EDIT_SHORTCUT } moreActions={ moreActionsMenu } />
			<ColumnsMenu fields={ fields } view={ view } onChangeView={ setView } settings={ settings } />
			{ hasExpandable && (
				<>
					<ExpandAllButton
						onClick={ () => void hierarchy.expandAll() }
						summary={ expansionSummary( parents, hierarchy.expandedItemIds ) }
						next={ hierarchy.nextExpand }
						onExpandNext={ hierarchy.expandNext ? () => void guardedExpandNext() : undefined }
					/>
					{ hierarchy.variationFilterActive && (
						<Button size="compact" variant="tertiary" onClick={ onSelectMatching } disabled={ selectingMatching } isBusy={ selectingMatching }>
							{ __( 'Select matching variations', 'wp-woocommerce-products-list' ) }
						</Button>
					) }
					<Button size="compact" variant="tertiary" onClick={ () => guardedHierarchy.collapseAll() } disabled={ hierarchy.expandedItemIds.length === 0 }>
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
		<HierarchyProvider value={ guardedHierarchy }>
				<div className={ `wc-products-list${ list.isFetching ? ' is-fetching' : '' }${ staleError ? ' is-stale' : '' }${ hasPageSelection ? ' has-footer' : '' }` }>
					<CatalogTitle />
					<a className="wc-products-list__skip screen-reader-text" href={ `#${ TABLE_ID }` }>
						{ __( 'Skip to products', 'wp-woocommerce-products-list' ) }
					</a>
					{ expandConfirm && (
						<ConfirmDialog onConfirm={ () => answerExpandAll( true ) } onCancel={ () => answerExpandAll( false ) } confirmButtonText={
							expandConfirm.plan.skipped > 0
								? sprintf(
									/* translators: %d: number of products */
									_n( 'Expand %d product', 'Expand %d products', expandConfirm.plan.expanding, 'wp-woocommerce-products-list' ),
									expandConfirm.plan.expanding
								)
								: __( 'Expand all', 'wp-woocommerce-products-list' )
						}>
							{ expandAllConfirmMessage( expandConfirm.plan ) }
						</ConfirmDialog>
					) }
					<StatusTabs tab={ tab } onChange={ guardedSetTab } counts={ counts } settings={ settings } panelId={ PANEL_ID } />
					<SaveActivityBar />
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
						<ErrorBoundary context="table">
						<HierarchicalDataViews
							data={ hierarchy.rows }
							fields={ fields }
							view={ tableView }
							onChangeView={ setTableView }
							actions={ tableActions }
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
							onChangeExpandedItemIds={ guardedSetExpanded }
							childrenState={ hierarchy.childrenState }
							onRetryChildren={ hierarchy.retry }
							searchMatchIds={ searchMatchIds }
							variationFilterActive={ hierarchy.variationFilterActive }
							onShowAllChildren={ hierarchy.showAllVariations }
							onShowMatchingChildren={ hierarchy.showMatchingVariations }
						/>
						</ErrorBoundary>
					</div>
					<Notices />
				</div>
			<EditorMount
				store={ sessionStore }
				fields={ fields }
				rows={ hierarchy.rows }
				childrenState={ hierarchy.childrenState }
				parents={ parents }
				selected={ selected }
				listTotal={ list.total }
				advance={ advanceEditor }
				removeItem={ removeFromSelection }
				setGuard={ setGuard }
			/>
		</HierarchyProvider>
	);
}

export default ProductsScreen;
