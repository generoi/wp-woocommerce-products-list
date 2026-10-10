/**
 * The slide-in editor panel (edit/editor-panel.tsx) as the screen hosts it:
 * a split view beside the list, not a row of it and not a modal. Opening,
 * switching rows, Update & next, the live bulk selection, Escape and the
 * discard guard, F6 between list and panel, and the remembered width.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dispatch, select } from '@wordpress/data';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { store as preferencesStore } from '@wordpress/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost, LeaveGuard } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { ProductListItem } from '../../resources/types';
import { simple } from './edit-fixtures';

const mounts = vi.fn();
const guardForTest: { current: LeaveGuard | null } = { current: null };

vi.mock( '../../resources/edit/inline-editor', async () => {
	const { useEffect } = await import( '@wordpress/element' );

	function FakeEditor( { host }: { host: EditorHost } ) {
		useEffect( () => {
			mounts( host.items.map( ( item ) => item.id ).join( ',' ) );
			host.setGuard( guardForTest.current );

			return () => host.setGuard( null );
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [] );

		return (
			<form data-testid="editor">
				<input aria-label="Name" readOnly value={ host.items.map( ( item ) => item.id ).join( ',' ) } />
				{ host.session.mode === 'quick' ? (
					<button type="button" onClick={ () => host.advance( simple( host.session.mode === 'quick' ? host.session.id + 1 : 0 ) ) }>
						Update & next
					</button>
				) : null }
			</form>
		);
	}

	return { default: FakeEditor };
} );

const { EditorHostProvider } = await import( '../../resources/edit/editor-context' );
const { EDITED_ROW_ATTRIBUTE, PANEL_DEFAULT_MIN_WIDTH, PANEL_DEFAULT_SHARE, defaultPanelWidth, PANEL_MIN_WIDTH, PANEL_OPEN_CLASS, PANEL_WIDTH_PREFERENCE, clampPanelWidth, maxPanelWidth, panelWidthFor, sessionKey } = await import( '../../resources/edit/editor-panel' );

/** jsdom's window: 1024 px wide, no admin menu. The panel opens at 52 % of it, at least 880 px, leaving the list 320 px: 704 px. */
const PANEL_DEFAULT_WIDTH = 704;
/** The stored preference is the share of the window, rounded to three decimals. */
const shareOf = ( width: number ) => Math.round( ( width / 1024 ) * 1000 ) / 1000;
const { PREFERENCES_SCOPE } = await import( '../../resources/store/view' );

const rows = [ simple( 1 ), simple( 2 ), simple( 3 ) ];
const tableRenders = vi.fn();

interface TableProps {
	rows: ProductListItem[];
	selected: number[];
	onToggle( id: number ): void;
	onQuickEdit( row: ProductListItem ): void;
}

/** The list: memoised like DataViews' rows, so a render here means the screen handed it new props. */
const Table = memo( function Table( { rows: shown, selected, onToggle, onQuickEdit }: TableProps ) {
	tableRenders();

	return (
		<table className="dataviews-view-table">
			<tbody>
				{ shown.map( ( row ) => (
					<tr key={ row.id }>
						<td>
							<input type="checkbox" aria-label={ `Select ${ row.id }` } checked={ selected.includes( row.id ) } onChange={ () => onToggle( row.id ) } />
						</td>
						<td>
							<div id={ `wc-pl-row-${ row.id }` }>{ row.name }</div>
						</td>
						<td>
							<button type="button" onClick={ () => onQuickEdit( row ) }>{ `Quick edit ${ row.id }` }</button>
						</td>
					</tr>
				) ) }
			</tbody>
		</table>
	);
} );

