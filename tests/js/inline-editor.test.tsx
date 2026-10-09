/**
 * The inline editor's own behaviour: it follows the live selection until
 * a save starts and then works on the rows that save had (a partial
 * failure must not turn a bulk edit into a quick edit of the failed row),
 * Escape asks before discarding, Enter updates, the leave guard answers the
 * screen, and focus goes back to the row when it closes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-rows';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple, variation } from './edit-fixtures';

// These render the whole editor (DataForm and @wordpress/components): under a loaded CI box (tsc and
// eslint in parallel) one render can pass vitest's 5 s default, which is not a failure of the editor.
vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();
const removeItems = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), removeItems: ( ids: number[] ) => removeItems( ids ) } ) );
const logSkipped = vi.fn( async () => undefined );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: ( ...args: unknown[] ) => logSkipped( ...( args as [] ) ),
	getVariations: vi.fn( async () => ( { items: [], total: 0, totalPages: 1 } ) ),
	listProducts: vi.fn( async ( query: Record< string, unknown > ) => ( {
		items: String( query.include )
			.split( ',' )
			.map( ( id ) => simple( Number( id ), { featured: false } ) ),
		total: 0,
		totalPages: 1,
	} ) ),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const { initialTabFor } = await import( '../../resources/actions/quick-edit' );
const { resetCurrentRows, setCurrentRows } = await import( '../../resources/store/rows' );

const fields = coreFields().filter( ( field ) => [ 'name', 'status', 'featured', 'stock_quantity', 'manage_stock' ].includes( field.id ) );

type HostOverrides = Partial< Omit< EditorHost, 'session' > > & { session?: Partial< EditorSession > };

function hostFor( items: ProductListItem[], overrides: HostOverrides = {} ): EditorHost {
	const { session, ...rest } = overrides;
	const base: EditorSession = items.length > 1 ? { mode: 'bulk', origin: null } : { mode: 'quick', id: items[ 0 ]?.id ?? 0, origin: null };

	return {
		session: { ...base, ...session } as EditorSession,
		fields,
		items,
		offPageCount: 0,
		wholeList: false,
		close: vi.fn(),
		advance: vi.fn(),
		removeItem: vi.fn(),
		setGuard: vi.fn(),
		...rest,
	};
}

function renderEditor( items: ProductListItem[], overrides: HostOverrides = {} ) {
	const host = hostFor( items, overrides );
	const utils = render( <InlineEditor host={ host } /> );

	return {
		...utils,
		host,
		close: host.close as ReturnType< typeof vi.fn >,
		advance: host.advance as ReturnType< typeof vi.fn >,
		/** The screen re-rendered the editor with another live selection. */
		rerenderWith( next: ProductListItem[] ) {
			utils.rerender( <InlineEditor host={ { ...host, items: next } } /> );
		},
	};
}

function editorForm( container: HTMLElement ): Element {
	return container.querySelector( 'form.wc-pl-edit' )!;
}

beforeEach( () => {
	vi.useRealTimers();
} );

afterEach( () => {
	vi.clearAllMocks();
	resetCurrentRows();
	window.sessionStorage.clear();
} );

