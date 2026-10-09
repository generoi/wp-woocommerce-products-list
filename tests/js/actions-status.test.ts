import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchProducts, batchVariationsAcross, closeBatch, logSkipped, REQUEST_FAILED_KEY } from '../../resources/api/client';
import { hydrateSelection } from '../../resources/edit/hydrate';
import { isRowPending } from '../../resources/store/save-activity';
import type { ProductListItem } from '../../resources/types';
import type * as ClientModule from '../../resources/api/client';
import { optimisticBatch } from '../../resources/actions/status';
import { dropFromSelection } from '../../resources/actions/context';
import { notify } from '../../resources/actions/notices';
import { patchItems, removeItems } from '../../resources/store/products';
import { setSettings } from '../../resources/settings';
import { coreFields, editSettings, simple, variation } from './edit-fixtures';

/** What the server echoes for a written row: the request item without the app's request-only keys. */
function echo( row: Record< string, unknown > ): Record< string, unknown > {
	const { parent_id: _parent, _wcpl_expect: _expect, ...rest } = row;

	return rest;
}

const defaultProducts = async ( update: Array< Record< string, unknown > > ) => ( { update: update.map( echo ) } );
const defaultAcross = async ( update: Array< Record< string, unknown > > ) => ( { update: update.map( echo ) } );

vi.mock( '../../resources/api/client', async ( importOriginal ) => {
	const actual = await importOriginal< typeof ClientModule >();

	return {
		REQUEST_FAILED_KEY: actual.REQUEST_FAILED_KEY,
		isRequestFailure: actual.isRequestFailure,
		batchProducts: vi.fn(),
		batchVariationsAcross: vi.fn(),
		closeBatch: vi.fn( async () => undefined ),
		newBatchId: () => 'batch-x',
		logSkipped: vi.fn( async () => undefined ),
		toRow: ( row: unknown ) => row,
	};
} );
vi.mock( '../../resources/edit/hydrate', () => ( { hydrateSelection: vi.fn() } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), invalidateProducts: vi.fn(), removeItems: vi.fn() } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn( async () => undefined ) } ) );

