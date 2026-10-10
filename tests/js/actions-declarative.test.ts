import { addAction, removeAction } from '@wordpress/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS } from '../../resources/extensions/hooks';
import type { ActionResponse } from '../../resources/api/client';
import { closeBatch, logSkipped, runAction } from '../../resources/api/client';
import { isRowPending } from '../../resources/store/save-activity';
import { declarativeSummary, runDeclarativeAction } from '../../resources/actions/index';
import { notify } from '../../resources/actions/notices';
import { undoBatch } from '../../resources/edit/undo';
import { invalidateProducts, patchItems } from '../../resources/store/products';

vi.mock( '../../resources/api/client', () => ( {
	runAction: vi.fn(),
	newBatchId: () => 'b1',
	logSkipped: vi.fn( async () => undefined ),
	isRequestFailure: ( data: unknown ) => typeof data === 'object' && data !== null && ( data as { wcpl_request_failed?: unknown } ).wcpl_request_failed === true,
	closeBatch: vi.fn( async () => undefined ),
	// 100 ids per request.
	actionRequestCount: ( _action: string, count: number ) => Math.ceil( count / 100 ),
} ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), invalidateProducts: vi.fn(), findCachedRow: vi.fn( ( id: number ) => ( id === 2 ? { id, name: 'Pelsi Black' } : undefined ) ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn( async () => undefined ) } ) );
vi.mock( '../../resources/extensions/api', () => ( { getRegisteredActions: () => [], useRegistryVersion: () => 0 } ) );

function response( results: ActionResponse[ 'results' ], items: ActionResponse[ 'items' ] = [] ): ActionResponse {
	return { batch_id: 'b1', results, items };
}