describe( 'InlineEditor', () => {
	it( 'stays a bulk edit of the rows it saved after a partial failure, lists the failure and offers a retry', async () => {
		const three = [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ), simple( 3, { name: 'Three' } ) ];
		saveEdits.mockResolvedValueOnce( {
			updated: [ simple( 1, { featured: true } ), simple( 2, { featured: true } ) ],
			errors: [ { id: 3, code: 'rest_forbidden', message: 'You are not allowed to edit this item.' } ],
			batchId: 'b1',
			unchanged: 0,
			stockSkipped: 0,
			saleSkipped: 0,
			replacedSales: 0,
		} );

		const view = renderEditor( three );

		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );

		const featured = screen.getByLabelText( 'featured' ) as HTMLInputElement;

		fireEvent.click( featured );
		await screen.findByRole( 'button', { name: 'Update 3 products' } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update 3 products' } ) );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( saveEdits.mock.calls[ 0 ]?.[ 0 ] ).toHaveLength( 3 );

		// The list trims the saved rows from the selection; the editor does not follow once a save ran.
		view.rerenderWith( [ three[ 2 ]! ] );

		expect( screen.getByRole( 'heading', { name: 'Bulk edit 3 items' } ) ).toBeInTheDocument();
		expect( screen.getByText( '1 problem' ) ).toBeInTheDocument();
		// The rows were reloaded with their current values (the mock names them "Simple N").
		expect( screen.getAllByText( /Simple 3/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getAllByText( /not allowed/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getByRole( 'button', { name: 'Retry 1 failed' } ) ).toBeInTheDocument();
		expect( view.close ).not.toHaveBeenCalled();
		// The x buttons are gone: the list is fixed from the first save on.
		expect( screen.queryByRole( 'button', { name: /Remove .* from the selection/ } ) ).not.toBeInTheDocument();
		// The two rows that did save can be undone from the notice. The open editor lists who failed and why,
		// so the snackbar carries only the counts and expires (it never sits over Update as a persistent error).
		expect( notify.info ).toHaveBeenCalledWith( '2 updated, 1 failed.', expect.objectContaining( { id: 'wc-pl-saved', actions: expect.arrayContaining( [ expect.objectContaining( { label: 'Undo' } ) ] ) } ) );
		expect( notify.error ).not.toHaveBeenCalled();

		// The retry sends only the failed row.
		saveEdits.mockResolvedValueOnce( { updated: [ simple( 3, { featured: true } ) ], errors: [], batchId: 'b2', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Retry 1 failed' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 2 ) );
		expect( ( saveEdits.mock.calls[ 1 ]?.[ 0 ] as ProductListItem[] ).map( ( row ) => row.id ) ).toEqual( [ 3 ] );
		await waitFor( () => expect( view.close ).toHaveBeenCalled() );
	} );

	it( 'follows the live selection before a save: a ticked row joins the list and is loaded on its own, the x unticks one', async () => {
		const { listProducts } = await import( '../../resources/api/client' );
		const calls = listProducts as unknown as ReturnType< typeof vi.fn >;
		const view = renderEditor( [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		expect( calls ).toHaveBeenCalledTimes( 1 );
		expect( String( calls.mock.calls[ 0 ]?.[ 0 ]?.include ) ).toBe( '1,2' );

		// Something typed survives the selection change.
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		view.rerenderWith( [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ), simple( 3, { name: 'Three' } ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		await waitFor( () => expect( calls ).toHaveBeenCalledTimes( 2 ) );
		// Only the new row is fetched.
		expect( String( calls.mock.calls[ 1 ]?.[ 0 ]?.include ) ).toBe( '3' );
		await screen.findByRole( 'button', { name: 'Update 3 products' } );
		expect( ( screen.getByLabelText( 'featured' ) as HTMLInputElement ).checked ).toBe( true );

		const list = screen.getByRole( 'list', { name: 'Selected items' } );

		expect( list.querySelectorAll( 'li' ) ).toHaveLength( 3 );
		fireEvent.click( screen.getByRole( 'button', { name: 'Remove Simple 2 from the selection' } ) );
		expect( view.host.removeItem ).toHaveBeenCalledWith( 2 );

		// The screen unticks it; the editor shrinks with the selection.
		view.rerenderWith( [ simple( 1, { name: 'One' } ), simple( 3, { name: 'Three' } ) ] );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		expect( screen.getByRole( 'list', { name: 'Selected items' } ).querySelectorAll( 'li' ) ).toHaveLength( 2 );
	} );

	it( 'records the rows the save left out in the batch audit trail', async () => {
		saveEdits.mockResolvedValueOnce( {
			updated: [ simple( 1, { featured: true } ) ],
			errors: [],
			batchId: 'b-skip',
			unchanged: 0,
			stockSkipped: 1,
			saleSkipped: 0,
			replacedSales: 0,
			skippedItems: [ { id: 2, reason: 'no_stock_management', fields: [ 'stock_quantity' ] } ],
		} );

		renderEditor( [ simple( 1 ), simple( 2 ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		await screen.findByRole( 'button', { name: 'Update 2 products' } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update 2 products' } ) );

		await waitFor( () => expect( logSkipped ).toHaveBeenCalledTimes( 1 ) );
		expect( logSkipped ).toHaveBeenCalledWith( 'b-skip', 'bulk', [ { id: 2, reason: 'no_stock_management', fields: [ 'stock_quantity' ] } ] );
	} );

	it( 'shows the count alone when every product of the list is selected, and the off-page count otherwise', async () => {
		renderEditor( [ simple( 1 ), simple( 2 ) ], { wholeList: true, offPageCount: 1 } );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		expect( screen.getByText( 'Every product in the list (2) is selected.' ) ).toBeInTheDocument();
		expect( screen.queryByRole( 'list', { name: 'Selected items' } ) ).not.toBeInTheDocument();
	} );

	it( 'a row that no longer exists is reported in the open editor, not offered for retry, and leaves the list once the editor closes', async () => {
		const three = [ simple( 1 ), simple( 2 ), simple( 3, { name: 'Gone' } ) ];
		saveEdits.mockResolvedValueOnce( {
			updated: [ simple( 1 ), simple( 2 ) ],
			errors: [ { id: 3, code: 'woocommerce_rest_product_invalid_id', message: 'This product no longer exists (it was deleted).' } ],
			batchId: 'b1',
			unchanged: 0,
			stockSkipped: 0,
			saleSkipped: 0,
			replacedSales: 0,
		} );

		const view = renderEditor( three );

		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		await screen.findByRole( 'button', { name: 'Update 3 products' } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update 3 products' } ) );

		await screen.findAllByText( /leaves the list when this editor closes/ );
		// Named (with its reloaded name) in the editor's own list.
		expect( screen.getAllByText( /Simple 3/ ).length ).toBeGreaterThan( 0 );
		// Dropping the row now would change the selection under the open editor.
		expect( removeItems ).not.toHaveBeenCalled();
		expect( screen.getByRole( 'heading', { name: 'Bulk edit 3 items' } ) ).toBeInTheDocument();
		expect( screen.getByRole( 'button', { name: 'Close' } ) ).toBeInTheDocument();

		fireEvent.click( screen.getByRole( 'button', { name: 'Close' } ) );
		expect( view.close ).toHaveBeenCalled();

		view.unmount();
		expect( removeItems ).toHaveBeenCalledWith( [ 3 ] );
	} );

	it( 'Escape in a select closes only its dropdown; settings typed into a language tool count as unsaved', async () => {
		const withLanguage = coreFields().filter( ( field ) => [ 'name', 'featured', 'i18n:se.name' ].includes( field.id ) );
		const previous = settings.actions;

		settings.actions = [
			{
				id: 'i18n_transform',
				label: 'Edit translated text',
				description: '',
				icon: null,
				scope: 'both',
				supportsBulk: true,
				isPrimary: false,
				destructive: false,
				confirm: null,
				capability: null,
				group: 'i18n',
				order: 502,
				source: 'gds-woo-i18n',
				args: [
					{ id: 'lang', label: 'Language', type: 'select', required: true, default: null, options: [ { value: 'se', label: 'SE' } ] },
					{ id: 'operation', label: 'Operation', type: 'select', required: true, default: 'replace', options: [ { value: 'replace', label: 'Find & replace' }, { value: 'prefix', label: 'Add prefix' } ] },
					{ id: 'find', label: 'Find', type: 'text', required: true, default: null, options: [] },
				],
			},
		];

		try {
			const view = renderEditor( [ simple( 1, { name: 'One' } ) ], { fields: withLanguage, session: { initialTab: 'i18n:se' } } );

			await screen.findByText( 'One' );
			fireEvent.click( await screen.findByText( /tools: Edit translated text/ ) );

			// Chrome hands the Escape that closes a native select's dropdown to the page: it stays with the select.
			fireEvent.keyDown( screen.getByLabelText( 'Operation' ), { key: 'Escape' } );
			expect( view.close ).not.toHaveBeenCalled();

			fireEvent.change( screen.getByLabelText( 'Find' ), { target: { value: 'vinter' } } );
			fireEvent.keyDown( editorForm( view.container ), { key: 'Escape' } );

			expect( await screen.findByText( /Discard 1 unsaved change/ ) ).toBeInTheDocument();
			expect( view.close ).not.toHaveBeenCalled();
		} finally {
			settings.actions = previous;
		}
	} );

	it( 'keeps the loading line in the layout once loaded (nothing moves under a first click) and moves the snackbars aside while open', async () => {
		const view = renderEditor( [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ) ] );

		expect( document.documentElement.classList.contains( 'wc-pl-editing' ) ).toBe( true );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		await waitFor( () => expect( view.container.querySelector( '.wc-pl-inline-edit__loading.is-done' ) ).not.toBeNull() );
		// Beside the title in the item list, not above the fields.
		expect( view.container.querySelector( '.wc-pl-inline-edit__items .wc-pl-inline-edit__loading' ) ).not.toBeNull();
		expect( view.container.querySelector( '.wc-pl-inline-edit__main .wc-pl-inline-edit__loading' ) ).toBeNull();

		view.unmount();
		expect( document.documentElement.classList.contains( 'wc-pl-editing' ) ).toBe( false );
	} );

	it( 'Escape on a dirty form asks before discarding; a clean form closes', async () => {
		const view = renderEditor( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );

		const form = editorForm( view.container );

		fireEvent.keyDown( form, { key: 'Escape' } );
		await waitFor( () => expect( view.close ).toHaveBeenCalledTimes( 1 ) );
		expect( screen.queryByText( /Discard 1 unsaved change/ ) ).not.toBeInTheDocument();

		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.keyDown( form, { key: 'Escape' } );

		expect( await screen.findByText( /Discard 1 unsaved change/ ) ).toBeInTheDocument();
		expect( view.close ).toHaveBeenCalledTimes( 1 );

		fireEvent.click( screen.getByRole( 'button', { name: 'Keep editing' } ) );
		await waitFor( () => expect( screen.queryByText( /Discard 1 unsaved change/ ) ).not.toBeInTheDocument() );
		expect( view.close ).toHaveBeenCalledTimes( 1 );

		fireEvent.keyDown( form, { key: 'Escape' } );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Discard changes' } ) );
		await waitFor( () => expect( view.close ).toHaveBeenCalledTimes( 2 ) );
	} );

	it( 'answers the screen\'s leave guard: at once when clean, after the confirm when dirty', async () => {
		const view = renderEditor( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );

		const setGuard = view.host.setGuard as ReturnType< typeof vi.fn >;
		const guard = setGuard.mock.calls.at( -1 )?.[ 0 ] as () => Promise< boolean >;

		expect( typeof guard ).toBe( 'function' );
		await expect( guard() ).resolves.toBe( true );

		fireEvent.click( screen.getByLabelText( 'featured' ) );

		let answer: boolean | undefined;
		const pending = guard().then( ( ok ) => {
			answer = ok;
		} );

		expect( await screen.findByText( /Discard 1 unsaved change/ ) ).toBeInTheDocument();
		fireEvent.click( screen.getByRole( 'button', { name: 'Keep editing' } ) );
		await pending;
		expect( answer ).toBe( false );
		// The guard does not close the editor itself: the screen does, when it may.
		expect( view.close ).not.toHaveBeenCalled();

		const second = guard();

		fireEvent.click( await screen.findByRole( 'button', { name: 'Discard changes' } ) );
		await expect( second ).resolves.toBe( true );

		view.unmount();
		expect( setGuard ).toHaveBeenLastCalledWith( null );
	} );

	it( 'Enter in a single-line input updates', async () => {
		saveEdits.mockResolvedValueOnce( { updated: [ simple( 1, { name: 'Two' } ) ], errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		const view = renderEditor( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );

		const name = screen.getByLabelText( /^name/ ) as HTMLInputElement;

		fireEvent.change( name, { target: { value: 'Two' } } );
		fireEvent.keyDown( name, { key: 'Enter' } );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( saveEdits.mock.calls[ 0 ]?.[ 1 ] ).toEqual( { name: 'Two' } );
		await waitFor( () => expect( view.close ).toHaveBeenCalled() );
		// One fixed id: the next save's notice replaces this one instead of stacking under it.
		expect( notify.success ).toHaveBeenCalledWith( '1 item updated.', expect.objectContaining( { id: 'wc-pl-saved', actions: [ expect.objectContaining( { label: 'Undo' } ) ] } ) );
	} );

	it( 'focuses the first input when the form is there, and the row\'s place when it closes', async () => {
		// The table the editor sits in: its row keeps a button where the editor stood.
		const table = document.createElement( 'table' );

		table.className = 'dataviews-view-table';
		table.innerHTML = '<tbody><tr><td>x</td></tr><tr><td><button type="button">Actions</button></td></tr></tbody>';
		document.body.appendChild( table );

		const view = renderEditor( [ simple( 1, { name: 'One' } ) ], { session: { origin: { element: null, rowIndex: 1, label: null } } } );

		await screen.findByText( 'One' );
		await waitFor( () => expect( document.activeElement ).toBe( screen.getByLabelText( /^name/ ) ) );

		view.unmount();
		await waitFor( () => expect( document.activeElement ).toBe( table.querySelector( 'button' ) ) );
		table.remove();
	} );

	it( 'a failed save keeps keyboard focus inside the editor, on the report', async () => {
		saveEdits.mockResolvedValueOnce( {
			updated: [],
			errors: [ { id: 1, code: 'product_invalid_sku', message: 'This SKU is already used by another product.' } ],
			batchId: 'b1',
			unchanged: 0,
			stockSkipped: 0,
			saleSkipped: 0,
			replacedSales: 0,
		} );

		const view = renderEditor( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );
		fireEvent.change( screen.getByLabelText( /^name/ ), { target: { value: 'Two' } } );

		const button = screen.getByRole( 'button', { name: 'Update' } );

		button.focus();
		fireEvent.click( button );

		await screen.findByText( '1 problem' );
		await waitFor( () => expect( editorForm( view.container ).contains( document.activeElement ) ).toBe( true ) );
		expect( document.activeElement?.closest( '.wc-pl-edit__errors' ) ).not.toBeNull();
		expect( screen.getByRole( 'button', { name: 'Retry 1 failed' } ) ).toBeInTheDocument();
		expect( view.close ).not.toHaveBeenCalled();
	} );

	it( 'lists the problems of this Update attempt, not the previous one', async () => {
		const priced = coreFields()
			.filter( ( field ) => [ 'name', 'regular_price', 'sale_price', 'stock_quantity', 'manage_stock' ].includes( field.id ) )
			.map( ( field ) =>
				field.id === 'sale_price'
					? { ...field, isValid: { custom: ( item: Record< string, unknown > ) => ( item.sale_price === '' || Number( item.sale_price ) < Number( item.regular_price ) ? null : 'The sale price must be lower than the regular price.' ) } }
					: field
			);
		const row = simple( 1, { name: 'One', regular_price: '14', sale_price: '' } );
		const { listProducts } = await import( '../../resources/api/client' );

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async () => ( { items: [ row ], total: 0, totalPages: 1 } ) );
		renderEditor( [ row ], { fields: priced as typeof fields } );

		await screen.findByText( 'One' );

		fireEvent.change( screen.getByLabelText( /^sale_price/ ), { target: { value: '20' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update' } ) );
		await screen.findByText( '1 problem' );
		expect( screen.getAllByText( /must be lower/ ).length ).toBeGreaterThan( 0 );

		// The sale price is fixed and the quantity broken before the next attempt.
		fireEvent.change( screen.getByLabelText( /^sale_price/ ), { target: { value: '' } } );
		fireEvent.change( screen.getByLabelText( /^stock_quantity/ ), { target: { value: '-5' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update' } ) );

		await screen.findByText( '1 problem' );
		expect( screen.getAllByText( /cannot be negative/ ).length ).toBeGreaterThan( 0 );
		expect( screen.queryByText( /must be lower/ ) ).not.toBeInTheDocument();
		expect( saveEdits ).not.toHaveBeenCalled();
	} );

	it( 'a row trashed since the list loaded is left out with a notice and leaves the list when the editor closes', async () => {
		const { listProducts } = await import( '../../resources/api/client' );

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async ( query: Record< string, unknown > ) => ( {
			items: String( query.include )
				.split( ',' )
				.map( ( id ) => simple( Number( id ), { featured: false, status: id === '2' ? 'trash' : 'publish' } ) ),
			total: 0,
			totalPages: 1,
		} ) );

		const view = renderEditor( [ simple( 1 ), simple( 2, { name: 'Binned' } ), simple( 3 ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		expect( screen.getAllByText( /moved to the Trash meanwhile and was left out: Simple 2/ ).length ).toBeGreaterThan( 0 );
		expect( removeItems ).not.toHaveBeenCalled();

		view.unmount();
		expect( removeItems ).toHaveBeenCalledWith( [ 2 ] );
	} );

	it( 'a row picked on the Trash tab is still edited (it was in the trash when the list loaded)', async () => {
		const { listProducts } = await import( '../../resources/api/client' );

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async ( query: Record< string, unknown > ) => ( {
			items: String( query.include )
				.split( ',' )
				.map( ( id ) => simple( Number( id ), { featured: false, status: 'trash' } ) ),
			total: 0,
			totalPages: 1,
		} ) );

		renderEditor( [ simple( 1, { status: 'trash' } ), simple( 2, { status: 'trash' } ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		expect( screen.getAllByText( /are in the trash and will be updated too/ ).length ).toBeGreaterThan( 0 );
	} );

	it( '"Update & next" saves and asks the screen to move the editor on to the next row on screen', async () => {
		setCurrentRows( [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ), simple( 3, { name: 'Three' } ) ] );
		saveEdits.mockResolvedValueOnce( { updated: [ simple( 1, { featured: true } ) ], errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		const view = renderEditor( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update & next' } ) );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( ( saveEdits.mock.calls[ 0 ]?.[ 0 ] as ProductListItem[] ).map( ( row ) => row.id ) ).toEqual( [ 1 ] );
		await waitFor( () => expect( view.advance ).toHaveBeenCalledWith( expect.objectContaining( { id: 2 } ) ) );
		expect( view.close ).not.toHaveBeenCalled();

		// The last row on screen has no next.
		view.unmount();
		renderEditor( [ simple( 3, { name: 'Three' } ) ] );
		await screen.findByText( 'Three' );
		expect( screen.queryByRole( 'button', { name: 'Update & next' } ) ).not.toBeInTheDocument();
	} );

	it( 'a variation row gets the variation field set and a Variation badge in a bulk list', async () => {
		const { getVariations } = await import( '../../resources/api/client' );

		( getVariations as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async () => ( { items: [ variation( 11, 5, { name: 'Blue, 42' } ) ], total: 1, totalPages: 1 } ) );

		renderEditor( [ variation( 11, 5, { name: 'Blue, 42' } ), simple( 1 ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		expect( screen.getByText( 'Variation' ) ).toBeInTheDocument();
		// A parent-owned field (featured) is dropped once a variation is in the selection.
		expect( screen.queryByLabelText( 'featured' ) ).not.toBeInTheDocument();
	} );
} );

describe( 'InlineEditor tabs', () => {
	const withLanguage = coreFields().filter( ( field ) => [ 'name', 'featured', 'i18n:se.name' ].includes( field.id ) );

	beforeEach( () => {
		window.sessionStorage.clear();
	} );

	it( 'loads a language tab on its first visit only; the next editor opens on General', async () => {
		const { listProducts } = await import( '../../resources/api/client' );
		const calls = listProducts as unknown as ReturnType< typeof vi.fn >;
		const view = renderEditor( [ simple( 1, { name: 'One' } ) ], { fields: withLanguage } );

		await screen.findByText( 'One' );
		expect( calls ).toHaveBeenCalledTimes( 1 );
		// The General load leaves the language fields out.
		expect( String( calls.mock.calls[ 0 ]?.[ 0 ]?._fields ) ).not.toContain( 'i18n' );

		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await waitFor( () => expect( calls ).toHaveBeenCalledTimes( 2 ) );
		expect( String( calls.mock.calls[ 1 ]?.[ 0 ]?._fields ) ).toContain( 'i18n' );
		expect( String( calls.mock.calls[ 1 ]?.[ 0 ]?._fields ) ).not.toContain( 'featured' );
		await screen.findByLabelText( /i18n:se\.name/ );

		// Back and forth: nothing is fetched again.
		fireEvent.click( screen.getByRole( 'tab', { name: 'General' } ) );
		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		expect( calls ).toHaveBeenCalledTimes( 2 );

		view.unmount();
		// A new editor (a restock after a translation session) opens on General, not on the last language used.
		renderEditor( [ simple( 2, { name: 'Two' } ) ], { fields: withLanguage } );
		await screen.findByText( 'Two' );
		expect( screen.getByRole( 'tab', { name: 'General' } ) ).toHaveAttribute( 'aria-selected', 'true' );
		expect( String( calls.mock.calls[ 2 ]?.[ 0 ]?._fields ) ).not.toContain( 'i18n' );
	} );

	it( '"Update & next" carries the open tab to the next row\'s editor', async () => {
		setCurrentRows( [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ) ] );

		const view = renderEditor( [ simple( 1, { name: 'One' } ) ], { fields: withLanguage } );

		await screen.findByText( 'One' );
		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await screen.findByLabelText( /i18n:se\.name/ );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update & next' } ) );
		await waitFor( () => expect( view.advance ).toHaveBeenCalled() );

		view.unmount();
		renderEditor( [ simple( 2, { name: 'Two' } ) ], { fields: withLanguage } );
		await screen.findByText( 'Two' );
		expect( screen.getByRole( 'tab', { name: 'SE' } ) ).toHaveAttribute( 'aria-selected', 'true' );
	} );

	it( 'opens on the tab the list points at', async () => {
		renderEditor( [ simple( 1, { name: 'One' } ) ], { fields: withLanguage, session: { initialTab: 'i18n:se' } } );

		await screen.findByText( 'One' );
		expect( screen.getByRole( 'tab', { name: 'SE' } ) ).toHaveAttribute( 'aria-selected', 'true' );
	} );

	it( 'a row ticked while a language tab is open is loaded for every tab visited', async () => {
		const { listProducts } = await import( '../../resources/api/client' );
		const calls = listProducts as unknown as ReturnType< typeof vi.fn >;
		// A translated name is never bulk-edited; a translated price is.
		const bulkLanguage = coreFields().filter( ( field ) => [ 'name', 'featured', 'i18n:se.sale_price' ].includes( field.id ) );
		const view = renderEditor( [ simple( 1 ), simple( 2 ) ], { fields: bulkLanguage } );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await waitFor( () => expect( calls ).toHaveBeenCalledTimes( 2 ) );

		await act( async () => {
			view.rerenderWith( [ simple( 1 ), simple( 2 ), simple( 3 ) ] );
		} );
		await waitFor( () => expect( calls ).toHaveBeenCalledTimes( 3 ) );
		expect( String( calls.mock.calls[ 2 ]?.[ 0 ]?.include ) ).toBe( '3' );
		expect( String( calls.mock.calls[ 2 ]?.[ 0 ]?._fields ) ).toContain( 'i18n' );
		expect( String( calls.mock.calls[ 2 ]?.[ 0 ]?._fields ) ).toContain( 'featured' );
	} );
} );

describe( 'initialTabFor', () => {
	it( 'maps a translation filter to its language tab and ignores the rest', () => {
		expect( initialTabFor( [ { field: 'translation', value: 'missing:se' } ] ) ).toBe( 'i18n:se' );
		expect( initialTabFor( [ { field: 'translation', value: [ 'translated:DE' ] } ] ) ).toBe( 'i18n:de' );
		expect( initialTabFor( [ { field: 'status', value: 'draft' } ] ) ).toBeUndefined();
		expect( initialTabFor( undefined ) ).toBeUndefined();
	} );

	it( 'warns about rows that do not manage stock and offers to turn it on', async () => {
		const rows = [ simple( 1, { name: 'Managed', manage_stock: true, stock_quantity: 1 } ), simple( 2, { name: 'Loose', manage_stock: false, stock_quantity: null } ) ];
		const { listProducts } = await import( '../../resources/api/client' );

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async () => ( { items: rows, total: 0, totalPages: 1 } ) );

		renderEditor( rows );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

		const quantity = screen.getByLabelText( 'stock_quantity: value' );

		fireEvent.change( screen.getByLabelText( 'stock_quantity: operation' ), { target: { value: 'set' } } );
		fireEvent.change( quantity, { target: { value: '10' } } );

		expect( ( await screen.findAllByText( /1 of the 2 rows does not manage stock/ ) ).length ).toBeGreaterThan( 0 );
		expect( screen.getAllByText( /Loose/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getByRole( 'button', { name: 'Update 1 product' } ) ).toBeInTheDocument();

		fireEvent.click( screen.getByLabelText( /Turn on "Manage stock" for that row/ ) );

		await screen.findByRole( 'button', { name: 'Update 2 products' } );
	} );
} );

describe( 'InlineEditor, round 4', () => {
	const metaTitle = { ...coreFields().find( ( field ) => field.id === 'name' )!, id: 'i18n:se.short_description', label: 'SE short description', edit: { group: 'i18n:se', bulk: 'default' as const }, rest: { fields: [ 'i18n' ], applies: { product: true, variation: false } } };

	it( 'a language tab\'s load leaves variable products variable: the apply-to-variations box stays', async () => {
		const { listProducts } = await import( '../../resources/api/client' );
		const parents = [ simple( 219, { type: 'variable', name: 'Omaking Fresh', _hasChildren: true, _childCount: 4 } ), simple( 214, { type: 'variable', name: 'Omaking Wool', _hasChildren: true, _childCount: 3 } ) ];

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementation( async ( query: Record< string, unknown > ) => {
			const wanted = String( query._fields );
			const ids = String( query.include ).split( ',' ).map( Number );

			// The client normalises every row: without `type` in `_fields` it says "simple", without `name` "#id".
			return {
				items: ids.map( ( id ) =>
					wanted.includes( 'type' ) ? parents.find( ( row ) => row.id === id )! : { id, type: 'simple', name: `#${ id }`, status: 'publish', _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0, i18n: { se: { short_description: 'T' } } }
				),
				total: ids.length,
				totalPages: 1,
			};
		} );

		const priced = [ ...coreFields().filter( ( field ) => [ 'status', 'regular_price', 'sale_price' ].includes( field.id ) ), metaTitle ];

		renderEditor( parents, { fields: priced as typeof fields } );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		await screen.findByLabelText( /Apply price and sale fields/ );

		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await waitFor( () => expect( ( listProducts as unknown as ReturnType< typeof vi.fn > ).mock.calls.some( ( [ query ] ) => ! String( query._fields ).includes( 'type' ) ) ).toBe( true ) );
		await waitFor( () => expect( screen.getByRole( 'tabpanel' ) ).toHaveAttribute( 'aria-busy', 'false' ) );
		fireEvent.click( screen.getByRole( 'tab', { name: 'General' } ) );

		expect( screen.getByLabelText( /Apply price and sale fields/ ) ).toBeInTheDocument();
		expect( screen.getAllByText( 'Variable' ) ).toHaveLength( 2 );
		expect( screen.getAllByText( 'Omaking Fresh' ).length ).toBeGreaterThan( 0 );
		expect( screen.queryByText( '#219' ) ).not.toBeInTheDocument();

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockReset();
	} );

	it( 'names a variation by its parent and SKU in the bulk list', async () => {
		const { getVariations } = await import( '../../resources/api/client' );

		// The reload answers without the parent's name (a variation request knows only the parent id).
		( getVariations as unknown as ReturnType< typeof vi.fn > ).mockImplementation( async ( parentId: number, _page: number, options: { params: { include: string } } ) => ( {
			items: options.params.include.split( ',' ).map( ( id ) => variation( Number( id ), parentId, { name: 'Black, 36', sku: undefined } ) ),
			total: 1,
			totalPages: 1,
		} ) );

		renderEditor( [ variation( 41, 4, { name: 'Black, 36', _parentName: 'Koel Gavien', sku: 'KG-36' } ), variation( 51, 5, { name: 'Black, 36', _parentName: 'Koel Dry', sku: 'KD-36' } ) ] );

		const list = await screen.findByRole( 'list', { name: 'Selected items' } );

		expect( list.textContent ).toContain( 'Koel Gavien' );
		expect( list.textContent ).toContain( 'Koel Dry' );
		expect( list.textContent ).toContain( 'KG-36' );
		expect( list.querySelector( '[title="Koel Gavien – Black, 36 · KG-36"]' ) ).not.toBeNull();

		( getVariations as unknown as ReturnType< typeof vi.fn > ).mockImplementation( async () => ( { items: [], total: 0, totalPages: 1 } ) );
	} );

	it( 'leaves out a product trashed after the editor loaded it, and says so', async () => {
		const { listProducts } = await import( '../../resources/api/client' );
		const mock = listProducts as unknown as ReturnType< typeof vi.fn >;
		const original = mock.getMockImplementation();

		mock.mockImplementation( async ( query: Record< string, unknown > ) => ( {
			items: String( query.include )
				.split( ',' )
				.map( ( id ) => simple( Number( id ), { featured: false, status: query._fields === 'id,status' && id === '2' ? 'trash' : 'publish' } ) ),
			total: 0,
			totalPages: 1,
		} ) );
		saveEdits.mockResolvedValueOnce( { updated: [ simple( 1 ), simple( 3 ) ], errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		renderEditor( [ simple( 1 ), simple( 2 ), simple( 3 ) ] );

		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update 3 products' } ) );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( ( saveEdits.mock.calls[ 0 ]?.[ 0 ] as ProductListItem[] ).map( ( row ) => row.id ) ).toEqual( [ 1, 3 ] );
		await waitFor( () => expect( notify.success ).toHaveBeenCalledWith( expect.stringMatching( /2 items updated, 1 skipped \(moved to the Trash meanwhile\)\. Skipped: Simple 2/ ), expect.anything() ) );

		mock.mockImplementation( original! );
	} );

	it( 'asks the browser before the page is left with typed changes', async () => {
		renderEditor( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );

		const clean = new Event( 'beforeunload', { cancelable: true } );

		window.dispatchEvent( clean );
		expect( clean.defaultPrevented ).toBe( false );

		fireEvent.click( screen.getByLabelText( 'featured' ) );

		const dirty = new Event( 'beforeunload', { cancelable: true } );

		window.dispatchEvent( dirty );
		expect( dirty.defaultPrevented ).toBe( true );
	} );

	it( 'flags every invalid field and focuses the first one on the form, not the last flagged', async () => {
		const row = simple( 1, { name: 'One', stock_quantity: 3 } );
		const { listProducts } = await import( '../../resources/api/client' );

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async () => ( { items: [ row ], total: 0, totalPages: 1 } ) );

		renderEditor( [ row ] );

		const name = ( await screen.findByLabelText( /^name/ ) ) as HTMLInputElement;

		fireEvent.change( name, { target: { value: '' } } );
		fireEvent.change( screen.getByLabelText( /^stock_quantity/ ), { target: { value: '-5' } } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Update' } ) );

		await screen.findByText( '2 problems' );
		await waitFor( () => expect( document.activeElement ).toBe( name ) );
		expect( name ).toHaveAttribute( 'aria-invalid', 'true' );
		expect( screen.getByLabelText( /^stock_quantity/ ) ).toHaveAttribute( 'aria-invalid', 'true' );
		expect( name.getAttribute( 'aria-describedby' ) ).toContain( 'wc-pl-invalid-name' );
		// The problem list links to the fields.
		expect( screen.getByRole( 'button', { name: 'stock_quantity' } ) ).toBeInTheDocument();
		expect( saveEdits ).not.toHaveBeenCalled();
	} );
} );
