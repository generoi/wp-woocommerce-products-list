/**
 * Where quick edit and bulk edit happen: a panel that slides in on the
 * right, beside the list, like the product editor of WooCommerce's
 * DataViews products app and the site editor's side panels. The Catalog
 * becomes a split view [list | panel]: the list narrows by the panel's
 * width (one reflow; only the panel animates) and stays fully usable,
 * scrolling, ticking, expanding, paging, while the panel is open. Below
 * 960 px the panel lies over the list as a drawer, still without a
 * backdrop.
 *
 * - Non-modal: an `<aside role="region">` named "Quick edit: Blue boots" /
 *   "Bulk edit: 12 items", no focus trap. F6 (or the "Back to the list"
 *   link at its top) moves focus between the list and the panel; Escape
 *   in the panel closes it (after the discard confirm when something was
 *   typed), as do the X and Cancel.
 * - The header (title, close) is pinned; the body scrolls on its own; the
 *   editor's Update / Cancel / Update & next footer sticks to its foot.
 * - Wide: it opens at about half the window (52 %), so the form has room
 *   for its columns. Drag the left edge or use the arrow keys on it to
 *   resize it between 480 px and 75 % of the window (always leaving the
 *   list some room); the share of the window is remembered in the user's
 *   preferences. Its right edge is the window's (fixed, `right: 0`), so it
 *   never runs off screen, whatever the admin menu's state.
 * - The quick-edited row is highlighted in the list (a `data-wc-pl-edited`
 *   attribute on the row element, so no row re-renders) and scrolled into view when it is off
 *   screen; Update & next moves the highlight with the editor.
 * - Each session mounts its own editor (another row, another bulk edit)
 *   without sliding the panel out and in again.
 * - The editor chunk loads on first use; the panel itself is in the main
 *   bundle so it shows at once with a loading line.
 */
import { Button, Notice, Spinner } from '@wordpress/components';
import { dispatch, select } from '@wordpress/data';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { __, _n, sprintf } from '@wordpress/i18n';
import { close as closeIcon } from '@wordpress/icons';
import { store as preferencesStore } from '@wordpress/preferences';
import { ROW_ID_PREFIX } from '../hierarchy/chevron';
import { PREFERENCES_SCOPE } from '../store/view';
import { ErrorBoundary } from '../ui/error-boundary';
import type { EditorHost, LeaveGuard } from './editor-context';

/** On <html> while the panel is open (plus `is-quick-edit` / `is-bulk-edit`). */
export const PANEL_OPEN_CLASS = 'wc-pl-panel-open';

/** On <html> while the panel's edge is dragged: the list keeps its width until the drag ends. */
export const PANEL_RESIZING_CLASS = 'wc-pl-panel-resizing';

/**
 * The user's panel width, as a share of the window (0.52 = 52 %), in
 * `wc-products-list` preferences. A share rather than pixels, so the
 * panel keeps its proportion on a laptop and on a wide monitor.
 */
export const PANEL_WIDTH_PREFERENCE = 'editorPanelShare';

/** The share of the window the panel opens at. */
export const PANEL_DEFAULT_SHARE = 0.52;
export const PANEL_MIN_WIDTH = 480;
/**
 * The panel opens at least this wide (within its limits) until the user picks a width: wide enough for the form's
 * side column (Status, Categories) on a 1280-1440 px laptop, where 52 % alone gives one long column.
 */
export const PANEL_DEFAULT_MIN_WIDTH = 880;
/** At most this share of the window. */
export const PANEL_MAX_SHARE = 0.75;
/** The list keeps at least this much room left of the panel (split view). */
export const LIST_MIN_WIDTH = 320;
/** Below this window width the panel covers the window as a drawer (edit/style.scss). */
export const PANEL_DRAWER_BELOW = 960;
/** Arrow keys on the resize handle move it by this much (four times with Shift). */
export const PANEL_KEY_STEP = 16;

/** The list's table anchor (list/products-screen.tsx): where F6 lands when nothing better is there. */
const TABLE_ANCHOR_ID = 'wc-products-list-table';

const FIRST_FIELD = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

const InlineEditor = lazy( () => import( /* webpackChunkName: "edit" */ './inline-editor' ) );

