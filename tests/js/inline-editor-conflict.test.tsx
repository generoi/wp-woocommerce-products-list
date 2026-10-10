/**
 * A quick or bulk edit refused because someone else changed the row since
 * it was loaded (409 wc_products_list_conflict): the problem list shows the
 * value stored now next to the value the editor loaded, the form keeps the
 * user's values, and the retry is an explicit overwrite that waits for a yes
 * (never a plain "Retry 1 failed" that writes over the other change).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), removeItems: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn( async () => ( { items: [], total: 0, totalPages: 1 } ) ),
	listProducts: vi.fn( async ( query: Record< string, unknown > ) => ( {
		items: String( query.include )
			.split( ',' )
			.map( ( id ) => simple( Number( id ), { stock_quantity: 30, manage_stock: true } ) ),
		total: 0,
		totalPages: 1,
	} ) ),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const { conflictDataOf, describeConflictValues, editorConflictMessage, humanizeError } = await import( '../../resources/edit/errors' );

const fields = coreFields().filter( ( field ) => [ 'name', 'stock_quantity', 'manage_stock' ].includes( field.id ) );

function hostFor( items: ProductListItem[] ): EditorHost {
	const session: EditorSession = items.length > 1 ? { mode: 'bulk', origin: null } : { mode: 'quick', id: items[ 0 ]?.id ?? 0, origin: null };

	return { session, fields, items, offPageCount: 0, wholeList: false, close: vi.fn(), advance: vi.fn(), removeItem: vi.fn(), setGuard: vi.fn() };
}

const CONFLICT = {
	id: 1,
	code: 'wc_products_list_conflict',
	message: humanizeError( 'wc_products_list_conflict', '' ),
	data: { status: 409, id: 1, fields: [ 'stock_quantity' ], current: { stock_quantity: '30' }, expected: { stock_quantity: '12' } },
};

afterEach( () => {
	vi.clearAllMocks();
} );

describe( 'conflict wording', () => {
	it( 'names each field with the value stored now and the value loaded', () => {
		const conflict = conflictDataOf( CONFLICT.data )!;

		expect( describeConflictValues( conflict, ( path ) => ( path === 'stock_quantity' ? 'Stock' : path ) ) ).toBe( 'Stock 30 (was 12 when loaded)' );
		expect( conflictDataOf( { status: 409 } ) ).toBeNull();
		expect( editorConflictMessage( CONFLICT.data, ( path ) => path, false ) ).toMatch( /^Someone else changed it since it was loaded: stock_quantity 30 \(was 12 when loaded\)\. Nothing was saved for it\. The form still shows your values/ );
		// The list's wording no longer claims the form shows the stored values.
		expect( humanizeError( 'wc_products_list_conflict', '' ) ).toMatch( /The list now shows the stored values/ );
	} );
} );

describe( 'InlineEditor after a conflict', () => {
	it( 'shows the other value and only overwrites after an explicit yes', async () => {
		const row = simple( 1, { stock_quantity: 12, manage_stock: true } );

		saveEdits.mockResolvedValueOnce( { updated: [], errors: [ CONFLICT ], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );
		const { container } = render( <InlineEditor host={ hostFor( [ row ] ) } /> );

		await screen.findByRole( 'heading', { name: /Quick edit/ } );
		const stock = await waitFor( () => {
			const input = container.querySelector< HTMLInputElement >( 'input[type="number"]' );

			expect( input ).not.toBeNull();

			return input!;
		} );

		fireEvent.change( stock, { target: { value: '13' } } );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );

		// The problem list shows what the other writer stored, and the form still holds the user's value.
		expect( ( await screen.findAllByText( /30 \(was 12 when loaded\)/ ) ).length ).toBeGreaterThan( 0 );
		expect( screen.getAllByText( /The form still shows your values/ ).length ).toBeGreaterThan( 0 );

		// No plain retry: the button says it overwrites, and it waits for the confirmation.
		expect( screen.queryByRole( 'button', { name: 'Retry 1 failed' } ) ).not.toBeInTheDocument();
		const overwrite = screen.getByRole( 'button', { name: 'Overwrite with my values' } );

		expect( overwrite ).toHaveAttribute( 'aria-disabled', 'true' );
		fireEvent.submit( container.querySelector( 'form.wc-pl-edit' )! );
		expect( saveEdits ).toHaveBeenCalledTimes( 1 );

		saveEdits.mockResolvedValueOnce( { updated: [ simple( 1, { stock_quantity: 13 } ) ], errors: [], batchId: 'b2', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );
		fireEvent.click( screen.getByLabelText( 'Write my values over the other change' ) );
		await waitFor( () => expect( screen.getByRole( 'button', { name: 'Overwrite with my values' } ) ).not.toHaveAttribute( 'aria-disabled', 'true' ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Overwrite with my values' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 2 ) );
	} );

	it( 'shows the conflicting prices in the shop format, as the rest of the editor does', async () => {
		const row = simple( 1, { stock_quantity: 12, manage_stock: true } );
		const priced = { ...CONFLICT, data: { status: 409, id: 1, fields: [ 'regular_price' ], current: { regular_price: '21' }, expected: { regular_price: '25' } } };

		saveEdits.mockResolvedValueOnce( { updated: [], errors: [ priced ], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );
		const { container } = render( <InlineEditor host={ hostFor( [ row ] ) } /> );

		await screen.findByRole( 'heading', { name: /Quick edit/ } );
		const stock = await waitFor( () => {
			const input = container.querySelector< HTMLInputElement >( 'input[type="number"]' );

			expect( input ).not.toBeNull();

			return input!;
		} );

		fireEvent.change( stock, { target: { value: '13' } } );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );

		expect( ( await screen.findAllByText( /21,00\s€ \(was 25,00\s€ when loaded\)/ ) ).length ).toBeGreaterThan( 0 );
	} );
} );
