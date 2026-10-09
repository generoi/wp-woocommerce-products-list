import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResponse } from '../../resources/api/client';
import { runAction } from '../../resources/api/client';
import { declarativeSummary, runDeclarativeAction } from '../../resources/actions/index';
import { notify } from '../../resources/actions/notices';
import { undoBatch } from '../../resources/edit/undo';
import { invalidateProducts, patchItems } from '../../resources/store/products';

vi.mock( '../../resources/api/client', () => ( { runAction: vi.fn() } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );
vi.mock( '../../resources/store/products', () => ( { patchItems: vi.fn(), invalidateProducts: vi.fn() } ) );
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

		expect( runAction ).toHaveBeenCalledWith( 'i18n_copy', [ 1, 2 ], { lang: 'se' }, { fields: [ 'id', 'name' ] } );
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

	it( 'reports the first failure, with the count of items that did update, and no success notice', async () => {
		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 1, ok: true, changed: 1 }, { id: 2, ok: false, code: 'not_found', message: 'The product no longer exists.' } ] ) );

		await runDeclarativeAction( 'i18n_clear', 'Clear translations', [ 1, 2 ], {}, [ 'id' ] );

		expect( notify.error ).toHaveBeenCalledWith( '1 updated, 1 failed: The product no longer exists.' );
		expect( notify.success ).not.toHaveBeenCalled();
		expect( invalidateProducts ).toHaveBeenCalledWith( { counts: true } );

		vi.mocked( runAction ).mockResolvedValueOnce( response( [ { id: 2, ok: false, code: 'forbidden', message: 'Not allowed.' } ] ) );
		await runDeclarativeAction( 'i18n_clear', 'Clear translations', [ 2 ], {}, [ 'id' ] );
		expect( notify.error ).toHaveBeenLastCalledWith( 'Not allowed.' );
	} );

	it( 'shows a request error and rejects so the modal stays open', async () => {
		vi.mocked( runAction ).mockRejectedValueOnce( new Error( 'Pick a translated language.' ) );

		await expect( runDeclarativeAction( 'i18n_copy', 'Copy translations', [ 1 ], {}, [ 'id' ] ) ).rejects.toThrow( 'Pick a translated language.' );
		expect( notify.error ).toHaveBeenCalledWith( 'Pick a translated language.' );
		expect( notify.success ).not.toHaveBeenCalled();
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
} );