/** The accessible name of the panel: "Quick edit: Blue boots" / "Bulk edit: 12 items". */
export function editorRegionLabel( host: Pick< EditorHost, 'session' | 'items' > ): string {
	if ( host.session.mode === 'bulk' ) {
		/* translators: %d: number of rows */
		return sprintf( _n( 'Bulk edit: %d item', 'Bulk edit: %d items', host.items.length, 'wp-woocommerce-products-list' ), host.items.length );
	}

	/* translators: %s: product name */
	return sprintf( __( 'Quick edit: %s', 'wp-woocommerce-products-list' ), nameOfFirst( host.items ) );
}

function nameOfFirst( items: EditorHost[ 'items' ] ): string {
	const row = items[ 0 ];

	return ( row as { name?: string } | undefined )?.name || ( row ? `#${ row.id }` : '' );
}

let sessionCounter = 0;
const sessionKeys = new WeakMap< object, number >();

/** A key per editor session: a new session (another row, a new bulk edit) mounts a new editor, a re-render of the same one does not. */
export function sessionKey( session: object ): number {
	let key = sessionKeys.get( session );

	if ( key === undefined ) {
		key = ++sessionCounter;
		sessionKeys.set( session, key );
	}

	return key;
}

/** The window's width without its scrollbar: what a fixed panel at `right: 0` can use. */
export function viewportWidth(): number {
	return document.documentElement.clientWidth || window.innerWidth;
}

/** Where the content area starts: right of the admin menu (expanded, folded or hidden). */
function contentLeft(): number {
	const content = document.getElementById( 'wpcontent' );

	return content ? Math.max( 0, content.getBoundingClientRect().left ) : 0;
}

/**
 * The widest the panel may be in a window this wide: 75 % of it, and
 * never so wide that the list right of the admin menu gets less than
 * LIST_MIN_WIDTH; never below the minimum either. Below the drawer
 * breakpoint the panel takes the whole window.
 */
export function maxPanelWidth( viewport: number = viewportWidth(), left: number = contentLeft() ): number {
	if ( viewport < PANEL_DRAWER_BELOW ) {
		return viewport;
	}

	return Math.max( PANEL_MIN_WIDTH, Math.min( Math.floor( viewport * PANEL_MAX_SHARE ), Math.floor( viewport - left - LIST_MIN_WIDTH ) ) );
}

/** The narrowest the panel may be: PANEL_MIN_WIDTH, or the whole window when that is narrower still. */
export function minPanelWidth( viewport: number = viewportWidth() ): number {
	return viewport < PANEL_DRAWER_BELOW ? viewport : Math.min( PANEL_MIN_WIDTH, viewport );
}

/** A width within the panel's limits (whole pixels). */
export function clampPanelWidth( width: number, viewport: number = viewportWidth(), left: number = contentLeft() ): number {
	const value = Number.isFinite( width ) ? width : viewport * PANEL_DEFAULT_SHARE;

	return Math.round( Math.min( maxPanelWidth( viewport, left ), Math.max( minPanelWidth( viewport ), value ) ) );
}

/** The share of the window the user left the panel at, if they moved its edge. */
function rememberedPanelShare(): number | null {
	let stored: unknown;

	try {
		stored = select( preferencesStore ).get( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE );
	} catch {
		stored = undefined;
	}

	return typeof stored === 'number' && stored > 0 && stored < 1 ? stored : null;
}

/** The width the panel opens at before the user picks one: 52 % of the window, at least PANEL_DEFAULT_MIN_WIDTH, within the limits. */
export function defaultPanelWidth( viewport: number = viewportWidth(), left: number = contentLeft() ): number {
	return clampPanelWidth( Math.max( PANEL_DEFAULT_SHARE * viewport, PANEL_DEFAULT_MIN_WIDTH ), viewport, left );
}

/** The share of the window the user left the panel at, else the default (52 %). */
export function storedPanelShare(): number {
	let stored: unknown;

	try {
		stored = select( preferencesStore ).get( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE );
	} catch {
		stored = undefined;
	}

	return typeof stored === 'number' && stored > 0 && stored < 1 ? stored : PANEL_DEFAULT_SHARE;
}

/** The panel's width in this window: the remembered share, within the limits. */
export function panelWidthFor( share: number, viewport: number = viewportWidth(), left: number = contentLeft() ): number {
	return clampPanelWidth( share * viewport, viewport, left );
}

function storePanelShare( width: number ): void {
	const viewport = viewportWidth();

	// In drawer mode the panel is the whole window: nothing the user chose, nothing to remember.
	if ( viewport < PANEL_DRAWER_BELOW || viewport <= 0 ) {
		return;
	}

	try {
		void dispatch( preferencesStore ).set( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE, Math.round( ( width / viewport ) * 1000 ) / 1000 );
	} catch {
		// Not remembered; the panel still has the width for this visit.
	}
}

