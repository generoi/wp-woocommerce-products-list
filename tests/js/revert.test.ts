import { describe, expect, it, vi } from 'vitest';
import type { ActionResponse } from '../../resources/api/client';
import { checkRevertPlan, describeConflict, relativeConflicts, runRevert, splitResults } from '../../resources/history/revert';
import { describeBatchScope, isRevertableRow, scopeFromPlan, summarizeBatch } from '../../resources/history/batch-scope';
import type { LogRow } from '../../resources/api/client';

vi.mock( '../../resources/api/client', () => ( {
	newBatchId: () => 'revert-1',
	logSkipped: vi.fn( async () => undefined ),
	isRequestFailure: ( data: unknown ) => typeof data === 'object' && data !== null && ( data as { wcpl_request_failed?: unknown } ).wcpl_request_failed === true,
	revertBatch: vi.fn(),
	getRevertPlan: vi.fn(),
	checkRevert: vi.fn(),
	closeBatch: vi.fn( async () => undefined ),
} ) );

function response( results: ActionResponse[ 'results' ] ): ActionResponse {
	return { batch_id: 'revert-1', results, items: [] };
}

describe( 'runRevert', () => {
	it( 'sends at most 3 chunks at once and keeps the results in chunk order', async () => {
		let inFlight = 0;
		let peak = 0;
		const resolvers: Array< () => void > = [];
		const post = vi.fn( ( _batch: string, options?: { ids?: number[] } ) => {
			inFlight += 1;
			peak = Math.max( peak, inFlight );

			return new Promise< ActionResponse >( ( resolve ) => {
				resolvers.push( () => {
					inFlight -= 1;
					resolve( response( ( options?.ids ?? [] ).map( ( id ) => ( { id, ok: true } ) ) ) );
				} );
			} );
		} );
		const run = runRevert( 'batch-a', { chunk: 1, chunks: [ [ 1 ], [ 2 ], [ 3 ], [ 4 ], [ 5 ] ] }, {}, post );

		await Promise.resolve();
		expect( post ).toHaveBeenCalledTimes( 3 );
		// Finish out of order: the later chunks still land after the earlier ones.
		while ( resolvers.length ) {
			( resolvers.pop() as () => void )();
			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		}

		const outcome = await run;

		expect( peak ).toBe( 3 );
		expect( post ).toHaveBeenCalledTimes( 5 );
		expect( outcome.ok ).toBe( 5 );
	} );

	it( 'posts one request per chunk under one revert batch id, with progress, and sorts the results', async () => {
		const post = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) =>
			response( ( options?.ids ?? [] ).map( ( id ) => ( id === 3 ? { id, ok: false, code: 'conflict', fields: [ 'regular_price' ] } : id === 5 ? { id, ok: false, code: 'rest_invalid_param', message: 'Bad' } : { id, ok: true } ) ) )
		);
		const progress: Array< [ number, number ] > = [];
		const outcome = await runRevert( 'batch-a', { chunk: 2, chunks: [ [ 1, 2 ], [ 3, 4 ], [ 5 ] ] }, { onProgress: ( done, total ) => progress.push( [ done, total ] ) }, post );

		expect( post.mock.calls.map( ( call ) => call[ 1 ] ) ).toEqual( [
			{ ids: [ 1, 2 ], revertBatchId: 'revert-1', force: undefined, relative: undefined, fields: [ 'id' ], batchId: 'revert-1', planned: 5 },
			{ ids: [ 3, 4 ], revertBatchId: 'revert-1', force: undefined, relative: undefined, fields: [ 'id' ], batchId: 'revert-1', planned: 5 },
			{ ids: [ 5 ], revertBatchId: 'revert-1', force: undefined, relative: undefined, fields: [ 'id' ], batchId: 'revert-1', planned: 5 },
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
			{ ids: [ 3, 7 ], revertBatchId: 'revert-1', force: true, fields: [ 'id' ], batchId: 'revert-1', planned: 3 },
			{ ids: [ 9 ], revertBatchId: 'revert-1', force: true, fields: [ 'id' ], batchId: 'revert-1', planned: 3 },
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

		expect( scope ).toEqual( { changes: 158, objects: 158, fields: [], partial: false, skipped: 2, failed: 0, skippedActions: [ 'trash', 'delete' ] } );
		expect( describeBatchScope( scope ) ).toBe( 'This will put back 158 changes on 158 items. 2 entries (trash, delete) are not reverted.' );
		expect( describeBatchScope( scopeFromPlan( { rows: 1, objects: 1, skipped: [] } ) ) ).toBe( 'This will put back 1 change on 1 item.' );
	} );

	it( 'counts changes that failed when they were made apart from trash and restore entries', () => {
		const scope = scopeFromPlan( { rows: 4, objects: 2, failed: 1, skipped: [ { id: 9, object_type: 'product', action: 'failed' }, { id: 10, object_type: 'product', action: 'trash' } ] } );

		expect( scope ).toMatchObject( { changes: 2, skipped: 1, failed: 1 } );
		expect( describeBatchScope( scope ) ).toBe( 'This will put back 2 changes on 2 items. 1 entry (trash) is not reverted. 1 failed change, nothing to revert.' );
	} );
} );