/** The screen's part: the session, the leave guard before another editor opens, the live selection for bulk. */
function Screen( { onHost }: { onHost?: ( host: EditorHost | null ) => void } ) {
	const [ session, setSession ] = useState< EditorSession | null >( null );
	const [ selected, setSelected ] = useState< number[] >( [] );
	const guardRef = useRef< LeaveGuard | null >( null );
	const sessionRef = useRef( session );

	useLayoutEffect( () => {
		sessionRef.current = session;
	} );

	const onQuickEdit = useCallback( ( row: ProductListItem ) => {
		void ( async () => {
			if ( sessionRef.current && guardRef.current && ! ( await guardRef.current() ) ) {
				return;
			}

			setSession( { mode: 'quick', id: row.id, origin: null } );
		} )();
	}, [] );
	const onToggle = useCallback( ( id: number ) => setSelected( ( current ) => ( current.includes( id ) ? current.filter( ( other ) => other !== id ) : [ ...current, id ] ) ), [] );

	const host = useMemo< EditorHost | null >( () => {
		if ( ! session ) {
			return null;
		}

		const items = session.mode === 'quick' ? rows.filter( ( row ) => row.id === session.id ) : rows.filter( ( row ) => selected.includes( row.id ) );

		return {
			session,
			fields: [],
			items,
			offPageCount: 0,
			wholeList: false,
			close: () => setSession( null ),
			advance: ( row ) => setSession( { mode: 'quick', id: row.id, origin: null } ),
			removeItem: ( id ) => setSelected( ( current ) => current.filter( ( other ) => other !== id ) ),
			setGuard: ( guard ) => {
				guardRef.current = guard;
			},
		};
	}, [ session, selected ] );

	onHost?.( host );

	return (
		<EditorHostProvider value={ host }>
			<div className="wc-products-list">
				<div id="wc-products-list-table" tabIndex={ -1 } />
				<button type="button" onClick={ () => setSession( { mode: 'bulk', origin: null } ) }>
					Bulk edit
				</button>
				<Table rows={ rows } selected={ selected } onToggle={ onToggle } onQuickEdit={ onQuickEdit } />
			</div>
		</EditorHostProvider>
	);
}

const rowOf = ( id: number ) => document.getElementById( `wc-pl-row-${ id }` )!.closest( 'tr' )!;
const edited = () => [ ...document.querySelectorAll( `[${ EDITED_ROW_ATTRIBUTE }]` ) ].map( ( row ) => row.querySelector( '[id^=wc-pl-row-]' )?.id ).join( ',' );

async function openQuickEdit( id: number ) {
	await act( async () => {
		fireEvent.click( screen.getByRole( 'button', { name: `Quick edit ${ id }` } ) );
	} );
}

beforeEach( async () => {
	await dispatch( preferencesStore ).set( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE, undefined );
} );

afterEach( () => {
	guardForTest.current = null;
	mounts.mockReset();
	tableRenders.mockReset();
	document.documentElement.className = '';
	document.documentElement.removeAttribute( 'style' );
} );