/** Where the panel's width is read: the panel and the snackbars (`--wc-pl-panel-width`). */
const WIDTH_TARGETS = '.wc-pl-editor-panel, .wc-products-list__notices';
/** Where the room for the panel is read: the list (`--wc-pl-panel-inset`). */
const INSET_TARGETS = '.wc-products-list';

/**
 * The panel's width (`--wc-pl-panel-width`) and the room the list makes
 * for it (`--wc-pl-panel-inset`), set on the elements that read them
 * (both are registered as not inherited in edit/style.scss, so no row of
 * the list is restyled). While dragging only the panel follows the
 * pointer; the list moves over once, on release.
 */
function applyPanelWidth( width: number, list: boolean ): void {
	document.querySelectorAll< HTMLElement >( WIDTH_TARGETS ).forEach( ( element ) => element.style.setProperty( '--wc-pl-panel-width', `${ width }px` ) );

	if ( list ) {
		document.querySelectorAll< HTMLElement >( INSET_TARGETS ).forEach( ( element ) => element.style.setProperty( '--wc-pl-panel-inset', `${ width }px` ) );
	}
}

function clearPanelWidth(): void {
	document.querySelectorAll< HTMLElement >( WIDTH_TARGETS ).forEach( ( element ) => element.style.removeProperty( '--wc-pl-panel-width' ) );
	document.querySelectorAll< HTMLElement >( INSET_TARGETS ).forEach( ( element ) => element.style.removeProperty( '--wc-pl-panel-inset' ) );
}

/** The list element of a row on screen (a table row, a grid card, a list item), by its name cell's id. */
export function rowElement( id: number, doc: Document = document ): HTMLElement | null {
	const name = doc.getElementById( `${ ROW_ID_PREFIX }${ id }` );

	return ( name?.closest( 'tr, .dataviews-view-grid__card, .dataviews-view-list__item-wrapper' ) as HTMLElement | null ) ?? null;
}

/** The attribute that marks the quick-edited row; style.scss highlights `[data-wc-pl-edited]` rows. */
export const EDITED_ROW_ATTRIBUTE = 'data-wc-pl-edited';

/**
 * Highlight the quick-edited row while the panel edits it, mark it
 * `aria-current`, and bring it into view when it is off screen.
 *
 * Attributes set on the row element itself, not a class (DataViews
 * re-renders a row's class name on hover and selection, which would drop
 * a class set from outside; React leaves attributes it does not manage
 * alone) and not a generated style rule: changing a stylesheet restyles
 * the whole document, about 100 ms with ~600 rows, where an attribute
 * restyles one row. When the list replaces the row element (a refetch)
 * the mark follows it to the new one.
 */
function useEditedRowMark( id: number | null ): void {
	useLayoutEffect( () => {
		if ( id === null ) {
			return;
		}

		let row: HTMLElement | null = null;
		const mark = () => {
			const next = rowElement( id );

			if ( next === row ) {
				return;
			}

			row?.removeAttribute( EDITED_ROW_ATTRIBUTE );
			row?.removeAttribute( 'aria-current' );
			row = next;
			row?.setAttribute( EDITED_ROW_ATTRIBUTE, '' );
			row?.setAttribute( 'aria-current', 'true' );
		};

		mark();

		const first = row as HTMLElement | null;
		const body = first?.parentElement ?? null;
		const rows = body && typeof MutationObserver === 'function' ? new MutationObserver( mark ) : null;

		if ( body ) {
			rows?.observe( body, { childList: true } );
		}

		// Off screen? Asked of an IntersectionObserver rather than measured here: a measurement in this commit
		// would force the narrowed list's layout at once instead of in the frame that paints the panel.
		let observer: IntersectionObserver | null = null;

		if ( first && typeof IntersectionObserver === 'function' && typeof first.scrollIntoView === 'function' ) {
			observer = new IntersectionObserver( ( [ entry ] ) => {
				observer?.disconnect();

				if ( entry && ! entry.isIntersecting && ( entry.boundingClientRect.width || entry.boundingClientRect.height ) ) {
					first.scrollIntoView( { block: 'center', inline: 'nearest' } );
				}
			} );
			observer.observe( first );
		}

		return () => {
			observer?.disconnect();
			rows?.disconnect();
			row?.removeAttribute( EDITED_ROW_ATTRIBUTE );
			row?.removeAttribute( 'aria-current' );
		};
	}, [ id ] );
}

