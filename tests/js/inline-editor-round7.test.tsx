/**
 * Round 7: the apply-to-variations load is keyed on the parents, not on the
 * rows' identity (a tab switch or a list patch never refetches, a superseded
 * load is aborted), Escape works right after a bulk edit opens, and a row
 * deleted meanwhile is named and left out.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-rows';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), removeItems: vi.fn(), invalidateProducts: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn(),
	listProducts: vi.fn(),
	newBatchId: vi.fn( () => 'batch-shared' ),
	runAction: vi.fn(),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const client = await import( '../../resources/api/client' );
const getVariations = client.getVariations as unknown as ReturnType< typeof vi.fn >;
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;
const runAction = client.runAction as unknown as ReturnType< typeof vi.fn >;

const seName = {
	...coreFields().find( ( field ) => field.id === 'name' )!,
	id: 'i18n:se.short_description',
	label: 'SE short description',
	edit: { group: 'i18n:se', bulk: 'default' as const },
	rest: { fields: [ 'i18n' ], applies: { product: true, variation: false } },
};
const priced = [ ...coreFields().filter( ( field ) => [ 'status', 'regular_price', 'sale_price' ].includes( field.id ) ), seName ] as ReturnType< typeof coreFields >;

function hostFor( items: ProductListItem[], fields = priced, session: Partial< EditorSession > = {} ): EditorHost {
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
	};
}

function answerLists( rows: ProductListItem[] ) {
	listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
		const ids = String( query.include ).split( ',' ).map( Number );

		return { items: ids.map( ( id ) => rows.find( ( row ) => row.id === id ) ?? simple( id ) ), total: ids.length, totalPages: 1 };
	} );
}

afterEach( () => {
	vi.clearAllMocks();
	listProducts.mockReset();
	getVariations.mockReset();
} );

describe( 'apply to all variations', () => {
	it( 'fetches each parent’s variations once: tab switches and list patches neither refetch nor block Update', async () => {
		const parents = [ variable( 21, { name: 'Koel A' } ), variable( 22, { name: 'Koel B' } ) ];

		answerLists( parents );
		getVariations.mockImplementation( async ( parentId: number ) => ( {
			items: [ variation( parentId * 10 + 1, parentId, { regular_price: '20', sale_price: '' } ), variation( parentId * 10 + 2, parentId, { regular_price: '30', sale_price: '' } ) ],
			total: 2,
			totalPages: 1,
		} ) );

		const host = hostFor( parents );
		const view = render( <InlineEditor host={ host } /> );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( await screen.findByLabelText( /Apply price and sale fields/ ) );
		await screen.findByText( /will apply to 4 variations of 2 variable products/ );
		expect( getVariations ).toHaveBeenCalledTimes( 2 );

		// A language tab loads (the rows merge in new objects) and back.
		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await waitFor( () => expect( screen.getByRole( 'tabpanel' ) ).toHaveAttribute( 'aria-busy', 'false' ) );
		fireEvent.click( screen.getByRole( 'tab', { name: 'General' } ) );

		// The list patched its cache: the same rows as new objects.
		await act( async () => {
			view.rerender( <InlineEditor host={ { ...host, items: parents.map( ( row ) => ( { ...row } ) ) } } /> );
		} );

		expect( screen.getByText( /will apply to 4 variations of 2 variable products/ ) ).toBeInTheDocument();
		expect( screen.queryByText( /Loading variations/ ) ).not.toBeInTheDocument();
		expect( getVariations ).toHaveBeenCalledTimes( 2 );

		// A third parent joins: only that one is fetched.
		const third = variable( 23, { name: 'Koel C' } );

		answerLists( [ ...parents, third ] );
		await act( async () => {
			view.rerender( <InlineEditor host={ { ...host, items: [ ...parents, third ] } } /> );
		} );
		await screen.findByText( /will apply to 6 variations of 3 variable products/ );
		expect( getVariations ).toHaveBeenCalledTimes( 3 );
		expect( getVariations.mock.calls[ 2 ]?.[ 0 ] ).toBe( 23 );
	} );

	it( 'aborts a load that is no longer wanted', async () => {
		const parents = [ variable( 31 ), variable( 32 ) ];
		const signals: AbortSignal[] = [];

		answerLists( parents );
		getVariations.mockImplementation(
			( _parentId: number, _page: number, options: { signal: AbortSignal } ) =>
				new Promise( ( _resolve, reject ) => {
					signals.push( options.signal );
					options.signal.addEventListener( 'abort', () => reject( new DOMException( 'Aborted', 'AbortError' ) ) );
				} )
		);

		render( <InlineEditor host={ hostFor( parents ) } /> );

		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

		const box = await screen.findByLabelText( /Apply price and sale fields/ );

		fireEvent.click( box );
		await waitFor( () => expect( signals ).toHaveLength( 2 ) );
		fireEvent.click( box );

		expect( signals.every( ( signal ) => signal.aborted ) ).toBe( true );
	} );
} );

describe( 'Escape and deleted rows', () => {
	const plain = coreFields().filter( ( field ) => [ 'name', 'status', 'featured' ].includes( field.id ) );

	it( 'Escape right after a bulk editor opens cancels, even with focus on a closed select; an open dropdown keeps one Escape', async () => {
		const rows = [ simple( 1 ), simple( 2 ) ];

		answerLists( rows );

		const host = hostFor( rows, coreFields().filter( ( field ) => [ 'name', 'stock_quantity', 'manage_stock' ].includes( field.id ) ) );

		render( <InlineEditor host={ host } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

		const select = ( await screen.findByLabelText( 'stock_quantity: operation' ) ) as HTMLSelectElement;

		expect( select.tagName ).toBe( 'SELECT' );
		select.focus();

		// Opened by a press: the Escape closes the dropdown only.
		fireEvent.mouseDown( select );
		fireEvent.keyDown( select, { key: 'Escape' } );
		expect( host.close ).not.toHaveBeenCalled();

		// Closed (the previous Escape closed it): the next Escape cancels the clean editor.
		fireEvent.keyDown( select, { key: 'Escape' } );
		await waitFor( () => expect( host.close ).toHaveBeenCalled() );
	} );

	it( 'names a variation deleted meanwhile, does not offer it for retry, and leaves nothing to discard', async () => {
		const rows = [ simple( 1, { name: 'Kept' } ), simple( 2, { name: 'Other' } ) ];
		const host = hostFor( rows, plain );

		answerLists( rows );
		saveEdits.mockResolvedValueOnce( {
			updated: [ simple( 1, { featured: true } ) ],
			errors: [ { id: 2, code: 'woocommerce_rest_product_variation_invalid_id', message: 'Invalid variation ID.' } ],
			batchId: 'b7',
			unchanged: 0,
			stockSkipped: 0,
			saleSkipped: 0,
			replacedSales: 0,
		} );

		render( <InlineEditor host={ host } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update 2 products' } ) );

		await screen.findAllByText( /deleted meanwhile and was left out/ );
		expect( screen.getByRole( 'button', { name: 'Close' } ) ).toBeInTheDocument();
		expect( screen.queryByRole( 'button', { name: /Retry/ } ) ).not.toBeInTheDocument();

		// Escape closes without "Discard … unsaved changes?": what was typed is saved.
		fireEvent.keyDown( document.querySelector( 'form.wc-pl-edit' )!, { key: 'Escape' } );
		await waitFor( () => expect( host.close ).toHaveBeenCalled() );
		expect( screen.queryByText( /Discard/ ) ).not.toBeInTheDocument();
	} );
} );

describe( 'relative price ops and rows changed meanwhile', () => {
	it( 'stops before writing when a row was saved by someone else since the editor loaded it, reloads it, and saves on the next Update', async () => {
		const pricedFields = coreFields().filter( ( field ) => [ 'name', 'regular_price', 'sale_price' ].includes( field.id ) );
		let stamp = '2026-10-09T01:00:00';
		let regular = '14.70';
		const fresh = ( id: number ) => simple( id, { regular_price: id === 1 ? regular : '20', sale_price: '', date_modified_gmt: id === 1 ? stamp : '2026-10-01T00:00:00' } );

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );

			return { items: ids.map( fresh ), total: ids.length, totalPages: 1 };
		} );
		saveEdits.mockResolvedValue( { updated: [ fresh( 1 ), fresh( 2 ) ], errors: [], batchId: 'b8', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		const host = hostFor( [ simple( 1 ), simple( 2 ) ], pricedFields );

		render( <InlineEditor host={ host } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		await waitFor( () => expect( listProducts ).toHaveBeenCalled() );

		fireEvent.change( screen.getByLabelText( 'regular_price: operation' ), { target: { value: 'decrease' } } );
		fireEvent.change( screen.getByLabelText( 'regular_price: value' ), { target: { value: '1' } } );

		// Another user reverts row 1 meanwhile.
		stamp = '2026-10-09T01:44:16';
		regular = '14';

		fireEvent.click( await screen.findByRole( 'button', { name: /^Update 2/ } ) );

		expect( ( await screen.findAllByText( /1 row changed since this editor loaded it/ ) ).length ).toBeGreaterThan( 0 );
		expect( saveEdits ).not.toHaveBeenCalled();

		// The next Update works on the reloaded value (14, not 14.70).
		fireEvent.click( await screen.findByRole( 'button', { name: /^Update 2/ } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );

		const sent = saveEdits.mock.calls[ 0 ]?.[ 0 ] as ProductListItem[];

		expect( sent.find( ( row ) => row.id === 1 )?.regular_price ).toBe( '14' );
	} );
} );

describe( 'bulk numeric control layout', () => {
	it( 'keeps the rounding row and the note slot in the layout whatever the operation, so nothing below moves', async () => {
		const { createBulkNumericControl } = await import( '../../resources/edit/bulk-numeric-control' );
		const Control = createBulkNumericControl( { kind: 'money', settings, salePrice: true } );
		const field = { id: 'sale_price', label: 'Sale price' } as never;
		const shape = ( container: HTMLElement ) => ( {
			selects: container.querySelectorAll( 'select' ).length,
			round: container.querySelectorAll( '.wc-pl-bulk-numeric__round' ).length,
			note: container.querySelectorAll( '.wc-pl-bulk-numeric__note' ).length,
		} );

		const idle = render( <Control data={ {} } field={ field } onChange={ vi.fn() } /> );
		const before = shape( idle.container );

		idle.unmount();

		const minus = render( <Control data={ { sale_price: { operation: 'regular_minus', value: '15', percent: true } } } field={ field } onChange={ vi.fn() } /> );

		expect( shape( minus.container ) ).toEqual( before );
		expect( minus.container.querySelector( '.wc-pl-bulk-numeric__round.is-inactive' ) ).toBeNull();
		minus.unmount();

		const rounded = render( <Control data={ { sale_price: { operation: 'regular_minus', value: '15', percent: true, round: '90' } } } field={ field } onChange={ vi.fn() } /> );

		expect( shape( rounded.container ) ).toEqual( before );
		expect( rounded.container.querySelector( '.wc-pl-bulk-numeric__round-mode.is-inactive' ) ).toBeNull();
		expect( before ).toEqual( { selects: 3, round: 1, note: 1 } );
	} );
} );

describe( 'language tools with Update', () => {
	const transform = {
		id: 'i18n_transform',
		label: 'Edit translated text',
		description: '',
		icon: null,
		scope: 'both' as const,
		supportsBulk: true,
		isPrimary: false,
		destructive: false,
		confirm: null,
		capability: null,
		group: 'i18n',
		order: 502,
		source: 'gds-woo-i18n',
		args: [
			{ id: 'lang', label: 'Language', type: 'select' as const, required: true, default: null, options: [ { value: 'se', label: 'SE' } ] },
			{ id: 'operation', label: 'Operation', type: 'select' as const, required: true, default: 'prefix', options: [ { value: 'replace', label: 'Find & replace' }, { value: 'prefix', label: 'Add prefix' } ] },
			{ id: 'text', label: 'Text', type: 'text' as const, required: false, default: null, options: [] },
		],
	};
	const fieldsWithTab = [ ...coreFields().filter( ( field ) => [ 'name', 'featured' ].includes( field.id ) ), seName ] as ReturnType< typeof coreFields >;

	it( 'stages a tool run and saves it with the field edits under one History batch, with one snackbar', async () => {
		const previous = settings.actions;

		settings.actions = [ transform ] as unknown as typeof settings.actions;

		try {
			const rows = [ simple( 1 ), simple( 2 ) ];

			answerLists( rows );
			runAction.mockResolvedValue( { batch_id: 'batch-shared', results: [ { id: 1, ok: true }, { id: 2, ok: true } ], items: [] } );
			saveEdits.mockResolvedValue( { updated: [ simple( 1, { featured: true } ), simple( 2, { featured: true } ) ], errors: [], batchId: 'batch-shared', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

			const host = hostFor( rows, fieldsWithTab, { initialTab: 'i18n:se' } );

			render( <InlineEditor host={ host } /> );
			await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

			fireEvent.change( await screen.findByLabelText( 'Text' ), { target: { value: 'NEW ' } } );
			fireEvent.click( screen.getByRole( 'button', { name: /Edit translated text: SE, add to Update/ } ) );

			// Nothing ran yet: it waits for Update, and is listed next to it.
			expect( runAction ).not.toHaveBeenCalled();
			expect( screen.getByText( 'Also saved with Update:' ) ).toBeInTheDocument();

			fireEvent.click( screen.getByRole( 'tab', { name: 'General' } ) );
			fireEvent.click( await screen.findByLabelText( 'featured' ) );

			fireEvent.click( await screen.findByRole( 'button', { name: /\+ 1 language change$/ } ) );

			await waitFor( () => expect( runAction ).toHaveBeenCalledTimes( 1 ) );
			expect( saveEdits ).toHaveBeenCalledTimes( 1 );
			expect( saveEdits.mock.calls[ 0 ]?.[ 3 ] ).toMatchObject( { batchId: 'batch-shared' } );
			expect( runAction.mock.calls[ 0 ]?.[ 0 ] ).toBe( 'i18n_transform' );
			expect( runAction.mock.calls[ 0 ]?.[ 2 ] ).toMatchObject( { lang: 'se', operation: 'prefix', text: 'NEW ' } );
			expect( runAction.mock.calls[ 0 ]?.[ 3 ] ).toMatchObject( { batchId: 'batch-shared' } );
			await waitFor( () => expect( notify.success ).toHaveBeenCalledTimes( 1 ) );
			expect( String( notify.success.mock.calls[ 0 ]?.[ 0 ] ) ).toContain( '1 language change applied.' );
			expect( host.close ).toHaveBeenCalled();
		} finally {
			settings.actions = previous;
		}
	} );

	it( 'a staged tool alone is an Update of its own, and counts as unsaved until then', async () => {
		const previous = settings.actions;

		settings.actions = [ transform ] as unknown as typeof settings.actions;

		try {
			const rows = [ simple( 1 ), simple( 2 ) ];

			answerLists( rows );
			runAction.mockResolvedValue( { batch_id: 'batch-shared', results: [ { id: 1, ok: true }, { id: 2, ok: true } ], items: [] } );

			const host = hostFor( rows, fieldsWithTab, { initialTab: 'i18n:se' } );

			render( <InlineEditor host={ host } /> );
			await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
			fireEvent.change( await screen.findByLabelText( 'Text' ), { target: { value: 'NEW ' } } );
			fireEvent.click( screen.getByRole( 'button', { name: /add to Update/ } ) );

			fireEvent.keyDown( document.querySelector( 'form.wc-pl-edit' )!, { key: 'Escape' } );
			expect( await screen.findByText( /Discard 1 unsaved change/ ) ).toBeInTheDocument();
			fireEvent.click( screen.getByRole( 'button', { name: /Keep editing|Cancel/ } ) );

			fireEvent.click( await screen.findByRole( 'button', { name: 'Apply 1 language change' } ) );
			await waitFor( () => expect( runAction ).toHaveBeenCalledTimes( 1 ) );
			expect( saveEdits ).not.toHaveBeenCalled();
			await waitFor( () => expect( host.close ).toHaveBeenCalled() );
		} finally {
			settings.actions = previous;
		}
	} );
} );
