import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchProducts, batchVariationsAcross } from '../../resources/api/client';
import { optimisticBatch } from '../../resources/actions/status';
import { dropFromSelection } from '../../resources/actions/context';
import { notify } from '../../resources/actions/notices';
import { patchItems } from '../../resources/store/products';
import { setSettings } from '../../resources/settings';
import { coreFields, editSettings, simple, variation } from './edit-fixtures';

vi.mock( '../../resources/api/client', () => ( {
	batchProducts: vi.fn( async ( update: Array< { id: number } > ) => ( { update } ) ),
	batchVariationsAcross: vi.fn( async ( update: Array< { id: number; parent_id: number } > ) => ( { update: update.map( ( { parent_id: _parent, ...row } ) => row ) } ) ),
	newBatchId: () => 'batch-x',
	toRow: ( row: unknown ) => row,
} ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), invalidateProducts: vi.fn() } ) );

describe( 'optimisticBatch', () => {
	beforeEach( () => setSettings( editSettings() ) );
	afterEach( () => {
		setSettings( undefined );
		vi.mocked( batchProducts ).mockClear();
		vi.mocked( batchVariationsAcross ).mockClear();
		vi.mocked( notify.success ).mockClear();
		vi.mocked( patchItems ).mockClear();
	} );

	it( 'logs one row as a quick change and several as a bulk one, and resolves with the ids updated', async () => {
		const one = await optimisticBatch( [ simple( 1 ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '' } );
		expect( one ).toEqual( [ 1 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).toEqual( { batchId: 'batch-x', source: 'quick' } );

		const many = await optimisticBatch( [ simple( 1 ), simple( 2 ), variation( 31, 3 ) ], { patch: ( item ) => ( { id: item.id, status: 'draft' } ), refetch: false, success: () => '' } );
		expect( many ).toEqual( [ 31, 1, 2 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 1 ]?.[ 1 ] ).toEqual( { batchId: 'batch-x', source: 'bulk' } );
		expect( vi.mocked( batchVariationsAcross ).mock.calls[ 0 ]?.[ 1 ] ).toEqual( { batchId: 'batch-x', source: 'bulk' } );
	} );

	it( 'sends the variations of every parent in one cross-parent request, with their parent ids, and patches the returned rows in one go', async () => {
		const rows = [ variation( 31, 3 ), variation( 41, 4 ), variation( 32, 3 ), simple( 1 ) ];
		const ok = await optimisticBatch( rows, { patch: ( item ) => ( { id: item.id, status: 'private' } ), refetch: false, success: () => '' } );

		expect( ok ).toEqual( [ 31, 41, 32, 1 ] );
		expect( vi.mocked( batchVariationsAcross ) ).toHaveBeenCalledTimes( 1 );
		expect( vi.mocked( batchVariationsAcross ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [
			{ id: 31, status: 'private', parent_id: 3 },
			{ id: 41, status: 'private', parent_id: 4 },
			{ id: 32, status: 'private', parent_id: 3 },
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
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [ { id: 2, featured: true } ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { fields: expect.arrayContaining( [ 'id', 'featured', 'name' ] ) } );
		expect( vi.mocked( notify.success ) ).toHaveBeenCalledWith( '1 featured' );

		// Nothing eligible: no request, no notice.
		expect( await optimisticBatch( [ simple( 3, { featured: true } ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '', eligible: ( item ) => item.featured !== true } ) ).toEqual( [] );
		expect( vi.mocked( batchProducts ) ).toHaveBeenCalledTimes( 1 );
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