function focusElement( element: HTMLElement | null | undefined ): boolean {
	if ( ! element || ! element.isConnected ) {
		return false;
	}

	element.focus( { preventScroll: false } );

	return element.ownerDocument.activeElement === element;
}

/**
 * Focus into the list from the panel (F6, "Back to the list"): the edited
 * row's actions button, else the first ticked row, else the table.
 */
export function focusList( host: Pick< EditorHost, 'session' >, doc: Document = document ): boolean {
	if ( host.session.mode === 'quick' ) {
		const row = rowElement( host.session.id, doc );
		const buttons = row ? Array.from( row.querySelectorAll< HTMLElement >( 'button:not([disabled]), a[href]' ) ) : [];

		if ( focusElement( buttons[ buttons.length - 1 ] ) ) {
			return true;
		}
	}

	const checked = doc.querySelector< HTMLElement >( '.wc-products-list tbody input[type="checkbox"]:checked, .wc-products-list .dataviews-view-grid input[type="checkbox"]:checked' );

	if ( focusElement( checked ) ) {
		return true;
	}

	return focusElement( doc.getElementById( TABLE_ANCHOR_ID ) );
}

/** Focus into the panel from the list (F6): its first field, else the panel itself. */
export function focusPanel( panel: HTMLElement | null ): boolean {
	if ( ! panel ) {
		return false;
	}

	return focusElement( panel.querySelector( '.wc-pl-editor-panel__body' )?.querySelector< HTMLElement >( FIRST_FIELD ) ) || focusElement( panel );
}

/** Performance marks around opening the editor (`wc-products-list:editor-open` → `…:editor-ready`), for audits. */
export const EDITOR_OPEN_MARK = 'wc-products-list:editor-open';
export const EDITOR_READY_MEASURE = 'wc-products-list:editor-ready';

export function markEditorOpen(): void {
	try {
		performance.clearMarks?.( EDITOR_OPEN_MARK );
		performance.mark?.( EDITOR_OPEN_MARK );
	} catch {
		// No User Timing: nothing to measure.
	}
}

export function measureEditorReady(): void {
	try {
		if ( performance.getEntriesByName?.( EDITOR_OPEN_MARK, 'mark' ).length ) {
			performance.measure?.( EDITOR_READY_MEASURE, EDITOR_OPEN_MARK );
			performance.clearMarks?.( EDITOR_OPEN_MARK );
		}
	} catch {
		// No User Timing: nothing to measure.
	}
}

