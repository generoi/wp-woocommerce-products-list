/**
 * The "Translate product by product" grid inside a bulk edit: texts typed
 * into it count as language changes of the Update, but they are not staged
 * tool runs, so the "Also saved with Update:" list (of tool runs) stays away
 * instead of showing an empty heading.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { ProductField, ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

// A language tool gives the bulk edit its language tab (names are not bulk fields), as gds-woo-i18n's do.
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
		{ id: 'lang', label: 'Language', type: 'select' as const, required: true, default: null, options: [ { value: 'se', label: 'Svenska' } ] },
		{ id: 'text', label: 'Text', type: 'text' as const, required: false, default: null, options: [] },
	],
};
const settings = editSettings( { languages: { default: 'fi', others: [ 'se' ], labels: { fi: 'Suomi', se: 'Svenska' } }, actions: [ transform ] } as never );
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), removeItems: vi.fn(), invalidateProducts: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn(),
	listProducts: vi.fn(),
	newBatchId: vi.fn( () => 'batch-shared' ),
	runAction: vi.fn(),
	closeBatch: vi.fn( async () => undefined ),
	batchProducts: vi.fn(),
	toRow: ( row: unknown ) => row,
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: vi.fn(), saveFields: () => [ 'id', 'i18n' ] } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const client = await import( '../../resources/api/client' );
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;
const batchProducts = client.batchProducts as unknown as ReturnType< typeof vi.fn >;
const store = await import( '../../resources/store/products' );
const patchItems = store.patchItems as unknown as ReturnType< typeof vi.fn >;

const seName = {
	...coreFields().find( ( field ) => field.id === 'name' )!,
	id: 'i18n:se.name',
	label: 'Svenska: Name',
	edit: { group: 'i18n:se', bulk: 'default' as const },
	rest: {
		fields: [ 'i18n' ],
		applies: { product: true, variation: false },
	},
} as unknown as ProductField;
const fields = [ ...coreFields().filter( ( field ) => [ 'name', 'status' ].includes( field.id ) ), seName ] as ProductField[];

function withSe( id: number, name: string ): ProductListItem {
	return { ...simple( id ), i18n: { se: { name } } } as unknown as ProductListItem;
}

afterEach( () => {
	vi.clearAllMocks();
	listProducts.mockReset();
} );

describe( 'translation grid in bulk edit', () => {
	it( 'counts a typed text as a language change without an empty "Also saved with Update:" list', async () => {
		const rows = [ withSe( 1, 'Produkt 1' ), withSe( 2, 'Produkt 2' ) ];

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );

			return { items: ids.map( ( id ) => rows.find( ( row ) => row.id === id ) ?? simple( id ) ), total: ids.length, totalPages: 1 };
		} );

		const host: EditorHost = {
			session: { mode: 'bulk', origin: null, initialTab: 'i18n:se' } as never,
			fields,
			items: rows,
			offPageCount: 0,
			wholeList: false,
			close: vi.fn(),
			advance: vi.fn(),
			removeItem: vi.fn(),
			setGuard: vi.fn(),
		};

		render( <InlineEditor host={ host } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

		fireEvent.click( await screen.findByText( /Translate product by product/ ) );
		const details = screen.getByText( /Translate product by product/ ).closest( 'details' ) as HTMLDetailsElement;

		details.open = true;
		fireEvent( details, new Event( 'toggle' ) );

		await waitFor( () => expect( document.querySelectorAll( 'input[data-grid-col="name"]' ).length ).toBe( 2 ) );
		const names = Array.from( document.querySelectorAll< HTMLInputElement >( 'input[data-grid-col="name"]' ) );

		fireEvent.change( names[ 0 ]!, { target: { value: 'Produkt ett' } } );

		expect( await screen.findByRole( 'button', { name: 'Apply 1 language change' } ) ).toBeInTheDocument();
		expect( screen.queryByText( 'Also saved with Update:' ) ).toBeNull();
		expect( document.querySelector( '.wc-pl-edit__staged' ) ).toBeNull();
	} );

	it( 'shows the stored translation in the list after the grid is refused for a change made by someone else', async () => {
		const rows = [ withSe( 1, 'Produkt 1' ), withSe( 2, 'Produkt 2' ) ];
		let stored = rows;

		// The server trims each row to `_fields`: a re-read that does not ask for the translations gets none.
		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );
			const asked = String( query._fields ?? '' ).split( ',' );
			const trim = ( row: ProductListItem ) => {
				if ( asked.some( ( key ) => key === 'i18n' || key.startsWith( 'i18n.' ) ) ) {
					return row;
				}

				const { i18n: _dropped, ...rest } = row as ProductListItem & { i18n?: unknown };

				return rest as ProductListItem;
			};

			return { items: ids.map( ( id ) => trim( stored.find( ( row ) => row.id === id ) ?? simple( id ) ) ), total: ids.length, totalPages: 1 };
		} );
		batchProducts.mockResolvedValueOnce( {
			update: [ { id: 1, error: { code: 'wc_products_list_conflict', message: 'Changed by someone else.', data: { status: 409, fields: [ 'i18n.se.name' ], current: { 'i18n.se.name': 'EXTERNAL' }, expected: { 'i18n.se.name': 'Produkt 1' } } } } ],
		} );

		const host: EditorHost = {
			session: { mode: 'bulk', origin: null, initialTab: 'i18n:se' } as never,
			fields,
			items: rows,
			offPageCount: 0,
			wholeList: false,
			close: vi.fn(),
			advance: vi.fn(),
			removeItem: vi.fn(),
			setGuard: vi.fn(),
		};

		render( <InlineEditor host={ host } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

		fireEvent.click( await screen.findByText( /Translate product by product/ ) );
		const details = screen.getByText( /Translate product by product/ ).closest( 'details' ) as HTMLDetailsElement;

		details.open = true;
		fireEvent( details, new Event( 'toggle' ) );

		await waitFor( () => expect( document.querySelectorAll( 'input[data-grid-col="name"]' ).length ).toBe( 2 ) );
		fireEvent.change( document.querySelectorAll< HTMLInputElement >( 'input[data-grid-col="name"]' )[ 0 ]!, { target: { value: 'Produkt ett' } } );

		// Someone else saves the Swedish name meanwhile.
		stored = [ withSe( 1, 'EXTERNAL' ), rows[ 1 ]! ];
		patchItems.mockClear();
		fireEvent.click( await screen.findByRole( 'button', { name: 'Apply 1 language change' } ) );

		await waitFor( () => expect( batchProducts ).toHaveBeenCalledTimes( 1 ) );
		await waitFor( () =>
			expect( patchItems.mock.calls.flat( 2 ).some( ( row ) => ( row as { id: number; i18n?: { se?: { name?: string } } } ).id === 1 && ( row as { i18n?: { se?: { name?: string } } } ).i18n?.se?.name === 'EXTERNAL' ) ).toBe( true )
		);
	} );
} );