describe( 'left-out items', () => {
	it( 'says items that already had the value were left out, not that they are trash or delete entries', () => {
		const scope = scopeFromPlan( { rows: 1, objects: 1, skipped: [], left_out: 6, left_out_reasons: { unchanged: 5, trashed: 1 } }, ( action ) => action );

		expect( describeBatchScope( scope ) ).toBe(
			'This will put back 1 change on 1 item. 5 items were left out because they already had this value; nothing to put back. 1 item was left out when the batch ran (trashed meanwhile); nothing to put back.'
		);
	} );

	it( 'names the not-revertable actions by their labels', () => {
		const scope = scopeFromPlan( { rows: 3, objects: 1, skipped: [ { id: 1, object_type: 'product', action: 'duplicate' } ] }, () => 'Duplicate' );

		expect( describeBatchScope( scope ) ).toBe( 'This will put back 2 changes on 1 item. 1 entry (Duplicate) is not reverted.' );
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
		expect( describeBatchScope( { changes: 3, objects: 2, fields: [], partial: false, skipped: 1 } ) ).toBe( 'This will put back 3 changes on 2 items. 1 entry cannot be reverted.' );
	} );
} );

describe( 'conflict reports', () => {
	const conflict = {
		id: 24514,
		ok: false,
		code: 'conflict',
		name: 'Pelsi Black 37-38',
		fields: [ 'stock_quantity' ],
		labels: [ 'Stock quantity' ],
		current: { stock_quantity: 9 },
		batch: { stock_quantity: 10 },
		expected: { stock_quantity: 0 },
		relative: true,
	};

	it( 'names the item, the field label and the value kept', () => {
		expect( describeConflict( conflict ) ).toBe( 'Pelsi Black 37-38: Stock quantity 10 → 9 kept' );
		// An older server without labels or values: the mapped label alone.
		expect( describeConflict( { id: 3, ok: false, code: 'conflict', fields: [ 'sale_price' ] }, () => 'Sale price' ) ).toBe( '#3: Sale price' );
	} );

	it( 'offers a relative revert only for the conflicts the server marks relative, and posts relative: true for them', async () => {
		expect( relativeConflicts( [ conflict, { ...conflict, id: 5, relative: false } ] ).map( ( result ) => result.id ) ).toEqual( [ 24514 ] );

		const post = vi.fn( async ( _batch: string, _options?: object ) => response( [ { id: 24514, ok: true } ] ) );

		await runRevert( 'batch-a', { chunk: 100, chunks: [] }, { ids: [ 24514 ], relative: true, revertBatchId: 'r1' }, post );
		// One chunk is one request: no planned header, the revert batch id as the batch header.
		expect( post.mock.calls[ 0 ]?.[ 1 ] ).toEqual( { ids: [ 24514 ], revertBatchId: 'r1', force: undefined, relative: true, fields: [ 'id' ], batchId: 'r1' } );
	} );
} );

describe( 'checkRevertPlan', () => {
	const check = ( ids?: number[] ) => ( {
		batch_id: 'b',
		checked: ids?.length ?? 2,
		objects: 3,
		complete: false,
		changed: ids?.includes( 3 ) ? 1 : 2,
		already_reverted: ids?.includes( 3 ) ? 0 : 1,
		items: ids?.includes( 3 ) ? [ { id: 3, ok: false, fields: [ 'stock_quantity' ], already_reverted: [] } ] : [ { id: 1, ok: false, fields: [ 'stock_quantity' ], already_reverted: [ 'stock_quantity' ] }, { id: 2, ok: false, fields: [ 'regular_price' ], already_reverted: [] } ],
	} );

	it( 'checks every chunk of a batch of several chunks and sums the counts', async () => {
		const fn = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) => check( options?.ids ) );
		const summary = await checkRevertPlan( 'b', { chunks: [ [ 1, 2 ], [ 3 ] ] }, fn );

		expect( fn.mock.calls.map( ( call ) => call[ 1 ]?.ids ) ).toEqual( [ [ 1, 2 ], [ 3 ] ] );
		expect( summary.changed ).toBe( 3 );
		expect( summary.alreadyReverted ).toBe( 1 );
		// The example is a real change, not one an earlier revert put back.
		expect( summary.example?.id ).toBe( 2 );
	} );

	it( 'checks a one-chunk batch without ids', async () => {
		const fn = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) => check( options?.ids ) );

		await checkRevertPlan( 'b', { chunks: [ [ 1, 2 ] ] }, fn );
		expect( fn.mock.calls[ 0 ]?.[ 1 ]?.ids ).toBeUndefined();
	} );
} );

