/**
 * Variable products deleted while a bulk save runs. WordPress deletes such a product's terms and meta first, then
 * WooCommerce deletes its variations one by one, and the product itself goes last: for a few seconds a read finds it
 * still there, without its categories, tags, brands or featured flag. The editor must not take that half-deleted
 * read for the product as it is now: it names the product as deleted once it is gone, and says nothing about its
 * fields being "changed by someone else".
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
const deletedListeners = vi.hoisted( () => new Set< ( ids: number[] ) => void >() );

vi.mock( '../../resources/store/products', () => ( {
	subscribeDeleted: ( listener: ( ids: number[] ) => void ) => {
		deletedListeners.add( listener );

		return () => deletedListeners.delete( listener );
	},
	patchItems: vi.fn(), removeItems: vi.fn(), invalidateProducts: vi.fn(), deletionsNamedByEditor: vi.fn() } ) );
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
const store = await import( '../../resources/store/products' );
const removeItems = store.removeItems as unknown as ReturnType< typeof vi.fn >;
const client = await import( '../../resources/api/client' );
const getVariations = client.getVariations as unknown as ReturnType< typeof vi.fn >;
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;

const fields = coreFields().filter( ( field ) => [ 'name', 'status', 'regular_price', 'sale_price', 'featured' ].includes( field.id ) );

function hostFor( items: ProductListItem[] ): EditorHost {
	return { session: { mode: 'bulk', origin: null }, fields, items, offPageCount: 0, wholeList: false, close: vi.fn(), advance: vi.fn(), removeItem: vi.fn(), setGuard: vi.fn() };
}

afterEach( () => {
	vi.clearAllMocks();
	listProducts.mockReset();
	getVariations.mockReset();
} );

describe( 'a variable product deleted while a bulk save writes its variations', () => {
	it( 'is named as deleted once it is gone, and its half-deleted read is not reported as changed by someone else', async () => {
		const parents = [ variable( 21, { name: 'Koel A', featured: true } ), variable( 22, { name: 'Koel B', featured: true } ) ];
		// 'deleting': product 22's terms and meta are gone, the post is not yet (one read finds it so); 'gone': the post is deleted.
		let state: 'there' | 'deleting' | 'gone' = 'there';

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );
			const items = ids.flatMap( ( id ) => {
				const row = parents.find( ( parent ) => parent.id === id )!;

				if ( id !== 22 || state === 'there' ) {
					return [ row ];
				}

				if ( state === 'deleting' ) {
					state = 'gone';

					return [ { ...row, type: 'simple', featured: false, categories: [] } ];
				}

				return [];
			} );

			return { items, total: items.length, totalPages: 1 };
		} );
		getVariations.mockImplementation( async ( parentId: number ) => {
			const items = parentId === 22 && state !== 'there' ? [] : [ variation( parentId * 10 + 1, parentId, { regular_price: '20' } ), variation( parentId * 10 + 2, parentId, { regular_price: '30' } ) ];

			return { items, total: items.length, totalPages: 1 };
		} );
		saveEdits.mockImplementation( async () => {
			// The deletion starts while the variations are written: 22's are refused as deleted.
			state = 'deleting';

			return {
				updated: [ variation( 211, 21, { regular_price: '21' } ), variation( 212, 21, { regular_price: '31' } ) ],
				errors: [ 221, 222 ].map( ( id ) => ( { id, code: 'woocommerce_rest_product_variation_invalid_id', message: 'This variation no longer exists (it was deleted).' } ) ),
				batchId: 'b-del',
				unchanged: 0,
				stockSkipped: 0,
				saleSkipped: 0,
				replacedSales: 0,
			};
		} );

		render( <InlineEditor host={ hostFor( parents ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.click( await screen.findByLabelText( /Also apply to the variations/ ) );
		await screen.findByText( /Prices will change on 4 variations of 2 variable products/ );
		fireEvent.change( screen.getByLabelText( 'regular_price: operation' ), { target: { value: 'increase' } } );
		fireEvent.change( screen.getByLabelText( 'regular_price: value' ), { target: { value: '1' } } );
		fireEvent.click( await screen.findByRole( 'button', { name: /^Update/ } ) );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( ( await screen.findAllByText( /1 of the selected items no longer exists and was left out: Koel B/, undefined, { timeout: 8000 } ) ).length ).toBeGreaterThan( 0 );
		expect( screen.getByRole( 'heading', { name: 'Bulk edit 1 item' } ) ).toBeInTheDocument();
		expect( screen.queryByText( /changed by someone else/ ) ).not.toBeInTheDocument();
		// The deleted parent leaves the list while the editor stays open (its row showed stale prices until Close).
		expect( removeItems ).toHaveBeenCalledWith( [ 22 ] );
	} );

	it( 'stops counting a parent the list found deleted and removed after the save', async () => {
		const rows = [ simple( 31, { name: 'Koel C' } ), simple( 32, { name: 'Koel D' } ), simple( 33, { name: 'Koel E' } ) ];

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );
			const items = rows.filter( ( row ) => ids.includes( row.id ) );

			return { items, total: items.length, totalPages: 1 };
		} );
		saveEdits.mockImplementation( async () => ( { updated: rows.map( ( row ) => ( { ...row, regular_price: '21' } ) ), errors: [], batchId: 'b-ok', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } ) );

		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		fireEvent.change( screen.getByLabelText( 'regular_price: value' ), { target: { value: '21' } } );
		fireEvent.click( await screen.findByRole( 'button', { name: /^Update/ } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );

		// The list's refresh of the saved rows found 33 deleted, removed it and named it in its own notice.
		act( () => deletedListeners.forEach( ( listener ) => listener( [ 33 ] ) ) );

		expect( await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } ) ).toBeInTheDocument();
		// The list named it; the editor does not name it again.
		expect( document.querySelector( 'form.wc-pl-edit' )?.textContent ).not.toMatch( /no longer exist/ );
	} );
} );

describe( 'a product deleted before the bulk save writes it', () => {
	it( 'leaves the list at once, while the editor stays open with the other rows', async () => {
		const rows = [ simple( 41, { name: 'Koel F' } ), simple( 42, { name: 'Koel G' } ) ];
		let gone = false;

		listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
			const ids = String( query.include ).split( ',' ).map( Number );
			const items = rows.filter( ( row ) => ids.includes( row.id ) && ! ( gone && row.id === 42 ) );

			return { items, total: items.length, totalPages: 1 };
		} );
		saveEdits.mockImplementation( async () => ( { updated: [ { ...rows[ 0 ], regular_price: '21' } ], errors: [], batchId: 'b-pre', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } ) );

		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		fireEvent.change( screen.getByLabelText( 'regular_price: value' ), { target: { value: '21' } } );
		gone = true;
		fireEvent.click( await screen.findByRole( 'button', { name: /^Update/ } ) );

		expect( ( await screen.findAllByText( /1 of the selected items no longer exists and was left out: Koel G/ ) ).length ).toBeGreaterThan( 0 );
		expect( removeItems ).toHaveBeenCalledWith( [ 42 ] );
	} );
} );

describe( 'settleDeletions', () => {
	it( 'checks until the products are gone, at most `tries` times, and reports the ones still there', async () => {
		const { settleDeletions } = await import( '../../resources/edit/hydrate' );
		let reads = 0;
		const listProductsDep = vi.fn( async ( query: Record< string, unknown > ) => {
			reads += 1;
			// 31 is deleted after the second check; 32 stays (only some of its variations were deleted); 33 goes to the Trash.
			const ids = String( query.include ).split( ',' ).map( Number );
			const items = ids.filter( ( id ) => ! ( id === 31 && reads > 2 ) ).map( ( id ) => ( { id, status: id === 33 ? 'trash' : 'publish' } ) );

			return { items, total: items.length, totalPages: 1 } as never;
		} );
		const sleep = vi.fn( async () => undefined );

		const settled = await settleDeletions( [ variable( 31 ), variable( 32 ), variable( 33 ) ], { tries: 5, interval: 10, deps: { listProducts: listProductsDep }, sleep } );

		expect( settled ).toEqual( { missing: [ 31 ], trashed: [ 33 ], present: [ 32 ] } );
		expect( listProductsDep ).toHaveBeenCalledTimes( 5 );
		expect( sleep ).toHaveBeenCalledTimes( 4 );
	} );
} );
