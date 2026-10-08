import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchProducts, batchVariations } from '../../resources/api/client';
import { optimisticBatch } from '../../resources/actions/status';
import { dropFromSelection } from '../../resources/actions/context';
import { setSettings } from '../../resources/settings';
import { editSettings, simple, variation } from './edit-fixtures';

vi.mock( '../../resources/api/client', () => ( {
	batchProducts: vi.fn( async ( update: Array< { id: number } > ) => ( { update } ) ),
	batchVariations: vi.fn( async ( _parentId: number, update: Array< { id: number } > ) => ( { update } ) ),
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
		vi.mocked( batchVariations ).mockClear();
	} );

	it( 'logs one row as a quick change and several as a bulk one, and resolves with the ids updated', async () => {
		const one = await optimisticBatch( [ simple( 1 ) ], { patch: ( item ) => ( { id: item.id, featured: true } ), refetch: false, success: () => '' } );
		expect( one ).toEqual( [ 1 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).toEqual( { batchId: 'batch-x', source: 'quick' } );

		const many = await optimisticBatch( [ simple( 1 ), simple( 2 ), variation( 31, 3 ) ], { patch: ( item ) => ( { id: item.id, status: 'draft' } ), refetch: false, success: () => '' } );
		expect( many ).toEqual( [ 31, 1, 2 ] );
		expect( vi.mocked( batchProducts ).mock.calls[ 1 ]?.[ 1 ] ).toEqual( { batchId: 'batch-x', source: 'bulk' } );
		expect( vi.mocked( batchVariations ).mock.calls[ 0 ]?.[ 2 ] ).toEqual( { batchId: 'batch-x', source: 'bulk' } );
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
