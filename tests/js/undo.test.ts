import { afterEach, describe, expect, it, vi } from 'vitest';

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const revertBatch = vi.fn();
const getRevertPlan = vi.fn();

vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/api/client', () => ( {
	newBatchId: () => 'revert-1',
	revertBatch: ( ...args: unknown[] ) => revertBatch( ...args ),
	getRevertPlan: ( ...args: unknown[] ) => getRevertPlan( ...args ),
	closeBatch: vi.fn( async () => undefined ),
} ) );
vi.mock( '../../resources/store/products', () => ( { invalidateProducts: vi.fn() } ) );
vi.mock( '../../resources/history/use-log', () => ( { invalidateLog: vi.fn() } ) );

const { revertingMessage, undoBatch, undoNoticeId } = await import( '../../resources/edit/undo' );

afterEach( () => {
	vi.clearAllMocks();
} );

describe( 'undoBatch', () => {
	it( 'says it is reverting from the first moment, counts up per chunk, then replaces the notice with the result', async () => {
		getRevertPlan.mockResolvedValueOnce( { chunk: 2, chunks: [ [ 1, 2 ], [ 3 ] ], rows: 3, objects: 3, skipped: [], revertable: true } );
		revertBatch.mockImplementation( async ( _batch: string, options: { ids: number[] } ) => ( { batch_id: 'revert-1', results: options.ids.map( ( id ) => ( { id, ok: true } ) ), items: [] } ) );

		await undoBatch( 'batch-a' );

		const id = undoNoticeId( 'batch-a' );
		const infos = notify.info.mock.calls.map( ( call ) => call[ 0 ] );

		expect( infos[ 0 ] ).toBe( 'Reverting…' );
		expect( infos ).toContain( 'Reverting 0 of 3 items…' );
		expect( infos ).toContain( 'Reverting 2 of 3 items…' );
		expect( infos[ infos.length - 1 ] ).toBe( 'Reverting 3 of 3 items…' );
		expect( notify.info.mock.calls.every( ( call ) => call[ 1 ]?.id === id ) ).toBe( true );
		expect( notify.remove ).toHaveBeenCalledWith( id );
		expect( notify.success ).toHaveBeenCalledWith( '3 items put back.' );
		expect( revertBatch ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'counts what was put back when one of several requests is lost, and refreshes the list and History', async () => {
		const { invalidateProducts } = await import( '../../resources/store/products' );
		const { invalidateLog } = await import( '../../resources/history/use-log' );

		getRevertPlan.mockResolvedValueOnce( { chunk: 2, chunks: [ [ 1, 2 ], [ 3, 4 ], [ 5, 6 ] ], rows: 6, objects: 6, skipped: [], revertable: true } );
		revertBatch.mockImplementation( async ( _batch: string, options: { ids: number[] } ) => {
			if ( options.ids.includes( 3 ) ) {
				throw new Error( 'Could not get a valid response from the server.' );
			}

			return { batch_id: 'revert-1', results: options.ids.map( ( id ) => ( { id, ok: true } ) ), items: [] };
		} );

		await undoBatch( 'batch-p' );

		expect( revertBatch ).toHaveBeenCalledTimes( 3 );
		expect( notify.error ).toHaveBeenCalledWith( expect.stringMatching( /^4 put back, 2 failed: Could not get a valid response from the server\. It may have been saved anyway/ ) );
		expect( notify.success ).not.toHaveBeenCalled();
		expect( invalidateProducts ).toHaveBeenCalled();
		expect( invalidateLog ).toHaveBeenCalled();
	} );

	it( 'drops the progress notice and reports the error when the revert fails', async () => {
		getRevertPlan.mockRejectedValueOnce( new Error( 'Gone' ) );

		await undoBatch( 'batch-b' );

		expect( notify.remove ).toHaveBeenCalledWith( undoNoticeId( 'batch-b' ) );
		expect( notify.error ).toHaveBeenCalledWith( 'Gone' );
		expect( notify.success ).not.toHaveBeenCalled();
	} );

	it( 'refuses an Undo while a save in this tab still writes one of the batch\'s rows, and says so', async () => {
		const activity = await import( '../../resources/store/save-activity' );
		const job = activity.beginSaveJob( [ { id: 2, parent_id: 0 } ] );

		getRevertPlan.mockResolvedValueOnce( { chunk: 2, chunks: [ [ 1, 2 ] ], rows: 2, objects: 2, skipped: [], revertable: true } );

		try {
			await undoBatch( 'batch-c' );
		} finally {
			activity.finishSaveJob( job );
		}

		expect( revertBatch ).not.toHaveBeenCalled();
		expect( notify.remove ).toHaveBeenCalledWith( undoNoticeId( 'batch-c' ) );
		expect( String( notify.error.mock.calls[ 0 ]?.[ 0 ] ) ).toContain( 'still being saved in this tab' );
	} );

	it( 'formats the progress', () => {
		expect( revertingMessage( 0, 0 ) ).toBe( 'Reverting…' );
		expect( revertingMessage( 100, 220 ) ).toBe( 'Reverting 100 of 220 items…' );
	} );
} );