describe( 'runDeclarativeAction', () => {
	afterEach( () => vi.clearAllMocks() );

	it( 'patches the returned rows, refreshes the counts and offers Undo of the batch when something changed', async () => {
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 2 }, { id: 2, ok: true, changed: 0 } ], [ { id: 1 } as ActionResponse[ 'items' ][ number ] ] ) );

		await runDeclarativeAction( 'i18n_copy', 'Copy translations', [ 1, 2 ], { lang: 'se' }, [ 'id', 'name' ] );

		expect( runAction ).toHaveBeenCalledWith( 'i18n_copy', [ 1, 2 ], { lang: 'se' }, { fields: [ 'id', 'name' ], batchId: 'b1', onProgress: expect.any( Function ) } );
		// One request: nothing planned, nothing to close.
		expect( closeBatch ).not.toHaveBeenCalled();
		expect( patchItems ).toHaveBeenCalledWith( [ { id: 1 } ] );
		expect( invalidateProducts ).toHaveBeenCalledWith( { counts: true } );
		expect( notify.error ).not.toHaveBeenCalled();

		const [ message, options ] = vi.mocked( notify.success ).mock.calls[ 0 ] as [ string, { id: string; actions: Array< { label: string; onClick: () => void } > } ];
		expect( message ).toBe( 'Copy translations: 1 updated, 1 already had these values.' );
		expect( options.id ).toBe( 'wc-pl-action-b1' );
		expect( options.actions.map( ( action ) => action.label ) ).toEqual( [ 'Undo' ] );

		options.actions[ 0 ]?.onClick();
		expect( notify.remove ).toHaveBeenCalledWith( 'wc-pl-action-b1' );
		expect( undoBatch ).toHaveBeenCalledWith( 'b1' );
	} );

	it( 'announces the changed rows (wcProductsList.actionPerformed) for an editor tool run, so they stay in a filter they left', async () => {
		const performed = vi.fn();

		addAction( ACTIONS.actionPerformed, 'test/performed', performed );
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 1 }, { id: 2, ok: false, code: 'x', message: 'No.' } ] ) );

		await expect( runDeclarativeAction( 'i18n_keep', 'Keep as is', [ 1, 2 ], {}, [ 'id' ], { inlineErrors: true, silent: true, announce: true } ) ).rejects.toThrow();
		expect( performed ).toHaveBeenCalledWith( expect.objectContaining( { action: 'i18n_keep', ids: [ 1 ] } ) );

		// The row menu's run announces in its own callback: not twice.
		performed.mockClear();
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 1 } ] ) );
		await runDeclarativeAction( 'i18n_keep', 'Keep as is', [ 1 ], {}, [ 'id' ] );
		expect( performed ).not.toHaveBeenCalled();
		removeAction( ACTIONS.actionPerformed, 'test/performed' );
	} );

	it( 'says nothing changed, without Undo, when every item already had the values', async () => {
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 0 } ] ) );

		await runDeclarativeAction( 'i18n_copy', 'Copy translations', [ 1 ], {}, [ 'id' ] );

		const [ message, options ] = vi.mocked( notify.success ).mock.calls[ 0 ] as [ string, { id: string; actions?: unknown[] } ];
		expect( message ).toBe( 'Copy translations: nothing changed, 1 item already had these values.' );
		expect( options.actions ).toBeUndefined();
	} );

	it( 'treats a result without a changed count as a change, so an older server still gets Undo', async () => {
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true }, { id: 2, ok: true } ] ) );

		await runDeclarativeAction( 'tint', 'Tint', [ 1, 2 ], {}, [ 'id' ] );

		const [ message, options ] = vi.mocked( notify.success ).mock.calls[ 0 ] as [ string, { actions?: unknown[] } ];
		expect( message ).toBe( 'Tint: 2 items updated.' );
		expect( options.actions ).toHaveLength( 1 );
	} );

	it( 'names each failed row with why, with the count of items that did update, and keeps Undo for those', async () => {
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 1 }, { id: 2, ok: false, code: 'not_found', message: 'The product no longer exists.' } ] ) );

		await runDeclarativeAction( 'i18n_clear', 'Clear translations', [ 1, 2 ], {}, [ 'id' ] );

		// The failed row is offered for another try (the server logged it, so nothing is posted for it).
		expect( notify.error ).toHaveBeenCalledWith( '1 updated, 1 failed: Pelsi Black: The product no longer exists.', { actions: [ expect.objectContaining( { label: 'Select the 1 failed' } ) ] } );
		expect( logSkipped ).not.toHaveBeenCalled();
		expect( notify.success ).toHaveBeenCalledWith( 'Clear translations: 1 item updated.', expect.objectContaining( { actions: [ expect.objectContaining( { label: 'Undo' } ) ] } ) );
		expect( invalidateProducts ).toHaveBeenCalledWith( { counts: true } );

		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 2, ok: false, code: 'forbidden', message: 'Not allowed.' } ] ) );
		await runDeclarativeAction( 'i18n_clear', 'Clear translations', [ 2 ], {}, [ 'id' ] );
		expect( notify.error ).toHaveBeenLastCalledWith( '1 item could not be updated: Pelsi Black: Not allowed.', expect.anything() );
		// A row the list has not loaded is named by its id.
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 7, ok: false, code: 'forbidden', message: 'Not allowed.' } ] ) );
		await runDeclarativeAction( 'i18n_clear', 'Clear translations', [ 7 ], {}, [ 'id' ] );
		expect( notify.error ).toHaveBeenLastCalledWith( '1 item could not be updated: #7: Not allowed.', expect.anything() );
	} );

	it( 'shows a request error and rejects so the modal stays open', async () => {
		vi.mocked( runAction ).mockRejectedValueOnce( new Error( 'Pick a translated language.' ) );

		await expect( runDeclarativeAction( 'i18n_copy', 'Copy translations', [ 1 ], {}, [ 'id' ] ) ).rejects.toThrow( 'Pick a translated language.' );
		expect( notify.error ).toHaveBeenCalledWith( 'Pick a translated language.', { actions: [ expect.objectContaining( { label: 'Select the 1 failed' } ) ] } );
		expect( notify.success ).not.toHaveBeenCalled();
		// No request was answered: the attempt is recorded in its batch as failed.
		expect( logSkipped ).toHaveBeenCalledWith( 'b1', 'action', [ { id: 1, reason: 'failed', message: 'Pick a translated language.' } ], { action: 'i18n_copy' } );
	} );

	it( 'with inline errors: no error snackbar, the failure rejects with its message, the rows that changed keep their Undo', async () => {
		vi.mocked( runAction ).mockRejectedValueOnce( { code: 'gds_woo_i18n_missing_find', message: 'Enter the text to find.' } );
		await expect( runDeclarativeAction( 'i18n_transform', 'Edit translated text', [ 1 ], {}, [ 'id' ], { inlineErrors: true } ) ).rejects.toThrow( 'Enter the text to find.' );
		expect( notify.error ).not.toHaveBeenCalled();

		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 1 }, { id: 2, ok: false, code: 'not_found', message: 'The product no longer exists.' } ] ) );
		await expect( runDeclarativeAction( 'i18n_clear', 'Clear translations', [ 1, 2 ], {}, [ 'id' ], { inlineErrors: true } ) ).rejects.toThrow( '1 updated, 1 failed: The product no longer exists.' );
		expect( notify.error ).not.toHaveBeenCalled();
		expect( notify.success ).toHaveBeenCalledWith( 'Clear translations: 1 item updated.', expect.objectContaining( { actions: [ expect.objectContaining( { label: 'Undo' } ) ] } ) );
	} );
} );