/** The drag handle on the panel's left edge: a vertical separator, also moved with the arrow keys. */
function ResizeHandle( { panelRef }: { panelRef: RefObject< HTMLElement | null > } ) {
	const handleRef = useRef< HTMLDivElement >( null );
	const widthRef = useRef( 0 );
	const dragRef = useRef< { startX: number; startWidth: number; frame: number; next: number } | null >( null );

	const show = useCallback( ( width: number ) => {
		const handle = handleRef.current;

		widthRef.current = width;
		handle?.setAttribute( 'aria-valuenow', String( width ) );
		handle?.setAttribute( 'aria-valuemin', String( minPanelWidth() ) );
		handle?.setAttribute( 'aria-valuemax', String( maxPanelWidth() ) );
	}, [] );

	// The width the panel opens with: the remembered share of this window, within its limits; and again
	// when the window is resized (or the admin menu folds), so the panel and the list always fit side by side.
	useLayoutEffect( () => {
		const fit = () => {
			const share = rememberedPanelShare();
			const width = share === null ? defaultPanelWidth() : panelWidthFor( share );

			applyPanelWidth( width, true );
			show( width );
		};
		let frame = 0;
		const onResize = () => {
			if ( ! frame ) {
				frame = window.requestAnimationFrame( () => {
					frame = 0;
					fit();
				} );
			}
		};

		fit();
		window.addEventListener( 'resize', onResize );

		// The admin menu folding or unfolding moves the list's left edge without resizing the window (common.js).
		const jquery = ( window as unknown as { jQuery?: ( target: Document ) => { on( event: string, handler: () => void ): void; off( event: string, handler: () => void ): void } } ).jQuery;

		jquery?.( document ).on( 'wp-menu-state-set', onResize );

		return () => {
			jquery?.( document ).off( 'wp-menu-state-set', onResize );
			window.removeEventListener( 'resize', onResize );
			window.cancelAnimationFrame( frame );
			clearPanelWidth();
		};
	}, [ show ] );

	const commit = ( width: number ) => {
		const clamped = clampPanelWidth( width );

		applyPanelWidth( clamped, true );
		show( clamped );
		storePanelShare( clamped );
	};

	const onPointerDown = ( event: PointerEvent< HTMLDivElement > ) => {
		if ( event.button !== 0 ) {
			return;
		}

		event.preventDefault();
		event.currentTarget.setPointerCapture?.( event.pointerId );

		const startWidth = panelRef.current?.getBoundingClientRect().width || widthRef.current;

		dragRef.current = { startX: event.clientX, startWidth, frame: 0, next: startWidth };
		document.documentElement.classList.add( PANEL_RESIZING_CLASS );
	};

	const onPointerMove = ( event: PointerEvent< HTMLDivElement > ) => {
		const drag = dragRef.current;

		if ( ! drag ) {
			return;
		}

		// The panel is on the right: dragging its edge left widens it.
		drag.next = clampPanelWidth( drag.startWidth + drag.startX - event.clientX );

		if ( ! drag.frame ) {
			drag.frame = window.requestAnimationFrame( () => {
				drag.frame = 0;
				applyPanelWidth( drag.next, false );
				show( drag.next );
			} );
		}
	};

	const endDrag = () => {
		const drag = dragRef.current;

		if ( ! drag ) {
			return;
		}

		dragRef.current = null;
		window.cancelAnimationFrame( drag.frame );
		document.documentElement.classList.remove( PANEL_RESIZING_CLASS );
		commit( drag.next );
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLDivElement > ) => {
		const step = event.shiftKey ? PANEL_KEY_STEP * 4 : PANEL_KEY_STEP;
		let next: number | null = null;

		switch ( event.key ) {
			case 'ArrowLeft':
				next = widthRef.current + step;
				break;
			case 'ArrowRight':
				next = widthRef.current - step;
				break;
			case 'Home':
				next = minPanelWidth();
				break;
			case 'End':
				next = maxPanelWidth();
				break;
		}

		if ( next === null ) {
			return;
		}

		event.preventDefault();
		commit( next );
	};

	return (
		<div
			ref={ handleRef }
			className="wc-pl-editor-panel__resize"
			role="separator"
			aria-orientation="vertical"
			aria-label={ __( 'Resize the editor panel', 'wp-woocommerce-products-list' ) }
			tabIndex={ 0 }
			onPointerDown={ onPointerDown }
			onPointerMove={ onPointerMove }
			onPointerUp={ endDrag }
			onPointerCancel={ endDrag }
			onLostPointerCapture={ endDrag }
			onKeyDown={ onKeyDown }
		/>
	);
}