describe( 'checkRevertPlan', () => {
	it( 'checks a many-chunk batch at most REVERT_PARALLEL chunks at a time and sums every chunk', async () => {
		let inFlight = 0;
		let most = 0;
		const chunks = Array.from( { length: 12 }, ( _, index ) => [ index + 1 ] );
		const check = vi.fn( async () => {
			inFlight++;
			most = Math.max( most, inFlight );
			await new Promise( ( resolve ) => setTimeout( resolve, 1 ) );
			inFlight--;

			return { changed: 1, already_reverted: 0, items: [] } as never;
		} );

		const summary = await checkRevertPlan( 'b', { chunks }, check );

		expect( check ).toHaveBeenCalledTimes( 12 );
		expect( most ).toBe( 3 );
		expect( summary.changed ).toBe( 12 );
	} );
} );

describe( 'runRevert and the list', () => {
	it( 'shows a revert in the list while it runs: its objects locked, "Reverting" in the bar, leaving guarded, the batch closed at the end', async () => {
		const activity = await import( '../../resources/store/save-activity' );
		const client = await import( '../../resources/api/client' );
		const add = vi.spyOn( window, 'addEventListener' );
		const releases: Array< () => void > = [];
		const release = () => releases.shift()?.();
		const post = vi.fn(
			( _batch: string, options?: { ids?: number[] } ) =>
				new Promise< ActionResponse >( ( resolve ) => {
					releases.push( () => resolve( response( ( options?.ids ?? [] ).map( ( id ) => ( { id, ok: true } ) ) ) ) );
				} )
		);
		const close = vi.fn( async () => undefined );
		const run = runRevert( 'batch-a', { chunk: 2, chunks: [ [ 11, 12 ], [ 13 ] ] }, { close }, post );

		await Promise.resolve();
		expect( activity.isRowPending( 11 ) ).toBe( true );
		expect( activity.isRowPending( 13 ) ).toBe( true );
		expect( add ).toHaveBeenCalledWith( 'beforeunload', expect.any( Function ) );

		const { renderHook } = await import( '@testing-library/react' );
		const { result } = renderHook( () => activity.useSaveActivity() );

		expect( result.current ).toMatchObject( { reverting: true, total: 3 } );

		// Both chunks are in flight at once (REVERT_PARALLEL); answer them one by one.
		while ( post.mock.calls.length < 2 ) {
			await Promise.resolve();
		}
		release();
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		expect( close ).not.toHaveBeenCalled();
		release();
		await run;

		expect( close ).toHaveBeenCalledWith( 'revert-1' );
		expect( activity.isRowPending( 11 ) ).toBe( false );
		expect( client.closeBatch ).not.toHaveBeenCalled();
		add.mockRestore();
	} );

	it( 'refuses a revert while a save in this tab still writes one of its objects, and posts nothing', async () => {
		const activity = await import( '../../resources/store/save-activity' );
		const { RevertBusyError } = await import( '../../resources/history/revert' );
		const job = activity.beginSaveJob( [ { id: 21, parent_id: 20 } ] );
		const post = vi.fn();

		try {
			await expect( runRevert( 'batch-a', { chunk: 2, chunks: [ [ 20, 21 ], [ 30 ] ] }, {}, post ) ).rejects.toBeInstanceOf( RevertBusyError );
			await expect( runRevert( 'batch-a', { chunk: 2, chunks: [ [ 21 ] ] }, {}, post ) ).rejects.toThrow( '1 item of this batch is still being saved in this tab' );
			expect( post ).not.toHaveBeenCalled();
		} finally {
			activity.finishSaveJob( job );
		}
	} );

	it( 'closes the revert batch and unlocks its objects when a chunk fails, after the other chunks are back', async () => {
		const activity = await import( '../../resources/store/save-activity' );
		const close = vi.fn( async () => undefined );
		const post = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) => {
			if ( options?.ids?.includes( 2 ) ) {
				throw new Error( 'Gateway timeout' );
			}

			await new Promise( ( resolve ) => setTimeout( resolve, 5 ) );

			return response( ( options?.ids ?? [] ).map( ( id ) => ( { id, ok: true } ) ) );
		} );

		const outcome = await runRevert( 'batch-a', { chunk: 1, chunks: [ [ 1 ], [ 2 ], [ 3 ] ] }, { close }, post );

		expect( post ).toHaveBeenCalledTimes( 3 );
		expect( close ).toHaveBeenCalledTimes( 1 );
		expect( activity.isRowPending( 1 ) ).toBe( false );
		expect( activity.isRowPending( 3 ) ).toBe( false );
		// The chunks that answered still count; the lost one is reported per object, not thrown away.
		expect( outcome.ok ).toBe( 2 );
		expect( outcome.failed.map( ( result ) => result.id ) ).toEqual( [ 2 ] );
	} );

	it( 'keeps what was put back when one of several requests is lost: per-object failures, outcome unknown said so', async () => {
		const { ApiError } = await import( '../../resources/api/errors' );
		const post = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) => {
			if ( options?.ids?.includes( 3 ) ) {
				throw new Error( 'Could not get a valid response from the server.' );
			}

			if ( options?.ids?.includes( 5 ) ) {
				throw new ApiError( 'Sorry, you are not allowed to do that.', 'rest_forbidden', 403 );
			}

			return response( ( options?.ids ?? [] ).map( ( id ) => ( { id, ok: true } ) ) );
		} );

		const outcome = await runRevert( 'batch-a', { chunk: 2, chunks: [ [ 1, 2 ], [ 3, 4 ], [ 5, 6 ] ] }, { close: async () => undefined }, post );

		expect( post ).toHaveBeenCalledTimes( 3 );
		expect( outcome.ok ).toBe( 2 );
		expect( outcome.failed.map( ( result ) => result.id ) ).toEqual( [ 3, 4, 5, 6 ] );
		// No answer: it may have been stored anyway.
		expect( outcome.failed[ 0 ] ).toMatchObject( { ok: false, code: 'wc_products_list_uncertain', message: expect.stringContaining( 'may have been saved anyway' ) } );
		// A 4xx was refused before anything was written.
		expect( outcome.failed[ 2 ] ).toMatchObject( { ok: false, code: 'rest_forbidden' } );
		expect( outcome.failed[ 2 ]?.message ).not.toContain( 'may have been saved anyway' );
	} );

	it( 'still throws when no request got an answer (nothing was put back for sure)', async () => {
		const post = vi.fn( async () => {
			throw new Error( 'Offline' );
		} );

		const logFailed = vi.fn( async () => undefined );

		await expect( runRevert( 'batch-a', { chunk: 1, chunks: [ [ 1 ], [ 2 ] ] }, { close: async () => undefined, logFailed }, post ) ).rejects.toThrow( 'Offline' );
		expect( post ).toHaveBeenCalledTimes( 2 );
		// Nothing answered: the revert batch still records its objects as failed (History shows the attempt).
		expect( logFailed ).toHaveBeenCalledWith( 'revert-1', 'revert', [ expect.objectContaining( { id: 1, reason: 'failed' } ), expect.objectContaining( { id: 2, reason: 'failed' } ) ] );
	} );

	it( 'records a failed one-request revert in its batch (it has no planned header, so no "Interrupted" state)', async () => {
		const post = vi.fn( async () => {
			throw Object.assign( new Error( 'Could not get a valid response from the server.' ), { code: 'fetch_error' } );
		} );
		const logFailed = vi.fn( async () => undefined );
		const close = vi.fn( async () => undefined );

		await expect( runRevert( 'batch-a', { chunk: 100, chunks: [ [ 7, 8 ] ] }, { close, logFailed }, post ) ).rejects.toThrow( 'Could not get a valid response' );
		expect( close ).not.toHaveBeenCalled();
		expect( logFailed ).toHaveBeenCalledWith( 'revert-1', 'revert', [
			{ id: 7, reason: 'failed', message: expect.stringContaining( 'It may have been saved anyway' ) },
			{ id: 8, reason: 'failed', message: expect.stringContaining( 'It may have been saved anyway' ) },
		] );
	} );

	it( 'posts nothing when every chunk was answered (the server logged per-object failures itself)', async () => {
		const post = vi.fn( async ( _batch: string, options?: { ids?: number[] } ) => response( ( options?.ids ?? [] ).map( ( id ) => ( id === 2 ? { id, ok: false, code: 'error', message: 'No.' } : { id, ok: true } ) ) ) );
		const logFailed = vi.fn( async () => undefined );

		const outcome = await runRevert( 'batch-a', { chunk: 1, chunks: [ [ 1 ], [ 2 ] ] }, { close: async () => undefined, logFailed }, post as never );

		expect( outcome.failed.map( ( result ) => result.id ) ).toEqual( [ 2 ] );
		expect( logFailed ).not.toHaveBeenCalled();
	} );
} );
