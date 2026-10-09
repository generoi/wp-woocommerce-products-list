/**
 * The Catalog screen: status tabs, the hierarchical DataViews table over
 * the current page of products, and the snackbar stack. Rows come from the
 * query cache (previous page stays visible while the next loads), the
 * hierarchy splices expanded variations in, actions come from actions/.
 * The selection lives in list/selection.ts and spans pages; DataViews sees
 * the page's part of it and its bulk actions are widened to the whole.
 *
 * The inline editor is a row of the table (edit/editor-rows.ts): the
 * screen owns the session (which row, or the bulk selection), splices the
 * editor row into the data, and asks the editor's leave guard before a
 * view change swaps the rows under it, a collapse removes the edited
 * variation, or another editor opens.
 */
import { __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import useProductActions from '../actions';
import { realRows } from '../actions/context';
import { notify } from '../actions/notices';
import { initialTabFor } from '../actions/quick-edit';
import { ApiError } from '../api/errors';
import type { View } from '../dataviews';
import { EditorHostProvider } from '../edit/editor-context';
import type { EditorHost, LeaveGuard } from '../edit/editor-context';
import { findEditedRow, viewChangesRows, withEditorRow } from '../edit/editor-rows';
import type { EditorSession } from '../edit/editor-rows';
import { captureFocusOrigin } from '../edit/focus';
import type { FocusOrigin } from '../edit/focus';
import { rowDomId } from '../hierarchy/chevron';
import { HierarchyProvider } from '../hierarchy/context';
import { footerCountLabel } from '../hierarchy/footer-count';
import { HierarchicalDataViews } from '../hierarchy/hierarchical-dataviews';
import { useSearchReveal } from '../hierarchy/search-match';
import { useExpandAllProgress, useHierarchy } from '../hierarchy/use-hierarchy';
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
 * row's place in the table body (its actions button, by position, since the
 * row itself is replaced while the editor is up), falling back to whatever
 * has focus now.
 */