describe( 'EditorPanel', () => {
	it( 'opens a quick edit beside the list: a labelled region, not in the table, not modal, the row highlighted, the list not re-rendered', async () => {
		render( <Screen /> );
		expect( tableRenders ).toHaveBeenCalledTimes( 1 );

		await openQuickEdit( 1 );

		const panel = screen.getByRole( 'region', { name: 'Quick edit: Simple 1' } );

		expect( panel.tagName ).toBe( 'ASIDE' );
		expect( panel.closest( '.wc-products-list' ) ).toBeNull();
		expect( document.querySelector( '.components-modal__frame, [role="dialog"]' ) ).toBeNull();
		expect( document.documentElement.classList.contains( PANEL_OPEN_CLASS ) ).toBe( true );
		expect( document.documentElement.classList.contains( 'is-quick-edit' ) ).toBe( true );
		// The pinned header names the product while the editor chunk loads.
		expect( panel.querySelector( '.wc-pl-editor-panel__header' ) ).toHaveTextContent( 'Quick editSimple 1' );
		expect( await screen.findByTestId( 'editor' ) ).toBeInTheDocument();

		// The row: highlighted through an attribute on the row element, and aria-current.
		expect( edited() ).toBe( 'wc-pl-row-1' );
		expect( rowOf( 1 ).getAttribute( 'aria-current' ) ).toBe( 'true' );
		// Opening the panel handed the list nothing new.
		expect( tableRenders ).toHaveBeenCalledTimes( 1 );

		// The list stays interactive: ticking a row works with the panel open.
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Select 3' } ) );
		expect( screen.getByRole( 'checkbox', { name: 'Select 3' } ) ).toBeChecked();
		expect( screen.getByRole( 'region', { name: 'Quick edit: Simple 1' } ) ).toBe( panel );
	} );

	it( 'scrolls the quick-edited row into view when it is off screen, without measuring it in the commit', async () => {
		const observed: Element[] = [];
		let report: ( ( entries: Array< Partial< IntersectionObserverEntry > > ) => void ) | null = null;

		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor( callback: ( entries: Array< Partial< IntersectionObserverEntry > > ) => void ) {
					report = callback;
				}
				observe( element: Element ) {
					observed.push( element );
				}
				disconnect() {}
			}
		);
		const scroll = vi.fn();

		Element.prototype.scrollIntoView = scroll;

		try {
			render( <Screen /> );
			await openQuickEdit( 3 );

			expect( observed ).toEqual( [ rowOf( 3 ) ] );
			expect( scroll ).not.toHaveBeenCalled();

			act( () => report!( [ { isIntersecting: false, boundingClientRect: { width: 800, height: 48 } as DOMRectReadOnly } ] ) );
			expect( scroll ).toHaveBeenCalledWith( { block: 'center', inline: 'nearest' } );
		} finally {
			vi.unstubAllGlobals();
			delete ( Element.prototype as { scrollIntoView?: unknown } ).scrollIntoView;
		}
	} );

	it( 'switches to another row after the discard guard, moving the highlight; a refused guard keeps the editor', async () => {
		let answer = false;
		const guard = vi.fn( () => Promise.resolve( answer ) );

		guardForTest.current = guard;
		render( <Screen /> );
		await openQuickEdit( 1 );
		await screen.findByTestId( 'editor' );

		await openQuickEdit( 2 );
		expect( guard ).toHaveBeenCalledTimes( 1 );
		expect( screen.getByRole( 'region', { name: 'Quick edit: Simple 1' } ) ).toBeInTheDocument();
		expect( edited() ).toBe( 'wc-pl-row-1' );

		const panel = screen.getByRole( 'region', { name: 'Quick edit: Simple 1' } );
		const classes: string[] = [];
		const watch = new MutationObserver( () => classes.push( document.documentElement.className ) );

		watch.observe( document.documentElement, { attributes: true, attributeFilter: [ 'class' ] } );
		answer = true;
		await openQuickEdit( 2 );
		watch.disconnect();
		// The same panel takes the new session: it never closes in between, so the list is not restyled twice.
		expect( screen.getByRole( 'region', { name: 'Quick edit: Simple 2' } ) ).toBe( panel );
		expect( classes.every( ( name ) => name.includes( PANEL_OPEN_CLASS ) ) ).toBe( true );
		expect( edited() ).toBe( 'wc-pl-row-2' );
		expect( rowOf( 1 ).hasAttribute( 'aria-current' ) ).toBe( false );
		expect( rowOf( 2 ).getAttribute( 'aria-current' ) ).toBe( 'true' );
		await waitFor( () => expect( mounts ).toHaveBeenLastCalledWith( '2' ) );
	} );

	it( 'Update & next opens the next row in the same panel with a fresh editor and moves the highlight', async () => {
		render( <Screen /> );
		await openQuickEdit( 1 );
		await screen.findByTestId( 'editor' );

		const panel = screen.getByRole( 'region' );

		fireEvent.click( screen.getByRole( 'button', { name: 'Update & next' } ) );

		await waitFor( () => expect( mounts ).toHaveBeenLastCalledWith( '2' ) );
		expect( mounts ).toHaveBeenCalledTimes( 2 );
		// The same panel (no slide out and in), now on row 2.
		expect( screen.getByRole( 'region', { name: 'Quick edit: Simple 2' } ) ).toBe( panel );
		expect( edited() ).toBe( 'wc-pl-row-2' );
	} );

	it( 'bulk edit follows the live selection: unticking a row in the list updates the panel without a new editor', async () => {
		render( <Screen /> );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Select 1' } ) );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Select 2' } ) );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Select 3' } ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Bulk edit' } ) );

		expect( screen.getByRole( 'region', { name: 'Bulk edit: 3 items' } ) ).toBeInTheDocument();
		expect( document.documentElement.classList.contains( 'is-bulk-edit' ) ).toBe( true );
		expect( await screen.findByRole( 'textbox', { name: 'Name' } ) ).toHaveValue( '1,2,3' );
		// No row is highlighted for a bulk edit: the ticked rows are what it edits.
		expect( edited() ).toBe( '' );

		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Select 2' } ) );

		expect( screen.getByRole( 'region', { name: 'Bulk edit: 2 items' } ) ).toBeInTheDocument();
		expect( screen.getByRole( 'textbox', { name: 'Name' } ) ).toHaveValue( '1,3' );
		expect( mounts ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'closes from the X or Escape only when the editor lets it; Escape inside the form is the editor\'s', async () => {
		let answer = false;
		const guard = vi.fn( () => Promise.resolve( answer ) );

		guardForTest.current = guard;
		render( <Screen /> );
		await openQuickEdit( 1 );
		await screen.findByTestId( 'editor' );

		const close = screen.getByRole( 'button', { name: 'Close the editor' } );

		await act( async () => {
			fireEvent.click( close );
		} );
		expect( guard ).toHaveBeenCalledTimes( 1 );
		expect( screen.getByRole( 'region' ) ).toBeInTheDocument();

		// Inside the form the editor decides (a select's dropdown keeps its Escape; the real editor asks its own guard).
		await act( async () => {
			fireEvent.keyDown( screen.getByRole( 'textbox', { name: 'Name' } ), { key: 'Escape' } );
		} );
		expect( guard ).toHaveBeenCalledTimes( 1 );

		answer = true;
		await act( async () => {
			fireEvent.keyDown( close, { key: 'Escape' } );
		} );
		expect( guard ).toHaveBeenCalledTimes( 2 );
		expect( screen.queryByRole( 'region' ) ).toBeNull();
		expect( document.documentElement.classList.contains( PANEL_OPEN_CLASS ) ).toBe( false );
		expect( edited() ).toBe( '' );
		expect( rowOf( 1 ).hasAttribute( 'aria-current' ) ).toBe( false );
	} );

	it( 'F6 and "Back to the list" move focus between the panel and the list, without a trap', async () => {
		render( <Screen /> );
		await openQuickEdit( 1 );

		const field = await screen.findByRole( 'textbox', { name: 'Name' } );

		field.focus();
		fireEvent.keyDown( field, { key: 'F6' } );
		// The edited row's last control (its actions).
		expect( document.activeElement ).toBe( screen.getByRole( 'button', { name: 'Quick edit 1' } ) );

		fireEvent.keyDown( document.activeElement!, { key: 'F6' } );
		expect( document.activeElement ).toBe( field );

		fireEvent.click( screen.getByRole( 'link', { name: 'Back to the list' } ) );
		expect( document.activeElement ).toBe( screen.getByRole( 'button', { name: 'Quick edit 1' } ) );

		// Tab out of the panel is not stopped: nothing in it holds focus in.
		expect( screen.getByRole( 'region' ).querySelector( '[data-focus-trap], .components-modal__screen-overlay' ) ).toBeNull();
	} );

	it( 'resizes from the keyboard within its limits and opens at the remembered width', async () => {
		const view = render( <Screen /> );

		await openQuickEdit( 1 );

		const handle = screen.getByRole( 'separator', { name: 'Resize the editor panel' } );
		const html = { getPropertyValue: ( name: string ) => ( document.querySelector< HTMLElement >( name === '--wc-pl-panel-inset' ? '.wc-products-list' : '.wc-pl-editor-panel' )?.style.getPropertyValue( name ) ?? '' ) };

		expect( handle.getAttribute( 'aria-valuenow' ) ).toBe( String( PANEL_DEFAULT_WIDTH ) );
		expect( html.getPropertyValue( '--wc-pl-panel-width' ) ).toBe( `${ PANEL_DEFAULT_WIDTH }px` );

		fireEvent.keyDown( handle, { key: 'ArrowRight' } );
		expect( handle.getAttribute( 'aria-valuenow' ) ).toBe( String( PANEL_DEFAULT_WIDTH - 16 ) );
		expect( html.getPropertyValue( '--wc-pl-panel-width' ) ).toBe( `${ PANEL_DEFAULT_WIDTH - 16 }px` );
		expect( html.getPropertyValue( '--wc-pl-panel-inset' ) ).toBe( `${ PANEL_DEFAULT_WIDTH - 16 }px` );
		expect( select( preferencesStore ).get( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE ) ).toBe( shareOf( PANEL_DEFAULT_WIDTH - 16 ) );
		fireEvent.keyDown( handle, { key: 'ArrowLeft' } );
		expect( handle.getAttribute( 'aria-valuenow' ) ).toBe( String( PANEL_DEFAULT_WIDTH ) );

		fireEvent.keyDown( handle, { key: 'Home' } );
		expect( handle.getAttribute( 'aria-valuenow' ) ).toBe( String( PANEL_MIN_WIDTH ) );
		fireEvent.keyDown( handle, { key: 'End' } );
		expect( handle.getAttribute( 'aria-valuenow' ) ).toBe( String( maxPanelWidth() ) );
		fireEvent.keyDown( handle, { key: 'ArrowRight', shiftKey: true } );
		expect( select( preferencesStore ).get( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE ) ).toBe( shareOf( maxPanelWidth() - 64 ) );

		// Closed and opened again (a reload reads the same preference): the width the user left.
		await act( async () => {
			fireEvent.click( screen.getByRole( 'button', { name: 'Close the editor' } ) );
		} );
		expect( html.getPropertyValue( '--wc-pl-panel-width' ) ).toBe( '' );
		view.unmount();
		render( <Screen /> );
		await openQuickEdit( 2 );
		expect( screen.getByRole( 'separator' ).getAttribute( 'aria-valuenow' ) ).toBe( String( maxPanelWidth() - 64 ) );
	} );

	it( 'resizes by dragging the edge: the panel follows the pointer, the list moves over once on release', async () => {
		const frames: FrameRequestCallback[] = [];
		const raf = vi.spyOn( window, 'requestAnimationFrame' ).mockImplementation( ( callback ) => {
			frames.push( callback );

			return frames.length;
		} );

		try {
			render( <Screen /> );
			await openQuickEdit( 1 );

			const handle = screen.getByRole( 'separator' );
			const html = { getPropertyValue: ( name: string ) => ( document.querySelector< HTMLElement >( name === '--wc-pl-panel-inset' ? '.wc-products-list' : '.wc-pl-editor-panel' )?.style.getPropertyValue( name ) ?? '' ) };

			fireEvent.pointerDown( handle, { button: 0, clientX: 600, pointerId: 1 } );
			expect( document.documentElement.classList.contains( 'wc-pl-panel-resizing' ) ).toBe( true );
			fireEvent.pointerMove( handle, { clientX: 640, pointerId: 1 } );
			frames.splice( 0 ).forEach( ( frame ) => frame( 0 ) );

			expect( html.getPropertyValue( '--wc-pl-panel-width' ) ).toBe( `${ PANEL_DEFAULT_WIDTH - 40 }px` );
			expect( html.getPropertyValue( '--wc-pl-panel-inset' ) ).toBe( `${ PANEL_DEFAULT_WIDTH }px` );

			fireEvent.pointerUp( handle, { clientX: 640, pointerId: 1 } );
			expect( html.getPropertyValue( '--wc-pl-panel-inset' ) ).toBe( `${ PANEL_DEFAULT_WIDTH - 40 }px` );
			expect( document.documentElement.classList.contains( 'wc-pl-panel-resizing' ) ).toBe( false );
			expect( select( preferencesStore ).get( PREFERENCES_SCOPE, PANEL_WIDTH_PREFERENCE ) ).toBe( shareOf( PANEL_DEFAULT_WIDTH - 40 ) );
		} finally {
			raf.mockRestore();
		}
	} );

	it( 'opens at about half the window and clamps widths to 480 px and 75 % of the window, leaving the list room', () => {
		expect( PANEL_DEFAULT_SHARE ).toBeGreaterThanOrEqual( 0.5 );
		expect( PANEL_DEFAULT_SHARE ).toBeLessThanOrEqual( 0.55 );
		expect( panelWidthFor( PANEL_DEFAULT_SHARE, 1920, 160 ) ).toBe( 998 );
		expect( panelWidthFor( PANEL_DEFAULT_SHARE, 1280, 160 ) ).toBe( 666 );
		// Until the user picks a width: wide enough for the form's side column on a laptop.
		expect( PANEL_DEFAULT_MIN_WIDTH ).toBe( 880 );
		expect( defaultPanelWidth( 1440, 160 ) ).toBe( 880 );
		expect( defaultPanelWidth( 1280, 160 ) ).toBe( 800 );
		expect( defaultPanelWidth( 1920, 160 ) ).toBe( 998 );
		expect( defaultPanelWidth( 800, 0 ) ).toBe( 800 );
		expect( clampPanelWidth( 100, 1600, 0 ) ).toBe( PANEL_MIN_WIDTH );
		expect( clampPanelWidth( 2000, 1600, 0 ) ).toBe( 1200 );
		expect( clampPanelWidth( 500.4, 1600, 0 ) ).toBe( 500 );
		expect( clampPanelWidth( Number.NaN, 1600, 0 ) ).toBe( 832 );
		// 75 % of 1280 would leave the list right of the admin menu 160 px: it keeps 320.
		expect( maxPanelWidth( 1280, 160 ) ).toBe( 800 );
		// Never below the minimum where the split view applies.
		expect( clampPanelWidth( 2000, 1000, 160 ) ).toBe( 520 );
		expect( clampPanelWidth( 2000, 960, 300 ) ).toBe( PANEL_MIN_WIDTH );
		// Below 960 px the drawer takes the whole window, whatever was chosen.
		expect( clampPanelWidth( 500, 800, 0 ) ).toBe( 800 );
		expect( panelWidthFor( PANEL_DEFAULT_SHARE, 400, 0 ) ).toBe( 400 );
	} );

	it( 'slides in when the page is visible, and opens in place in a background tab', async () => {
		const first = render( <Screen /> );

		await openQuickEdit( 1 );
		expect( screen.getByRole( 'region' ).classList.contains( 'is-sliding' ) ).toBe( true );
		first.unmount();

		const visibility = vi.spyOn( document, 'visibilityState', 'get' ).mockReturnValue( 'hidden' );

		try {
			render( <Screen /> );
			await openQuickEdit( 1 );
			// A hidden tab does not run the animation: its first frame would leave the panel off screen.
			expect( screen.getByRole( 'region' ).classList.contains( 'is-sliding' ) ).toBe( false );
		} finally {
			visibility.mockRestore();
		}
	} );

	it( 'keys editors by session object', () => {
		const a = { mode: 'bulk' as const, origin: null };
		const b = { mode: 'bulk' as const, origin: null };

		expect( sessionKey( a ) ).toBe( sessionKey( a ) );
		expect( sessionKey( a ) ).not.toBe( sessionKey( b ) );
	} );
} );