export function EditorPanel( { host }: { host: EditorHost } ) {
	const hostRef = useRef( host );
	const guardRef = useRef< LeaveGuard | null >( null );
	const panelRef = useRef< HTMLElement >( null );
	// The pinned header's heading slot: the editor renders its title, count and loading line into it.
	const [ headerSlot, setHeaderSlot ] = useState< HTMLDivElement | null >( null );

	useLayoutEffect( () => {
		hostRef.current = host;
	} );

	// The editor's discard-confirm goes to the screen as before, and the panel's close button asks it too.
	const setGuard = useCallback( ( guard: LeaveGuard | null ) => {
		guardRef.current = guard;
		hostRef.current.setGuard( guard );
	}, [] );
	const panelHost = useMemo< EditorHost >( () => ( { ...host, setGuard, headerSlot } ), [ host, setGuard, headerSlot ] );

	const requestClose = useCallback( () => {
		const guard = guardRef.current;

		void ( guard ? guard() : Promise.resolve( true ) ).then( ( ok ) => {
			if ( ok ) {
				hostRef.current.close();
			}
		} );
	}, [] );

	const { mode } = host.session;
	// Slides in only when it can be seen doing so: in a background tab the animation would sit at its first
	// frame, the panel off screen, until the tab came back.
	const [ slide ] = useState( () => typeof document === 'undefined' || document.visibilityState !== 'hidden' );

	useLayoutEffect( () => {
		const root = document.documentElement;

		root.classList.add( PANEL_OPEN_CLASS, `is-${ mode }-edit` );

		return () => root.classList.remove( PANEL_OPEN_CLASS, `is-${ mode }-edit` );
	}, [ mode ] );

	useEditedRowMark( host.session.mode === 'quick' ? host.session.id : null );

	// F6 moves focus between the list and the panel, as between the regions of the block editor.
	useEffect( () => {
		const onKeyDown = ( event: globalThis.KeyboardEvent ) => {
			if ( event.key !== 'F6' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented ) {
				return;
			}

			const panel = panelRef.current;

			if ( ! panel ) {
				return;
			}

			event.preventDefault();

			if ( panel.contains( document.activeElement ) ) {
				focusList( hostRef.current );
			} else {
				focusPanel( panel );
			}
		};

		document.addEventListener( 'keydown', onKeyDown );

		return () => document.removeEventListener( 'keydown', onKeyDown );
	}, [] );

	// Escape from the panel's own chrome (the close button, the resize handle, the loading line); inside the
	// form the editor decides (a select's dropdown or a picker keeps its own Escape, a dirty form asks first).
	const onKeyDown = ( event: KeyboardEvent< HTMLElement > ) => {
		const target = event.target as HTMLElement | null;

		if ( event.key !== 'Escape' || event.defaultPrevented || ! target || ! panelRef.current?.contains( target ) || target.closest?.( 'form' ) ) {
			return;
		}

		event.preventDefault();
		requestClose();
	};

	const key = sessionKey( host.session );
	const label = editorRegionLabel( host );
	const fallbackTitle =
		mode === 'bulk'
			? sprintf(
					/* translators: %d: number of rows */
					_n( 'Bulk edit %d item', 'Bulk edit %d items', host.items.length, 'wp-woocommerce-products-list' ),
					host.items.length
			  )
			: __( 'Quick edit', 'wp-woocommerce-products-list' );

	return (
		<aside ref={ panelRef } className={ `wc-pl-editor-panel is-${ mode }${ slide ? ' is-sliding' : '' }` } role="region" aria-label={ label } tabIndex={ -1 } onKeyDown={ onKeyDown }>
			<ResizeHandle panelRef={ panelRef } />
			<div className="wc-pl-editor-panel__header">
				<a
					className="wc-pl-editor-panel__skip"
					href={ `#${ TABLE_ANCHOR_ID }` }
					onClick={ ( event ) => {
						event.preventDefault();
						focusList( hostRef.current );
					} }
				>
					{ __( 'Back to the list', 'wp-woocommerce-products-list' ) }
				</a>
				<div ref={ setHeaderSlot } className="wc-pl-editor-panel__heading">
					{ /* Shown until the editor's own heading arrives (the chunk's first load). */ }
					<h2 className="wc-pl-editor-panel__title">
						{ fallbackTitle }
						{ mode === 'quick' ? <span className="wc-pl-inline-edit__name">{ nameOfFirst( host.items ) }</span> : null }
					</h2>
				</div>
				<Button className="wc-pl-editor-panel__close" icon={ closeIcon } size="compact" label={ __( 'Close the editor', 'wp-woocommerce-products-list' ) } onClick={ requestClose } />
			</div>
			<div className={ `wc-pl-editor-panel__body is-${ mode }` }>
				<ErrorBoundary
					context="editor"
					fallback={ ( { isChunkError, retry } ) => (
						<Notice status="error" isDismissible={ false } className="wc-pl-inline-edit__failed">
							{ isChunkError
								? __( 'The editor could not be loaded. The plugin may have been updated, or the connection dropped.', 'wp-woocommerce-products-list' )
								: __( 'Something went wrong in the editor.', 'wp-woocommerce-products-list' ) }{ ' ' }
							{ isChunkError ? (
								<Button variant="link" onClick={ () => window.location.reload() }>
									{ __( 'Reload the page', 'wp-woocommerce-products-list' ) }
								</Button>
							) : (
								<Button variant="link" onClick={ retry }>
									{ __( 'Try again', 'wp-woocommerce-products-list' ) }
								</Button>
							) }{ ' ' }
							<Button variant="secondary" size="compact" onClick={ () => host.close() }>
								{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
							</Button>
						</Notice>
					) }
				>
					<Suspense
						fallback={
							<div className="wc-pl-inline-edit__loading" role="status">
								<Spinner /> { __( 'Opening the editor…', 'wp-woocommerce-products-list' ) }
							</div>
						}
					>
						<InlineEditor key={ key } host={ panelHost } />
					</Suspense>
				</ErrorBoundary>
			</div>
		</aside>
	);
}

export default EditorPanel;
