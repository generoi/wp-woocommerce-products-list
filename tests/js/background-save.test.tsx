/**
 * Background bulk updates: the list's job (row locks, progress bar, leave
 * guard) starts before the pre-save re-checks and ends on every path, and
 * the rows that fail are recorded in the batch's History as `failed`.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple } from './edit-fixtures';

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
	newBatchId: vi.fn( () => 'batch-bg' ),
	runAction: vi.fn(),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const client = await import( '../../resources/api/client' );
const { isRowPending } = await import( '../../resources/store/save-activity' );
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;
const logSkipped = client.logSkipped as unknown as ReturnType< typeof vi.fn >;

const plain = coreFields().filter( ( field ) => [ 'name', 'status', 'featured' ].includes( field.id ) );

function hostFor( items: ProductListItem[] ): EditorHost {
	return {
		session: { mode: 'bulk', origin: null },
		fields: plain,
		items,
		offPageCount: 0,
		wholeList: false,
		close: vi.fn(),
		advance: vi.fn(),
		removeItem: vi.fn(),
		setGuard: vi.fn(),
	} as EditorHost;
}

afterEach( () => {
	vi.clearAllMocks();
	listProducts.mockReset();
} );

describe( 'background bulk update', () => {
	it( 'locks the rows while the pre-save checks run, passes the job to the save and releases it at the end', async () => {
		const rows = [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ) ];
		let releaseCheck: () => void = () => {};
		let lockedDuringCheck = false;

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );

			if ( saveEdits.mock.calls.length === 0 && isRowPending( 1 ) ) {
				lockedDuringCheck = true;
				await new Promise< void >( ( resolve ) => ( releaseCheck = resolve ) );
			}

			return { items: ids.map( ( id ) => rows.find( ( row ) => row.id === id ) ?? simple( id ) ), total: ids.length, totalPages: 1 };
		} );
		saveEdits.mockImplementation( async ( items: ProductListItem[], _edits: unknown, _fields: unknown, options: { saveJob?: number } ) => {
			expect( options.saveJob ).toEqual( expect.any( Number ) );
			expect( isRowPending( 1 ) ).toBe( true );

			return { updated: items, errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 };
		} );

		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update 2 products' } ) );

		await waitFor( () => expect( lockedDuringCheck ).toBe( true ) );
		expect( isRowPending( 2 ) ).toBe( true );
		releaseCheck();

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		await waitFor( () => expect( isRowPending( 1 ) ).toBe( false ) );
		expect( isRowPending( 2 ) ).toBe( false );
	} );

	it( 'releases the rows when the pre-save checks fail', async () => {
		const rows = [ simple( 3 ), simple( 4 ) ];

		listProducts.mockRejectedValue( new Error( 'Network down' ) );
		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update 2 products' } ) );

		await screen.findAllByText( /Network down/ );
		expect( saveEdits ).not.toHaveBeenCalled();
		expect( isRowPending( 3 ) ).toBe( false );
		expect( isRowPending( 4 ) ).toBe( false );
	} );

	it( 'records the rows that failed in the batch as `failed`, with their error; a row deleted meanwhile as `deleted`', async () => {
		const rows = [ simple( 5 ), simple( 6 ), simple( 7 ) ];

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );

			return { items: ids.map( ( id ) => rows.find( ( row ) => row.id === id ) ?? simple( id ) ), total: ids.length, totalPages: 1 };
		} );
		saveEdits.mockResolvedValueOnce( {
			updated: [ simple( 5, { featured: true } ) ],
			errors: [
				{ id: 6, code: 'fetch_error', message: 'You are probably offline.' },
				{ id: 7, code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' },
			],
			batchId: 'b-failed',
			unchanged: 0,
			stockSkipped: 0,
			saleSkipped: 0,
			replacedSales: 0,
		} );

		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		fireEvent.click( await screen.findByRole( 'button', { name: 'Update 3 products' } ) );

		await waitFor( () => expect( logSkipped ).toHaveBeenCalled() );

		const [ batchId, source, items ] = logSkipped.mock.calls[ 0 ] as [ string, string, Array< { id: number; reason: string; message?: string } > ];

		expect( batchId ).toBe( 'b-failed' );
		expect( source ).toBe( 'bulk' );
		expect( items ).toEqual(
			expect.arrayContaining( [
				expect.objectContaining( { id: 6, reason: 'failed', message: 'You are probably offline.' } ),
				expect.objectContaining( { id: 7, reason: 'deleted' } ),
			] )
		);
	} );
} );
