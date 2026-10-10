/**
 * Variation quick edit opens on the list's row and focuses the regular
 * price at once; the editor's own load lands a moment later. Someone else
 * saved the price meanwhile (list 14, stored 16):
 * - typed before the load landed: the box keeps the user's 15, the editor
 *   says the price is now 16, and the save expects 14 (what the box showed),
 *   so the server refuses it (409) instead of writing over 16;
 * - focused but untouched when the load landed: the box shows 16 at once,
 *   the editor says so, and an edit made then expects 16.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, variation } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();
let landLoad: ( rows: ProductListItem[] ) => void = () => {};

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), removeItems: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( { logSkipped: vi.fn( async () => undefined ) } ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );
vi.mock( '../../resources/edit/hydrate', async ( importOriginal ) => ( {
	...( await importOriginal< Record< string, unknown > >() ),
	// The editor's load answers when the test says so.
	hydrateSelection: vi.fn(
		() =>
			new Promise( ( resolve ) => {
				landLoad = ( rows ) => resolve( { items: rows, missing: [], trashed: [], parentStamps: new Map() } );
			} )
	),
} ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const { PriceEdit } = await import( '../../resources/fields/components/price-edit' );
const { writeItem } = await import( '../../resources/edit/expect' );

const fields = coreFields()
	.filter( ( entry ) => [ 'regular_price', 'status' ].includes( entry.id ) )
	.map( ( entry ) => ( entry.id === 'regular_price' ? { ...entry, productTypes: 'all' as const, Edit: PriceEdit as never } : entry ) );

function hostFor( item: ProductListItem ): EditorHost {
	const session: EditorSession = { mode: 'quick', id: item.id, origin: null };

	return { session, fields, items: [ item ], offPageCount: 0, wholeList: false, close: vi.fn(), advance: vi.fn(), removeItem: vi.fn(), setGuard: vi.fn() };
}

const ok = { updated: [], errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 };

async function priceInput( container: HTMLElement ): Promise< HTMLInputElement > {
	return waitFor( () => {
		const input = container.querySelector< HTMLInputElement >( 'input[id^="wc-pl-price-regular_price-"]' );

		expect( input ).not.toBeNull();

		return input!;
	} );
}

/** The `_wcpl_expect` the save would send for the row, as save-runner builds it. */
function sentExpect( payload: Record< string, unknown > ): unknown {
	const [ items, , , options ] = saveEdits.mock.calls[ 0 ] as [ ProductListItem[], unknown, unknown, { expectBase?: ( item: ProductListItem ) => ProductListItem } ];
	const item = items[ 0 ]!;

	return writeItem( options.expectBase ? options.expectBase( item ) : item, payload )._wcpl_expect;
}

afterEach( () => {
	vi.clearAllMocks();
} );

describe( 'InlineEditor: the expected value is the one the form showed', () => {
	it( 'expects the price the box showed when typing started, though a newer one loaded after', async () => {
		const listed = variation( 42, 40, { regular_price: '14' } );
		const { container } = render( <InlineEditor host={ hostFor( listed ) } /> );
		const input = await priceInput( container );

		expect( input.value ).toBe( '14,00' );
		fireEvent.focus( input );
		fireEvent.change( input, { target: { value: '15' } } );

		await act( async () => landLoad( [ variation( 42, 40, { regular_price: '16' } ) ] ) );

		// The user's text stays, and the editor says what is stored now.
		expect( input.value ).toBe( '15' );
		expect( ( await screen.findAllByText( /changed by someone else since you started editing it, now 16,00/ ) ).length ).toBeGreaterThan( 0 );

		saveEdits.mockResolvedValueOnce( ok );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );

		expect( sentExpect( { regular_price: '15' } ) ).toEqual( { regular_price: '14' } );
	} );

	it( 'shows a newer price in the focused, untouched box and expects that one', async () => {
		const listed = variation( 43, 40, { regular_price: '14' } );
		const { container } = render( <InlineEditor host={ hostFor( listed ) } /> );
		const input = await priceInput( container );

		fireEvent.focus( input );
		await act( async () => landLoad( [ variation( 43, 40, { regular_price: '16' } ) ] ) );

		expect( input.value ).toBe( '16,00' );
		expect( ( await screen.findAllByText( /changed by someone else since the list loaded, now 16,00/ ) ).length ).toBeGreaterThan( 0 );

		fireEvent.change( input, { target: { value: '17' } } );
		saveEdits.mockResolvedValueOnce( ok );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );

		expect( sentExpect( { regular_price: '17' } ) ).toEqual( { regular_price: '16' } );
	} );

	it( 'keeps a field the list did not carry read-only until its value loaded', async () => {
		const withSku = coreFields().filter( ( entry ) => entry.id === 'weight' || entry.id === 'regular_price' );

		expect( withSku.length ).toBeGreaterThan( 0 );
		const { toFormFields } = await import( '../../resources/edit/form-fields' );
		const formFields = toFormFields( withSku, { bulk: false, items: [ variation( 44, 40 ) ], base: {}, mixed: {}, settings, pending: new Set( [ 'regular_price' ] ) } );

		expect( formFields.find( ( entry ) => entry.id === 'regular_price' )?.readOnly ).toBe( true );
	} );
} );
