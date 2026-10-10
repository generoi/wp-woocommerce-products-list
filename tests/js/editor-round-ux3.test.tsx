/**
 * Layout round 3: the stock fields follow Manage stock as on WooCommerce's
 * product screen; a bulk stock status no selected row would take is not a
 * dead end (the Inventory card says what to do instead, with a shortcut);
 * why a stock edit is skipped sits in Inventory and beside the greyed-out
 * Update.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, field, simple, variable } from './edit-fixtures';

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
	closeBatch: vi.fn( async () => undefined ),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const client = await import( '../../resources/api/client' );
const getVariations = client.getVariations as unknown as ReturnType< typeof vi.fn >;
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;

const options = [ { value: 'instock', label: 'In stock' }, { value: 'outofstock', label: 'Out of stock' } ];
const stock = [
	...coreFields().filter( ( entry ) => [ 'name', 'status', 'stock_quantity', 'manage_stock' ].includes( entry.id ) ),
	field( 'stock_status', { elements: options, rest: { fields: [ 'stock_status' ], applies: { product: true, variation: true } }, edit: { group: 'inventory', bulk: 'default' } } ),
	field( 'tax_status', { elements: [ { value: 'taxable', label: 'Taxable' } ], rest: { fields: [ 'tax_status' ], applies: { product: true, variation: true } }, edit: { group: 'tax', bulk: 'default' } } ),
] as ReturnType< typeof coreFields >;

function hostFor( items: ProductListItem[], fields = stock, session: Partial< EditorSession > = {} ): EditorHost {
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

describe( 'stock fields in a quick edit', () => {
	it( 'shows the quantity only once Manage stock is ticked, as WooCommerce does', async () => {
		const row = simple( 61, { manage_stock: false, stock_quantity: null } );

		answerLists( [ row ] );
		render( <InlineEditor host={ hostFor( [ row ] ) } /> );

		const manage = await screen.findByLabelText( 'manage_stock' );

		expect( screen.queryByLabelText( 'stock_quantity' ) ).not.toBeInTheDocument();
		expect( screen.getByLabelText( 'stock_status' ) ).toBeInTheDocument();
		expect( screen.getByText( 'Track stock quantity for this product.' ) ).toBeInTheDocument();

		fireEvent.click( manage );

		expect( await screen.findByLabelText( 'stock_quantity' ) ).toBeInTheDocument();
		expect( screen.queryByLabelText( 'stock_status' ) ).not.toBeInTheDocument();
	} );
} );

describe( 'bulk stock status', () => {
	it( 'is not offered when every selected item manages stock, and Inventory offers to set the quantity to 0 instead', async () => {
		const rows = [ simple( 71, { manage_stock: true, stock_quantity: 4 } ), simple( 72, { manage_stock: true, stock_quantity: 2 } ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		await screen.findByLabelText( 'stock_quantity: operation' );

		expect( screen.queryByLabelText( 'stock_status' ) ).not.toBeInTheDocument();

		const note = await screen.findByText( /these items manage stock, so their quantity decides it/ );

		expect( note.closest( '.dataforms-layouts-card__field' )?.textContent ).toMatch( /Inventory/ );

		fireEvent.click( screen.getByRole( 'button', { name: 'Set Stock quantity to 0' } ) );

		await waitFor( () => expect( ( screen.getByLabelText( 'stock_quantity: operation' ) as HTMLSelectElement ).value ).toBe( 'set' ) );
		expect( ( screen.getByLabelText( 'stock_quantity: value' ) as HTMLInputElement ).value ).toBe( '0' );
		expect( screen.queryByRole( 'button', { name: 'Set Stock quantity to 0' } ) ).not.toBeInTheDocument();
	} );

	it( 'says where a variable product\'s stock status is set when only variable products are selected', async () => {
		const rows = [ variable( 73 ), variable( 74 ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		await screen.findByLabelText( 'tax_status' );

		expect( await screen.findByText( /a variable product takes it from its variations/ ) ).toBeInTheDocument();
	} );
} );

describe( 'a stock edit on items that do not manage stock', () => {
	it( 'says so in the Inventory card and next to the greyed-out Update', async () => {
		const rows = [ variable( 81, { manage_stock: false } ), variable( 82, { manage_stock: false } ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );

		fireEvent.change( await screen.findByLabelText( 'stock_quantity: value' ), { target: { value: '5' } } );

		// The notice's text, and its copy in the spoken live region.
		const warnings = await screen.findAllByText( /2 of the 2 rows do not manage stock/ );

		expect( warnings.some( ( warning ) => /Inventory/.test( warning.closest( '.dataforms-layouts-card__field' )?.textContent ?? '' ) ) ).toBe( true );
		expect( await screen.findByText( /Nothing to update: none of these items manages stock/ ) ).toBeInTheDocument();
	} );
} );