export function focusOriginForRow( row: ProductListItem, doc: Document = document ): FocusOrigin {
	const origin = captureFocusOrigin( doc );
	const tr = doc.getElementById( rowDomId( row ) )?.closest( 'tr' ) ?? null;
	const body = tr?.parentElement;
	const rowIndex = tr && body ? Array.from( body.children ).indexOf( tr ) : -1;

	return rowIndex >= 0 ? { ...origin, rowIndex, label: null } : origin;
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
	// Expand all asks in an in-page dialog, not window.confirm (which blocks the tab and every script on it).
	const [ expandConfirm, setExpandConfirm ] = useState< { rows: number; resolve: ( ok: boolean ) => void } | null >( null );
	const confirmExpandAll = useCallback( ( rows: number ) => new Promise< boolean >( ( resolve ) => setExpandConfirm( { rows, resolve } ) ), [] );
	const answerExpandAll = useCallback( ( ok: boolean ) => {
		setExpandConfirm( ( current ) => {
			current?.resolve( ok );

			return null;
		} );
	}, [] );
	const hierarchyOptions = useMemo( () => ( { confirmExpandAll } ), [ confirmExpandAll ] );
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

	// The inline editor: one session at a time; its leave guard (the discard confirm) is asked before the rows change under it.
	const [ session, setSession ] = useState< EditorSession | null >( null );
	const sessionRef = useRef( session );
	const guardRef = useRef< LeaveGuard | null >( null );
	const viewRef = useRef( view );
	const selectedRef = useRef( selected );
	const rowsRef = useRef( hierarchy.rows );
	useLayoutEffect( () => {
		sessionRef.current = session;
		viewRef.current = view;
		selectedRef.current = selected;
		rowsRef.current = hierarchy.rows;
	} );
	const setGuard = useCallback( ( guard: LeaveGuard | null ) => {
		guardRef.current = guard;
	}, [] );
	// While the editor saves, a refetch or an emptied selection never unmounts it: the save reports into it.
	const [ editorBusy, setEditorBusy ] = useState( false );
	const setBusy = useCallback( ( busy: boolean ) => setEditorBusy( busy ), [] );
	const closeEditor = useCallback( () => {
		setEditorBusy( false );
		setSession( null );
	}, [] );
	/** Close the editor if it lets us (clean, or the user discards); false means it stays and the caller gives up. */
	const leaveEditor = useCallback( async (): Promise< boolean > => {
		if ( ! sessionRef.current ) {
			return true;
		}

		const ok = guardRef.current ? await guardRef.current() : true;

		if ( ok ) {
			setSession( null );
		}

		return ok;
	}, [] );
	const openEditor = useCallback(
		( items: ProductListItem[] ) => {
			const rows = realRows( items );

			if ( ! rows.length ) {
				return;
			}

			void ( async () => {
				const current = sessionRef.current;

				if ( current?.mode === 'quick' && rows.length === 1 && current.id === rows[ 0 ]!.id ) {
					return;
				}

				if ( current && ! ( await leaveEditor() ) ) {
					return;
				}

				const initialTab = initialTabFor( viewRef.current.filters as Array< { field: string; value?: unknown } > | undefined );

				if ( rows.length === 1 ) {
					setSession( { mode: 'quick', id: rows[ 0 ]!.id, initialTab, origin: focusOriginForRow( rows[ 0 ]! ) } );

					return;
				}

				// The bulk editor edits the selection: make it these rows.
				selectedRef.current.set( rows.map( getItemId ) );
				setSession( { mode: 'bulk', initialTab, origin: captureFocusOrigin() } );
			} )();
		},
		[ leaveEditor ]
	);
	const advanceEditor = useCallback( ( row: ProductListItem ) => {
		setSession( { mode: 'quick', id: row.id, initialTab: sessionRef.current?.initialTab, origin: focusOriginForRow( row ) } );
	}, [] );
	const removeFromSelection = useCallback( ( id: number ) => {
		const current = selectedRef.current;

		current.set( current.selection.filter( ( entry ) => entry !== String( id ) ) );
	}, [] );

	// A view change that swaps the rows (page, search, sort, filters) first closes the editor; column and layout changes leave it.
	const guardedSetView = useCallback(
		( next: View ) => {
			if ( ! sessionRef.current || ! viewChangesRows( viewRef.current, next ) ) {
				setView( next );

				return;
			}

			void leaveEditor().then( ( ok ) => {
				if ( ok ) {
					setView( next );
				}
			} );
		},
		[ setView, leaveEditor ]
	);
	const guardedSetTab = useCallback(
		( next: StatusTabId ) => {
			if ( ! sessionRef.current ) {
				setTab( next );

				return;
			}

			void leaveEditor().then( ( ok ) => {
				if ( ok ) {
					setTab( next );
				}
			} );
		},
		[ setTab, leaveEditor ]
	);
	// Collapsing the parent of the variation being edited takes the editor row with it: ask first.
	const { onChangeExpandedItemIds } = hierarchy;
	const guardedSetExpanded = useCallback(
		( ids: number[] ) => {
			const current = sessionRef.current;
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
		[ onChangeExpandedItemIds, leaveEditor ]
	);
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

	// The edited row left the list (trashed, refetched away): the editor cannot stay; an emptied bulk selection has nothing to edit.
	// A variation whose parent is still refetching its rows is not gone yet, and a running save is never cut off.
	const lastEditedRef = useRef< ProductListItem | null >( null );
	useEffect( () => {
		if ( ! session || editorBusy ) {
			return;
		}

		const found = session.mode === 'quick' ? findEditedRow( hierarchy.rows, session.id ) : undefined;

		if ( found ) {
			lastEditedRef.current = found;
		}

		const last = lastEditedRef.current;
		const parentId = session.mode === 'quick' && last?.id === session.id ? last._parentId : null;
		const reloading = parentId !== null && parents.some( ( parent ) => parent.id === parentId ) && hierarchy.childrenState.get( parentId )?.status !== 'loaded' && hierarchy.childrenState.get( parentId )?.status !== 'error';

		if ( session.mode === 'quick' && ! found && ! reloading ) {
			setSession( null );
			notify.info( __( 'The product being edited is no longer in the list; the quick edit was closed.', 'wp-woocommerce-products-list' ) );
		} else if ( session.mode === 'bulk' && selected.rows.length === 0 ) {
			setSession( null );
		}
	}, [ session, editorBusy, hierarchy.rows, hierarchy.childrenState, parents, selected.rows.length ] );

	const baseActions = useProductActions( { fields, settings, view, tab, hierarchy: guardedHierarchy, selection, onChangeSelection: selected.set, openEditor } );

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
	const clearQuery = useCallback( () => guardedSetView( { ...view, search: '', filters: [], page: 1 } as View ), [ guardedSetView, view ] );

	// What DataViews renders: the rows with the editor row spliced in.
	const data = useMemo( () => withEditorRow( hierarchy.rows, session ), [ hierarchy.rows, session ] );
	const editedRow = useMemo( () => ( session?.mode === 'quick' ? findEditedRow( hierarchy.rows, session.id ) : undefined ), [ session, hierarchy.rows ] );
	const editorItems = useMemo( () => ( session?.mode === 'bulk' ? selected.rows : editedRow ? [ editedRow ] : [] ), [ session, selected.rows, editedRow ] );
	const host = useMemo< EditorHost | null >(
		() =>
			session
				? {
						session,
						fields,
						items: editorItems,
						offPageCount: session.mode === 'bulk' ? selected.offPageCount : 0,
						// "Every product in the list": the selection is exactly this list (Select all), not a selection gathered across searches that happens to outnumber it.
						wholeList: session.mode === 'bulk' && selected.offPageCount > 0 && list.total > 0 && selected.rows.length === list.total && selected.rows.length > parents.length,
						close: closeEditor,
						advance: advanceEditor,
						removeItem: removeFromSelection,
						setGuard,
						setBusy,
				  }
				: null,
		[ session, fields, editorItems, selected.offPageCount, selected.rows.length, list.total, parents.length, closeEditor, advanceEditor, removeFromSelection, setGuard, setBusy ]
	);

	const hasExpandable = parents.some( ( item ) => item._hasChildren );
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
			<SelectionBar selection={ selected } total={ list.total } pageProducts={ parents.length } query={ list.query } actions={ actions } onEdit={ openEditor } />
			<ColumnsMenu fields={ fields } view={ view } onChangeView={ setView } settings={ settings } />
			{ hasExpandable && (
				<>
					<ExpandAllButton onClick={ () => void hierarchy.expandAll() } />
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
			<EditorHostProvider value={ host }>
				<div className={ `wc-products-list${ list.isFetching ? ' is-fetching' : '' }${ staleError ? ' is-stale' : '' }${ hasPageSelection ? ' has-footer' : '' }${ session ? ' has-editor' : '' }` }>
					<a className="wc-products-list__skip screen-reader-text" href={ `#${ TABLE_ID }` }>
						{ __( 'Skip to products', 'wp-woocommerce-products-list' ) }
					</a>
					{ expandConfirm && (
						<ConfirmDialog onConfirm={ () => answerExpandAll( true ) } onCancel={ () => answerExpandAll( false ) } confirmButtonText={ __( 'Expand all', 'wp-woocommerce-products-list' ) }>
							{ sprintf(
								/* translators: %d: number of rows */
								__( 'This will show about %d rows on one page, which makes the table slow to render and scroll. Continue? (A smaller page size or a filter keeps it fast.)', 'wp-woocommerce-products-list' ),
								expandConfirm.rows
							) }
						</ConfirmDialog>
					) }
					<StatusTabs tab={ tab } onChange={ guardedSetTab } counts={ counts } settings={ settings } panelId={ PANEL_ID } />
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
							data={ data }
							fields={ fields }
							view={ view }
							onChangeView={ guardedSetView }
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
							onChangeExpandedItemIds={ guardedSetExpanded }
							childrenState={ hierarchy.childrenState }
							onRetryChildren={ hierarchy.retry }
							searchMatchIds={ searchMatchIds }
						/>
						</ErrorBoundary>
					</div>
					<Notices />
				</div>
			</EditorHostProvider>
		</HierarchyProvider>
	);
}

export default ProductsScreen;
