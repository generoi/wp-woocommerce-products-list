import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResponse } from '../../resources/api/client';
import { closeBatch, logSkipped, runAction } from '../../resources/api/client';
import { trashRows } from '../../resources/actions/trash';
import { notify } from '../../resources/actions/notices';
import { removeItems } from '../../resources/store/products';
import { isRowPending } from '../../resources/store/save-activity';
import { setSettings } from '../../resources/settings';
import { editSettings, simple } from './edit-fixtures';

vi.mock( '../../resources/api/client', () => ( {
	runAction: vi.fn(),
	newBatchId: () => 'trash-1',
	logSkipped: vi.fn( async () => undefined ),
	isRequestFailure: ( data: unknown ) => typeof data === 'object' && data !== null && ( data as { wcpl_request_failed?: unknown } ).wcpl_request_failed === true,
	closeBatch: vi.fn( async () => undefined ),
	// 20 ids per request.
	actionRequestCount: ( _action: string, count: number ) => Math.ceil( count / 20 ),
} ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );
vi.mock( '../../resources/store/products', () => ( { removeItems: vi.fn(), invalidateProducts: vi.fn() } ) );

describe( 'trashRows', () => {
	afterEach( () => vi.clearAllMocks() );

	it( 'runs as a save (rows locked, leaving guarded, planned and closed) and keeps the products already trashed when a later request fails', async () => {
		const rows = Array.from( { length: 45 }, ( _, index ) => simple( index + 1 ) );
		let lockedDuring = false;
		let guardedDuring = false;
		const listener = vi.spyOn( window, 'addEventListener' );

		vi.mocked( runAction ).mockImplementationOnce( async ( _action, ids ) => {
			lockedDuring = isRowPending( 1 ) && isRowPending( 45 );
			guardedDuring = listener.mock.calls.some( ( [ type ] ) => type === 'beforeunload' );

			// The second of three requests failed: its 20 ids come back failed, the others are in the Trash.
			return {
				batch_id: 'trash-1',
				items: [],
				results: ids.map( ( id, index ) => ( index >= 20 && index < 40 ? { id, ok: false, code: 'fetch_error', message: 'You are probably offline.', data: { wcpl_request_failed: true, status: 0 } } : { id, ok: true } ) ),
			} as ActionResponse;
		} );

		await trashRows( rows );

		expect( removeItems ).toHaveBeenCalledWith( rows.map( ( row ) => row.id ) );
		expect( lockedDuring ).toBe( true );
		expect( guardedDuring ).toBe( true );
		expect( isRowPending( 1 ) ).toBe( false );
		expect( vi.mocked( runAction ).mock.calls[ 0 ]?.[ 3 ] ).toMatchObject( { batchId: 'trash-1', planned: 45 } );
		expect( closeBatch ).toHaveBeenCalledWith( 'trash-1' );
		expect( notify.success ).toHaveBeenCalledWith( '25 products moved to the Trash.', expect.objectContaining( { actions: [ expect.objectContaining( { label: 'Undo' } ) ] } ) );
		// The 20 ids of the failed request have no row on the server: recorded as failed, and offered for another try.
		expect( notify.error ).toHaveBeenCalledWith( '20 products were not moved to the Trash: Simple 21, Simple 22, Simple 23 and 17 more: You are probably offline.', expect.objectContaining( { actions: [ expect.objectContaining( { label: 'Select the 20 failed' } ) ] } ) );
		expect( logSkipped ).toHaveBeenCalledWith(
			'trash-1',
			'action',
			rows.slice( 20, 40 ).map( ( row ) => ( { id: row.id, reason: 'failed', message: 'You are probably offline.' } ) ),
			{ action: 'trash' }
		);
		listener.mockRestore();
	} );

	it( 'one request: no plan, no close; the job ends when the request fails', async () => {
		vi.mocked( runAction ).mockRejectedValueOnce( new Error( 'offline' ) );

		await trashRows( [ simple( 1 ) ] );

		expect( vi.mocked( runAction ).mock.calls[ 0 ]?.[ 3 ] ).not.toHaveProperty( 'planned' );
		expect( closeBatch ).not.toHaveBeenCalled();
		expect( isRowPending( 1 ) ).toBe( false );
		expect( notify.error ).toHaveBeenCalledWith( '1 product was not moved to the Trash: Simple 1: offline', expect.objectContaining( { actions: [ expect.objectContaining( { label: 'Select the 1 failed' } ) ] } ) );
		// The one request got no answer: the attempt is still in History, as a failed row.
		expect( logSkipped ).toHaveBeenCalledWith( 'trash-1', 'action', [ { id: 1, reason: 'failed', message: 'offline' } ], { action: 'trash' } );
	} );

	it( 'a refused Undo names the products still in the Trash and links to the Trash tab, not "Select"', async () => {
		setSettings( editSettings( { links: { ...editSettings().links, page: '/wp-admin/edit.php?post_type=product&page=wc-products-list' } } ) );
		const locked = 'FE6Auditor is editing this product in the product editor. Nothing was saved for this item; try again when they are done.';

		vi.mocked( runAction )
			.mockResolvedValueOnce( { batch_id: 'trash-1', items: [], results: [ { id: 1, ok: true }, { id: 2, ok: false, code: 'wc_products_list_editing', message: locked } ] } as ActionResponse )
			.mockResolvedValueOnce( { batch_id: 'trash-1', items: [], results: [ { id: 1, ok: false, code: 'wc_products_list_editing', message: locked } ] } as ActionResponse );

		await trashRows( [ simple( 1 ), simple( 2 ) ] );

		// The refused trash names its row and says it was not trashed.
		expect( notify.error ).toHaveBeenCalledWith( expect.stringMatching( /^1 product was not moved to the Trash: Simple 2: FE6Auditor is editing/ ), expect.anything() );

		const undo = ( vi.mocked( notify.success ).mock.calls[ 0 ]?.[ 1 ] as { actions: Array< { onClick: () => void } > } ).actions[ 0 ]!;
		undo.onClick();
		await vi.waitFor( () => expect( notify.error ).toHaveBeenCalledTimes( 2 ) );

		const [ message, options ] = vi.mocked( notify.error ).mock.calls[ 1 ] as [ string, { actions: Array< { label: string; url?: string } > } ];
		expect( message ).toMatch( /^1 product is still in the Trash: Simple 1: FE6Auditor is editing/ );
		expect( options.actions[ 0 ] ).toMatchObject( { label: 'Open the Trash' } );
		expect( options.actions[ 0 ]?.url ).toContain( 'tab=trash' );
		expect( options.actions.map( ( action ) => action.label ) ).not.toContain( 'Select the 1 failed' );
		setSettings( undefined );
	} );
} );
