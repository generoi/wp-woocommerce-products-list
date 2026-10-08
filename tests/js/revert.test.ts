import { describe, expect, it, vi } from 'vitest';
import type { ActionResponse } from '../../resources/api/client';
import { runRevert, splitResults } from '../../resources/history/revert';
import { describeBatchScope, isRevertableRow, scopeFromPlan, summarizeBatch } from '../../resources/history/batch-scope';
import type { LogRow } from '../../resources/api/client';

vi.mock( '../../resources/api/client', () => ( {
	newBatchId: () => 'revert-1',
	revertBatch: vi.fn(),
	getRevertPlan: vi.fn(),
} ) );

function response( results: ActionResponse[ 'results' ] ): ActionResponse {
	return { batch_id: 'revert-1', results, items: [] };
}

describe( 'runRevert', () => {
	it( 'posts one request per chunk under one revert batch id, with progress, and sorts the results', async () => {
		const post = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) =>
			response( ( options?.ids ?? [] ).map( ( id ) => ( id === 3 ? { id, ok: false, code: 'conflict', fields: [ 'regular_price' ] } : id === 5 ? { id, ok: false, code: 'rest_invalid_param', message: 'Bad' } : { id, ok: true } ) ) )
		);
		const progress: Array< [ number, number ] > = [];
		const outcome = await runRevert( 'batch-a', { chunk: 2, chunks: [ [ 1, 2 ], [ 3, 4 ], [ 5 ] ] }, { onProgress: ( done, total ) => progress.push( [ done, total ] ) }, post );

		expect( post.mock.calls.map( ( call ) => call[ 1 ] ) ).toEqual( [
			{ ids: [ 1, 2 ], revertBatchId: 'revert-1', force: undefined, fields: [ 'id' ] },
			{ ids: [ 3, 4 ], revertBatchId: 'revert-1', force: undefined, fields: [ 'id' ] },
			{ ids: [ 5 ], revertBatchId: 'revert-1', force: undefined, fields: [ 'id' ] },
		] );
		expect( progress ).toEqual( [ [ 0, 5 ], [ 2, 5 ], [ 4, 5 ], [ 5, 5 ] ] );
		expect( outcome.ok ).toBe( 3 );
		expect( outcome.conflicts.map( ( result ) => result.id ) ).toEqual( [ 3 ] );
		expect( outcome.failed.map( ( result ) => result.id ) ).toEqual( [ 5 ] );
		expect( outcome.revertBatchId ).toBe( 'revert-1' );
	} );

	it( 'retries given ids with force under the same revert batch, cut to the chunk size', async () => {
		const post = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) => response( ( options?.ids ?? [] ).map( ( id ) => ( { id, ok: true } ) ) ) );
		const outcome = await runRevert( 'batch-a', { chunk: 2, chunks: [] }, { ids: [ 3, 7, 9 ], force: true, revertBatchId: 'revert-1' }, post );

		expect( post.mock.calls.map( ( call ) => call[ 1 ] ) ).toEqual( [
			{ ids: [ 3, 7 ], revertBatchId: 'revert-1', force: true, fields: [ 'id' ] },
			{ ids: [ 9 ], revertBatchId: 'revert-1', force: true, fields: [ 'id' ] },
		] );
		expect( outcome.ok ).toBe( 3 );
	} );

	it( 'counts skipped entries apart from failures', () => {
		expect( splitResults( [ { id: 1, ok: false, code: 'skipped' }, { id: 2, ok: true } ] ) ).toEqual( { ok: 1, conflicts: [], failed: [], skipped: 1 } );
	} );
} );

describe( 'scopeFromPlan', () => {
	it( 'describes the plan exactly, naming what is left alone', () => {
		const scope = scopeFromPlan( { rows: 160, objects: 158, skipped: [ { id: 9, object_type: 'product', action: 'trash' }, { id: 10, object_type: 'product', action: 'delete' } ] } );

		expect( scope ).toEqual( { changes: 158, objects: 158, fields: [], partial: false, skipped: 2, failed: 0 } );
		expect( describeBatchScope( scope ) ).toBe( 'This will put back 158 changes on 158 items. 2 entries (trash, restore, delete or duplicate) are not reverted.' );
		expect( describeBatchScope( scopeFromPlan( { rows: 1, objects: 1, skipped: [] } ) ) ).toBe( 'This will put back 1 change on 1 item.' );
	} );

	it( 'counts changes that failed when they were made apart from trash and restore entries', () => {
		const scope = scopeFromPlan( { rows: 4, objects: 2, failed: 1, skipped: [ { id: 9, object_type: 'product', action: 'failed' }, { id: 10, object_type: 'product', action: 'trash' } ] } );

		expect( scope ).toMatchObject( { changes: 2, skipped: 1, failed: 1 } );
		expect( describeBatchScope( scope ) ).toBe( 'This will put back 2 changes on 2 items. 1 entry (trash, restore, delete or duplicate) is not reverted. 1 failed change, nothing to revert.' );
	} );
} );

describe( 'isRevertableRow', () => {
	const row = ( overrides: Partial< LogRow > ): LogRow =>
		( { id: 1, batch_id: 'b', created_at: '', created_at_gmt: '', user: { id: 1, name: '' }, source: 'action', action: 'update', object_type: 'product', object_id: 10, parent_id: 0, object_name: '', edit_link: null, field: 'name', old_value: 'a', new_value: 'b', status: 'ok', message: '', ...overrides } ) as LogRow;

	it( 'accepts ok rows with a field of an update or of an extension action, not the built-in ones with their own way back', () => {
		expect( isRevertableRow( row( {} ) ) ).toBe( true );
		expect( isRevertableRow( row( { action: 'i18n_copy', field: 'i18n.se.name', old_value: '' } ) ) ).toBe( true );
		expect( isRevertableRow( row( { action: 'i18n_clear', field: 'i18n.se.name', new_value: null } ) ) ).toBe( true );
		expect( isRevertableRow( row( { action: 'feature', field: 'featured' } ) ) ).toBe( true );
		expect( isRevertableRow( row( { action: 'i18n_copy', field: '' } ) ) ).toBe( false );
		expect( isRevertableRow( row( { status: 'error' } ) ) ).toBe( false );

		for ( const action of [ 'trash', 'restore', 'delete', 'duplicate', 'create' ] ) {
			expect( isRevertableRow( row( { action, field: 'status' } ) ) ).toBe( false );
		}
	} );

	it( 'counts an extension action batch like an update batch in the revert confirm', () => {
		const rows = [
			row( { id: 1, action: 'i18n_copy', field: 'i18n.se.name', object_id: 10 } ),
			row( { id: 2, action: 'i18n_copy', field: 'i18n.se.slug', object_id: 10 } ),
			row( { id: 3, action: 'i18n_copy', field: 'i18n.se.name', object_id: 11 } ),
			row( { id: 4, action: 'i18n_copy', field: '', object_id: 12 } ),
		];

		expect( summarizeBatch( rows, 4 ) ).toEqual( { changes: 3, objects: 2, fields: [ 'i18n.se.name', 'i18n.se.slug' ], partial: false } );
		expect( describeBatchScope( { changes: 3, objects: 2, fields: [], partial: false, skipped: 1 } ) ).toBe( 'This will put back 3 changes on 2 items. 1 entry (trash, restore, delete or duplicate) is not reverted.' );
	} );
} );