describe( 'declarativeSummary', () => {
	it( 'words the three outcomes', () => {
		expect( declarativeSummary( 'Copy translations', 3, 0 ) ).toBe( 'Copy translations: 3 items updated.' );
		expect( declarativeSummary( 'Copy translations', 1, 0 ) ).toBe( 'Copy translations: 1 item updated.' );
		expect( declarativeSummary( 'Copy translations', 2, 1 ) ).toBe( 'Copy translations: 2 updated, 1 already had these values.' );
		expect( declarativeSummary( 'Copy translations', 0, 2 ) ).toBe( 'Copy translations: nothing changed, 2 items already had these values.' );
	} );

	it( 'runs a tool of several requests as a save: rows locked while it runs, the batch planned and closed, the inner run left to the editor', async () => {
		const ids = Array.from( { length: 150 }, ( _, index ) => index + 1 );
		let lockedDuring = false;

		vi.mocked( runAction ).mockImplementationOnce( async () => {
			lockedDuring = isRowPending( 1 ) && isRowPending( 150 );

			return response( ids.map( ( id ) => ( { id, ok: true, changed: 1 } ) ) );
		} );

		await runDeclarativeAction( 'i18n_copy', 'Copy translations', ids, {}, [ 'id' ] );

		expect( lockedDuring ).toBe( true );
		expect( isRowPending( 1 ) ).toBe( false );
		expect( vi.mocked( runAction ).mock.calls[ 0 ]?.[ 3 ] ).toMatchObject( { batchId: 'b1', planned: 150 } );
		expect( closeBatch ).toHaveBeenCalledWith( 'b1' );

		// Inside the editor's Update: its batch, its plan, its close and its job.
		vi.mocked( closeBatch ).mockClear();
		vi.mocked( runAction ).mockImplementationOnce( async () => {
			lockedDuring = isRowPending( 1 );

			return response( ids.map( ( id ) => ( { id, ok: true, changed: 1 } ) ) );
		} );
		await runDeclarativeAction( 'i18n_copy', 'Copy translations', ids, {}, [ 'id' ], { batchId: 'editor', planned: 400, silent: true } );
		expect( lockedDuring ).toBe( false );
		expect( vi.mocked( runAction ).mock.calls[ 1 ]?.[ 3 ] ).toMatchObject( { batchId: 'editor', planned: 400 } );
		expect( closeBatch ).not.toHaveBeenCalled();
	} );

	it( 'releases the rows and closes its batch when the run fails', async () => {
		vi.mocked( runAction ).mockRejectedValueOnce( new Error( 'offline' ) );

		await expect( runDeclarativeAction( 'i18n_copy', 'Copy translations', Array.from( { length: 120 }, ( _, index ) => index + 1 ), {}, [ 'id' ] ) ).rejects.toThrow( 'offline' );
		expect( isRowPending( 1 ) ).toBe( false );
		expect( closeBatch ).toHaveBeenCalledWith( 'b1' );
	} );
} );
