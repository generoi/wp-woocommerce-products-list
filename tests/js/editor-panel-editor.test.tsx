/**
 * The real editor in the slide-in panel: its heading goes into the panel's
 * pinned header, the first field takes focus inside the panel, the bulk
 * item list is a collapsible section, and closing puts focus back on the
 * edited row's actions button in the list.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );
vi.mock( '../../resources/store/products', () => ( { subscribeDeleted: () => () => {}, patchItems: vi.fn(), removeItems: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn( async () => ( { items: [], total: 0, totalPages: 1 } ) ),
	listProducts: vi.fn( async ( query: Record< string, unknown > ) => ( {
		items: String( query.include )
			.split( ',' )
			.map( ( id ) => simple( Number( id ), { name: `Product ${ id }`, featured: false } ) ),
		total: 0,
		totalPages: 1,
	} ) ),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: vi.fn() } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { EditorHostProvider } = await import( '../../resources/edit/editor-context' );
// The editor chunk, loaded once up front: the panel's lazy import then resolves at once instead of racing waitFor's timeout on a busy machine.
await import( '../../resources/edit/inline-editor' );
const { resetCurrentRows } = await import( '../../resources/store/rows' );

const fields = coreFields().filter( ( field ) => [ 'name', 'status', 'featured' ].includes( field.id ) );

function hostFor( session: EditorSession, items: ProductListItem[], close = vi.fn() ): EditorHost {
	return { session, fields, items, offPageCount: 0, wholeList: false, close, advance: vi.fn(), removeItem: vi.fn(), setGuard: vi.fn() };
}

function List() {
	return (
		<div className="wc-products-list">
			<table className="dataviews-view-table">
				<tbody>
					<tr>
						<td>
							<div id="wc-pl-row-1">Product 1</div>
						</td>
						<td>
							<button type="button">Actions 1</button>
						</td>
					</tr>
					<tr>
						<td>
							<div id="wc-pl-row-2">Product 2</div>
						</td>
						<td>
							<button type="button">Actions 2</button>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	);
}

afterEach( () => {
	resetCurrentRows();
	window.sessionStorage.clear();
	document.documentElement.className = '';
} );

describe( 'the editor in the panel', () => {
	it( 'puts its heading in the pinned header, focuses the first field in the panel and returns focus to the row on close', async () => {
		const close = vi.fn();
		const items = [ simple( 2, { name: 'Product 2' } ) ];
		const host = hostFor( { mode: 'quick', id: 2, origin: { element: null, rowIndex: 1, label: null } }, items, close );
		const view = render(
			<EditorHostProvider value={ host }>
				<List />
			</EditorHostProvider>
		);

		const panel = screen.getByRole( 'region', { name: 'Quick edit: Product 2' } );
		const header = panel.querySelector( '.wc-pl-editor-panel__heading' )! as HTMLElement;

		// The editor's heading lands in the header; the panel's stand-in title is then not the only child.
		await waitFor( () => expect( header.querySelector( '.wc-pl-inline-edit__head' ) ).not.toBeNull() );
		expect( within( header ).getAllByRole( 'heading', { level: 2 } ).length ).toBeGreaterThanOrEqual( 1 );
		expect( panel.querySelector( '.wc-pl-editor-panel__body form .wc-pl-inline-edit__head' ) ).toBeNull();

		await waitFor( () => expect( panel.contains( document.activeElement ) && document.activeElement?.tagName ).toBe( 'INPUT' ) );

		// Escape on the clean form closes; the screen unmounts the panel.
		await act( async () => {
			fireEvent.keyDown( document.activeElement!, { key: 'Escape' } );
		} );
		expect( close ).toHaveBeenCalledTimes( 1 );

		view.rerender(
			<EditorHostProvider value={ null }>
				<List />
			</EditorHostProvider>
		);
		await waitFor( () => expect( document.activeElement ).toBe( screen.getByRole( 'button', { name: 'Actions 2' } ) ) );
	} );

	it( 'lists the bulk selection in a collapsible section at the top of the body, with the count in the header', async () => {
		const items = [ simple( 1, { name: 'Product 1' } ), simple( 2, { name: 'Product 2' } ) ];

		render(
			<EditorHostProvider value={ hostFor( { mode: 'bulk', origin: null }, items ) }>
				<List />
			</EditorHostProvider>
		);

		const panel = screen.getByRole( 'region', { name: 'Bulk edit: 2 items' } );

		await waitFor( () => expect( panel.querySelector( '.wc-pl-editor-panel__heading .wc-pl-inline-edit__head' ) ).toHaveTextContent( 'Bulk edit 2 items' ) );

		const section = panel.querySelector( '.wc-pl-editor-panel__body details.wc-pl-inline-edit__selection' ) as HTMLDetailsElement;

		expect( section.open ).toBe( true );
		expect( section.querySelector( 'summary' ) ).toHaveTextContent( 'Selected items (2)' );
		expect( within( section ).getAllByRole( 'listitem' ) ).toHaveLength( 2 );

		// Collapsed by its summary, and it stays collapsed across the editor's re-renders.
		fireEvent.click( section.querySelector( 'summary' )! );
		await waitFor( () => expect( section.open ).toBe( false ) );
	} );

	it( 'opening another row keeps focus on the new editor\'s first field when its form takes two columns, not on the previous row in the list', async () => {
		// A panel wide enough for two columns: the form re-lays its cards out right after it first renders (measured before paint).
		const rect = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function ( this: HTMLElement ) {
			return this.classList.contains( 'wc-pl-edit__form' ) ? ( { ...rect.call( this ).toJSON?.(), width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, x: 0, y: 0 } as DOMRect ) : rect.call( this );
		};

		try {
			const one = hostFor( { mode: 'quick', id: 1, origin: { element: null, rowIndex: 0, label: null } }, [ simple( 1, { name: 'Product 1' } ) ] );
			const view = render(
				<EditorHostProvider value={ one }>
					<List />
				</EditorHostProvider>
			);
			const panel = () => screen.getByRole( 'region', { name: /^Quick edit/ } );

			await waitFor( () => expect( panel().querySelector( '.wc-pl-edit__form.is-wide' ) ).not.toBeNull() );
			await waitFor( () => expect( panel().contains( document.activeElement ) && document.activeElement?.tagName ).toBe( 'INPUT' ) );

			// The pencil of row 2 while row 1 is open: a new editor replaces the old one in the same panel.
			const two = hostFor( { mode: 'quick', id: 2, origin: { element: null, rowIndex: 1, label: null } }, [ simple( 2, { name: 'Product 2' } ) ] );

			view.rerender(
				<EditorHostProvider value={ two }>
					<List />
				</EditorHostProvider>
			);

			await screen.findByRole( 'region', { name: 'Quick edit: Product 2' } );
			await waitFor( () => expect( panel().querySelector( '.wc-pl-edit__form.is-wide input' ) ).not.toBeNull() );
			await act( async () => {
				await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
			} );

			expect( document.activeElement ).not.toBe( screen.getByRole( 'button', { name: 'Actions 1' } ) );
			expect( panel().contains( document.activeElement ) && document.activeElement?.tagName ).toBe( 'INPUT' );
		} finally {
			HTMLElement.prototype.getBoundingClientRect = rect;
		}
	} );
} );
