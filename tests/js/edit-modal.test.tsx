/**
 * The modal's own behaviour: it works on the rows it opened with (a
 * partial failure must not turn a bulk edit into a quick edit of the
 * failed row), Escape asks before discarding, Enter saves.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, simple } from './edit-fixtures';

const settings = editSettings();

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();
const removeItems = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), removeItems: ( ids: number[] ) => removeItems( ids ) } ) );
vi.mock( '../../resources/api/client', () => ( {
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

const { ProductEditModal } = await import( '../../resources/edit/product-edit-modal' );

const fields = coreFields().filter( ( field ) => [ 'name', 'status', 'featured', 'stock_quantity', 'manage_stock' ].includes( field.id ) );

function renderModal( items: ProductListItem[], props: Partial< Parameters< typeof ProductEditModal >[ 0 ] > = {} ) {
	const closeModal = vi.fn();
	const onActionPerformed = vi.fn();
	const utils = render( <ProductEditModal items={ items } fields={ fields } closeModal={ closeModal } onActionPerformed={ onActionPerformed } { ...props } /> );

	return { ...utils, closeModal, onActionPerformed };
}

beforeEach( () => {
	vi.useRealTimers();
} );

afterEach( () => {
	vi.clearAllMocks();
} );

describe( 'ProductEditModal', () => {
	it( 'stays a bulk edit of the rows it opened with after a partial failure, lists the failure and offers a retry', async () => {
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

		const view = renderModal( three );

		await screen.findByText( 'Editing 3 products' );

		const featured = screen.getByLabelText( 'featured' ) as HTMLInputElement;

		fireEvent.click( featured );
		await screen.findByRole( 'button', { name: 'Save 3 products' } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Save 3 products' } ) );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( saveEdits.mock.calls[ 0 ]?.[ 0 ] ).toHaveLength( 3 );

		// The list trims the saved rows from the selection; the modal does not follow.
		view.rerender( <ProductEditModal items={ [ three[ 2 ]! ] } fields={ fields } closeModal={ view.closeModal } onActionPerformed={ view.onActionPerformed } /> );

		expect( screen.getByText( 'Editing 3 products' ) ).toBeInTheDocument();
		expect( screen.getByText( '1 problem' ) ).toBeInTheDocument();
		// The rows were reloaded with their current values (the mock names them "Simple N").
		expect( screen.getAllByText( /Simple 3/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getAllByText( /not allowed/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getByRole( 'button', { name: 'Retry 1 failed' } ) ).toBeInTheDocument();
		expect( view.closeModal ).not.toHaveBeenCalled();
		expect( notify.error ).toHaveBeenCalledWith( '2 updated, 1 failed.' );

		// The retry sends only the failed row.
		saveEdits.mockResolvedValueOnce( { updated: [ simple( 3, { featured: true } ) ], errors: [], batchId: 'b2', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Retry 1 failed' } ) );
		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 2 ) );
		expect( ( saveEdits.mock.calls[ 1 ]?.[ 0 ] as ProductListItem[] ).map( ( row ) => row.id ) ).toEqual( [ 3 ] );
		await waitFor( () => expect( view.closeModal ).toHaveBeenCalled() );
	} );

	it( 'a row that no longer exists leaves the list and is not offered for retry', async () => {
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

		const view = renderModal( three );

		await screen.findByText( 'Editing 3 products' );
		fireEvent.click( screen.getByLabelText( 'featured' ) );
		await screen.findByRole( 'button', { name: 'Save 3 products' } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Save 3 products' } ) );

		await screen.findAllByText( /removed from the list/ );
		expect( removeItems ).toHaveBeenCalledWith( [ 3 ] );
		expect( screen.getByRole( 'button', { name: 'Close' } ) ).toBeInTheDocument();

		fireEvent.click( screen.getByRole( 'button', { name: 'Close' } ) );
		expect( view.closeModal ).toHaveBeenCalled();
		expect( view.onActionPerformed ).toHaveBeenCalled();
	} );

	it( 'Escape on a dirty form asks before discarding; a clean form closes', async () => {
		const view = renderModal( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );

		const form = view.container.querySelector( 'form.wc-pl-edit' )!;
		const clean = fireEvent.keyDown( form, { key: 'Escape' } );

		expect( clean ).toBe( true ); // not prevented: the dialog may close
		expect( screen.queryByText( /Discard 1 unsaved change/ ) ).not.toBeInTheDocument();

		fireEvent.click( screen.getByLabelText( 'featured' ) );

		const dirty = fireEvent.keyDown( form, { key: 'Escape' } );

		expect( dirty ).toBe( false ); // prevented: the confirm is shown instead
		expect( await screen.findByText( /Discard 1 unsaved change/ ) ).toBeInTheDocument();
		expect( view.closeModal ).not.toHaveBeenCalled();
	} );

	it( 'Enter in a single-line input saves', async () => {
		saveEdits.mockResolvedValueOnce( { updated: [ simple( 1, { name: 'Two' } ) ], errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		const view = renderModal( [ simple( 1, { name: 'One' } ) ] );

		await screen.findByText( 'One' );

		const name = screen.getByLabelText( /^name/ ) as HTMLInputElement;

		fireEvent.change( name, { target: { value: 'Two' } } );
		fireEvent.keyDown( name, { key: 'Enter' } );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalledTimes( 1 ) );
		expect( saveEdits.mock.calls[ 0 ]?.[ 1 ] ).toEqual( { name: 'Two' } );
		await waitFor( () => expect( view.closeModal ).toHaveBeenCalled() );
		expect( notify.success ).toHaveBeenCalledWith( '1 item updated.', expect.anything() );
	} );

	it( 'warns about rows that do not manage stock and offers to turn it on', async () => {
		const rows = [ simple( 1, { name: 'Managed', manage_stock: true, stock_quantity: 1 } ), simple( 2, { name: 'Loose', manage_stock: false, stock_quantity: null } ) ];
		const { listProducts } = await import( '../../resources/api/client' );

		( listProducts as unknown as ReturnType< typeof vi.fn > ).mockImplementationOnce( async () => ( { items: rows, total: 0, totalPages: 1 } ) );

		renderModal( rows );

		await screen.findByText( 'Editing 2 products' );

		const quantity = screen.getByLabelText( 'stock_quantity: value' );

		fireEvent.change( screen.getByLabelText( 'stock_quantity: operation' ), { target: { value: 'set' } } );
		fireEvent.change( quantity, { target: { value: '10' } } );

		expect( ( await screen.findAllByText( /1 of the 2 rows does not manage stock/ ) ).length ).toBeGreaterThan( 0 );
		expect( screen.getAllByText( /Loose/ ).length ).toBeGreaterThan( 0 );
		expect( screen.getByRole( 'button', { name: 'Save 1 product' } ) ).toBeInTheDocument();

		fireEvent.click( screen.getByLabelText( /Turn on "Manage stock" for that row/ ) );

		await screen.findByRole( 'button', { name: 'Save 2 products' } );
	} );
} );