describe( 'optimisticBatch', () => {
	beforeEach( () => {
		setSettings( editSettings() );
		vi.mocked( batchProducts ).mockImplementation( defaultProducts as never );
		vi.mocked( batchVariationsAcross ).mockImplementation( defaultAcross as never );
	} );
	afterEach( () => {
		setSettings( undefined );
		vi.mocked( batchProducts ).mockReset();
		vi.mocked( batchVariationsAcross ).mockReset();
		vi.mocked( notify.success ).mockClear();
		vi.mocked( notify.error ).mockClear();
		vi.mocked( patchItems ).mockClear();
		vi.mocked( closeBatch ).mockClear();
		vi.mocked( hydrateSelection ).mockReset();
	} );

	it( 'logs status changes as menu actions (source action), and resolves with the ids updated', async () => {
		const one = await optimisticBatch( [ simple( 1 ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '' } );
		expect( one ).toEqual( [ 1 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { batchId: 'batch-x', source: 'action' } );
		// One request: nothing to plan, nothing to close.
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).not.toHaveProperty( 'planned' );
		expect( closeBatch ).not.toHaveBeenCalled();

		const many = await optimisticBatch( [ simple( 1 ), simple( 2 ), variation( 31, 3 ) ], { patch: ( item ) => ( { id: item.id, status: 'draft' } ), refetch: false, success: () => '' } );
		expect( many ).toEqual( [ 31, 1, 2 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 1 ]?.[ 1 ] ).toMatchObject( { batchId: 'batch-x', source: 'action', planned: 3 } );
		expect( vi.mocked( batchVariationsAcross ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { batchId: 'batch-x', source: 'action', planned: 3 } );
		// Two requests: the batch is planned and closed when both are back.
		expect( closeBatch ).toHaveBeenCalledWith( 'batch-x' );
	} );

	it( 'sends the variations of every parent in one cross-parent request, with their parent ids, and patches the returned rows in one go', async () => {
		const rows = [ variation( 31, 3 ), variation( 41, 4 ), variation( 32, 3 ), simple( 1 ) ];
		const ok = await optimisticBatch( rows, { patch: ( item ) => ( { id: item.id, status: 'private' } ), refetch: false, success: () => '' } );

		expect( ok ).toEqual( [ 31, 41, 32, 1 ] );
		expect( vi.mocked( batchVariationsAcross ) ).toHaveBeenCalledTimes( 1 );
		expect( vi.mocked( batchVariationsAcross ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [
			{ id: 31, status: 'private', parent_id: 3, _wcpl_expect: { status: 'publish' } },
			{ id: 41, status: 'private', parent_id: 4, _wcpl_expect: { status: 'publish' } },
			{ id: 32, status: 'private', parent_id: 3, _wcpl_expect: { status: 'publish' } },
		] );
		// The optimistic patch, one patch for the variations' response, one for the products'.
		expect( vi.mocked( patchItems ) ).toHaveBeenCalledTimes( 3 );
		expect( vi.mocked( patchItems ).mock.calls[ 1 ]?.[ 0 ] ).toHaveLength( 3 );
	} );

	it( 'trims the returned rows to the list fields and writes only the eligible rows', async () => {
		const fields = coreFields();
		const items = [ simple( 1, { featured: true } ), simple( 2, { featured: false } ) ];
		const ok = await optimisticBatch( items, {
			patch: ( item ) => ( { id: item.id, featured: true } ),
			refetch: false,
			success: ( count ) => `${ count } featured`,
			fields,
			eligible: ( item ) => item.featured !== true,
		} );

		expect( ok ).toEqual( [ 2 ] );
		// The loaded value goes along: a row another tab or user changed meanwhile is refused, not overwritten.
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [ { id: 2, featured: true, _wcpl_expect: { featured: false } } ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { fields: expect.arrayContaining( [ 'id', 'featured', 'name' ] ) } );
		// The snackbar can undo the batch (disabling a colour's variations, featuring products).
		expect( vi.mocked( notify.success ) ).toHaveBeenCalledWith( '1 featured', expect.objectContaining( { id: 'wc-pl-action-batch-x', actions: [ expect.objectContaining( { label: 'Undo' } ) ] } ) );
		expect( vi.mocked( closeBatch ) ).not.toHaveBeenCalled();

		const { undoBatch } = await import( '../../resources/edit/undo' );
		const [ , noticeOptions ] = vi.mocked( notify.success ).mock.calls[ 0 ] as unknown as [ string, { actions: Array< { onClick: () => void } > } ];

		noticeOptions.actions[ 0 ]!.onClick();
		expect( undoBatch ).toHaveBeenCalledWith( 'batch-x' );

		// Nothing eligible: no request, no notice.
		expect( await optimisticBatch( [ simple( 3, { featured: true } ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '', eligible: ( item ) => item.featured !== true } ) ).toEqual( [] );
		expect( vi.mocked( batchProducts ) ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'records rows whose request failed as failed in the batch, and offers to select them and open the batch in History', async () => {
		setSettings( editSettings( { links: { ...editSettings().links, history: '/wp/wp-admin/admin.php?page=wc-products-list-history' } } ) );
		vi.mocked( logSkipped ).mockClear();
		// Enable on three variations; the one request gets no answer (TypeError "Failed to fetch"), and the re-read fails too.
		vi.mocked( batchVariationsAcross ).mockRejectedValueOnce( Object.assign( new Error( 'Could not get a valid response from the server.' ), { code: 'fetch_error' } ) );
		vi.mocked( hydrateSelection ).mockRejectedValue( new Error( 'offline' ) );

		const ok = await optimisticBatch( [ variation( 86980, 86979, { status: 'private' } ), variation( 86981, 86979, { status: 'private' } ), variation( 86982, 86979, { status: 'private' } ) ], {
			patch: ( item ) => ( { id: item.id, status: 'publish' } ),
			refetch: false,
			success: () => '',
		} );

		expect( ok ).toEqual( [] );
		expect( logSkipped ).toHaveBeenCalledWith(
			'batch-x',
			'action',
			[ 86980, 86981, 86982 ].map( ( id ) => ( { id, reason: 'failed', fields: [ 'status' ], message: expect.stringContaining( 'Could not get a valid response from the server.' ) } ) )
		);

		const [ message, options ] = vi.mocked( notify.error ).mock.calls[ 0 ] as unknown as [ string, { actions: Array< { label: string; url?: string } > } ];

		expect( message ).toMatch( /^3 items could not be updated/ );
		expect( options.actions.map( ( action ) => action.label ) ).toEqual( [ 'Select the 3 failed', 'View in History' ] );
		expect( options.actions[ 1 ]?.url ).toContain( 'batch=batch-x' );
	} );

	it( 'does not post the rows the server refused and logged itself (conflict, lock, Trash, deleted, editor open)', async () => {
		vi.mocked( logSkipped ).mockClear();
		vi.mocked( batchProducts ).mockImplementationOnce( ( async ( update: Array< Record< string, unknown > > ) => ( {
			update: update.map( ( row ) =>
				row.id === 1 ? { id: 1, error: { code: 'wc_products_list_locked', message: 'Locked.', data: { status: 409 } } } : { id: row.id as number, error: { code: 'woocommerce_rest_cannot_edit', message: 'No.', data: { status: 403 } } }
			),
		} ) ) as never );

		await optimisticBatch( [ simple( 1 ), simple( 2 ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '' } );

		expect( logSkipped ).toHaveBeenCalledWith( 'batch-x', 'action', [ { id: 2, reason: 'failed', fields: [ 'featured' ], message: 'You are not allowed to edit this item.' } ] );
	} );

	it( 'names the rows that failed with why (a product another user has open in the product editor)', async () => {
		const locked = 'FE6Auditor is editing this product in the product editor. Nothing was saved for this item; try again when they are done.';

		vi.mocked( batchProducts ).mockImplementationOnce( ( async ( update: Array< Record< string, unknown > > ) => ( {
			update: [ { id: 1, error: { code: 'wc_products_list_editing', message: locked, data: { status: 409 } } }, echo( update[ 1 ]! ) ],
		} ) ) as never );

		await optimisticBatch( [ simple( 1, { name: 'FE6AUDIT A Wally' } ), simple( 2 ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '' } );

		expect( vi.mocked( notify.error ).mock.calls[ 0 ]?.[ 0 ] ).toBe( `1 item could not be updated: FE6AUDIT A Wally: ${ locked }` );
	} );

	it( 'keeps the requests that went through when one among several fails offline: only its rows are settled, the rest keep Undo', async () => {
		const rows = Array.from( { length: 250 }, ( _, index ) => variation( 1001 + index, 7 ) );
		const pendingDuring: boolean[] = [];

		vi.mocked( batchVariationsAcross ).mockImplementation( ( async ( update: Array< Record< string, unknown > > ) => {
			pendingDuring.push( isRowPending( 1001 ), isRowPending( 7 ) );

			// The client's per-chunk result: the second of three requests failed with no answer.
			return {
				update: update.map( ( row, index ) =>
					index >= 100 && index < 200
						? { id: row.id as number, error: { code: 'fetch_error', message: 'You are probably offline.', data: { [ REQUEST_FAILED_KEY ]: true, status: 0 } } }
						: echo( row )
				),
			};
		} ) as never );
		// Still offline: the re-read fails too.
		vi.mocked( hydrateSelection ).mockRejectedValue( new Error( 'You are probably offline.' ) );

		const ok = await optimisticBatch( rows, { patch: ( item ) => ( { id: item.id, status: 'private' } ), refetch: false, success: ( count ) => `${ count } disabled` } );

		expect( ok ).toHaveLength( 150 );
		expect( ok ).not.toContain( 1101 );
		// Locked (row and parent) while the requests ran, released after.
		expect( pendingDuring ).toEqual( [ true, true ] );
		expect( isRowPending( 1001 ) ).toBe( false );
		// Three requests: planned with every row, closed at the end.
		expect( vi.mocked( batchVariationsAcross ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { planned: 250 } );
		expect( closeBatch ).toHaveBeenCalledWith( 'batch-x' );
		// Only the failed request's rows go back to what they showed.
		const rollback = vi.mocked( patchItems ).mock.calls.map( ( [ patches ] ) => patches as Array< { id: number; status?: string } > ).find( ( patches ) => patches.every( ( patch ) => patch.status === 'publish' ) );
		expect( rollback?.map( ( patch ) => patch.id ) ).toEqual( rows.slice( 100, 200 ).map( ( row ) => row.id ) );
		expect( notify.success ).toHaveBeenCalledWith( '150 disabled', expect.objectContaining( { actions: [ expect.objectContaining( { label: 'Undo' } ) ] } ) );
		expect( vi.mocked( notify.error ).mock.calls[ 0 ]?.[ 0 ] ).toMatch( /^100 items could not be updated: .*may have been saved anyway/ );
	} );

	it( 'settles a request with an unknown outcome by re-reading its rows: the ones that hold the new value count as updated', async () => {
		vi.mocked( batchProducts ).mockRejectedValue( Object.assign( new Error( 'Gateway Timeout' ), { code: 'http_error', status: 504 } ) );
		vi.mocked( hydrateSelection ).mockResolvedValue( {
			items: [ { ...simple( 1 ), status: 'draft' }, { ...simple( 2 ), status: 'publish' } ] as ProductListItem[],
			missing: [ 3 ],
		} as never );

		const ok = await optimisticBatch( [ simple( 1 ), simple( 2 ), simple( 3 ) ], { patch: ( item ) => ( { id: item.id, status: 'draft' } ), refetch: false, success: ( count ) => `${ count } drafted` } );

		expect( ok ).toEqual( [ 1 ] );
		expect( vi.mocked( hydrateSelection ).mock.calls[ 0 ]?.[ 1 ] ).toEqual( expect.arrayContaining( [ 'id', 'status', 'date_modified_gmt' ] ) );
		expect( notify.success ).toHaveBeenCalledWith( '1 drafted', expect.anything() );
		expect( vi.mocked( notify.error ).mock.calls[ 0 ]?.[ 0 ] ).toMatch( /^2 items could not be updated/ );
		// The rows show what is stored now.
		expect( vi.mocked( patchItems ).mock.calls.flatMap( ( [ patches ] ) => patches as Array< { id: number; status?: string } > ).filter( ( patch ) => patch.id === 2 ).pop() ).toMatchObject( { status: 'publish' } );
	} );

	it( 'reports a row another tab or user changed meanwhile (409 conflict): rolled back, re-read, and said so', async () => {
		vi.mocked( batchProducts ).mockImplementation( ( async ( update: Array< Record< string, unknown > > ) => ( {
			update: [ echo( update[ 0 ]! ), { id: 2, error: { code: 'wc_products_list_conflict', message: 'Changed meanwhile.', data: { status: 409 } } } ],
		} ) ) as never );
		vi.mocked( hydrateSelection ).mockResolvedValue( { items: [ { ...simple( 2 ), status: 'private' } ] as ProductListItem[], missing: [] } as never );

		const ok = await optimisticBatch( [ simple( 1, { status: 'draft' } ), simple( 2, { status: 'draft' } ) ], { patch: ( item ) => ( { id: item.id, status: 'publish' } ), refetch: false, success: ( count ) => `${ count } published` } );

		expect( ok ).toEqual( [ 1 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [
			{ id: 1, status: 'publish', _wcpl_expect: { status: 'draft' } },
			{ id: 2, status: 'publish', _wcpl_expect: { status: 'draft' } },
		] );

		const row2 = vi.mocked( patchItems ).mock.calls.flatMap( ( [ patches ] ) => patches as Array< { id: number; status?: string } > ).filter( ( patch ) => patch.id === 2 );
		// Optimistic, then the snapshot, then what the other change stored.
		expect( row2.map( ( patch ) => patch.status ) ).toEqual( [ 'publish', 'draft', 'private' ] );
		expect( vi.mocked( notify.error ).mock.calls[ 0 ]?.[ 0 ] ).toContain( 'Changed by someone else since it was loaded' );
		expect( notify.success ).toHaveBeenCalledWith( '1 published', expect.anything() );
	} );

	it( 'drops a row deleted meanwhile (404 wc_products_list_deleted) from the list and says so', async () => {
		vi.mocked( batchProducts ).mockImplementation( ( async ( update: Array< Record< string, unknown > > ) => ( {
			update: [ echo( update[ 0 ]! ), { id: 2, error: { code: 'wc_products_list_deleted', message: 'Deleted.', data: { status: 404, id: 2 } } } ],
		} ) ) as never );

		const ok = await optimisticBatch( [ simple( 1, { status: 'draft' } ), simple( 2, { status: 'draft' } ) ], { patch: ( item ) => ( { id: item.id, status: 'publish' } ), refetch: false, success: ( count ) => `${ count } published` } );

		expect( ok ).toEqual( [ 1 ] );
		expect( removeItems ).toHaveBeenCalledWith( [ 2 ] );
		expect( vi.mocked( notify.error ).mock.calls[ 0 ]?.[ 0 ] ).toContain( 'Deleted meanwhile' );
	} );
} );

describe( 'dropFromSelection', () => {
	it( 'removes the processed ids and leaves the rest selected', () => {
		const onChangeSelection = vi.fn();

		dropFromSelection( { selection: [ '1', '2', '3' ], onChangeSelection }, [ 1, 3 ] );
		expect( onChangeSelection ).toHaveBeenCalledWith( [ '2' ] );

		onChangeSelection.mockClear();
		dropFromSelection( { selection: [ '2' ], onChangeSelection }, [ 9 ] );
		expect( onChangeSelection ).not.toHaveBeenCalled();
	} );
} );
