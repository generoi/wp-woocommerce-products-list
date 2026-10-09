/**
 * `window.wcProductsList.batchUpdate()` runs as the list's own bulk saves:
 * a save-activity job (bar, row locks, leave guard), expected values from
 * the loaded rows (and the extension's own), the planned header and close,
 * rows a save of this tab holds kept back, failed rows recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '../../resources/api/client';
import type { BatchUpdateDeps } from '../../resources/extensions/batch-update';
import { requestItem, runBatchUpdate } from '../../resources/extensions/batch-update';
import { expectedValues, setExpectProvider } from '../../resources/edit/expect';
import { failedSkips, unansweredResults } from '../../resources/edit/failed-rows';
import { beginSaveJob, finishSaveJob, isRowPending } from '../../resources/store/save-activity';
import { registerField, resetRegistry } from '../../resources/extensions/api';
import { simple, variation } from './edit-fixtures';

vi.mock( '../../resources/api/client', async ( importOriginal ) => {
	const actual = await importOriginal< typeof ClientModule >();

	return { ...actual, newBatchId: () => 'ext-1' };
} );

function deps( overrides: Partial< BatchUpdateDeps > = {} ): BatchUpdateDeps & { pendingDuring: boolean[] } {
	const pendingDuring: boolean[] = [];
	const echo = async ( update: Array< Record< string, unknown > > ) => {
		pendingDuring.push( isRowPending( 86980 ) || isRowPending( 1 ) );

		return { update: update.map( ( { _wcpl_expect: _e, parent_id: _p, ...row } ) => row ) };
	};

	return {
		pendingDuring,
		batchProducts: vi.fn( echo ) as never,
		batchVariationsAcross: vi.fn( echo ) as never,
		closeBatch: vi.fn( async () => undefined ),
		logSkipped: vi.fn( async () => undefined ),
		findRow: () => undefined,
		patchItems: vi.fn(),
		...overrides,
	};
}

afterEach( () => {
	resetRegistry();
} );

describe( 'runBatchUpdate', () => {
	it( 'sends the loaded value as _wcpl_expect, so a row changed meanwhile is refused (not overwritten), and reports it with its data', async () => {
		const conflict = { code: 'wc_products_list_conflict', message: 'Regular price was changed by someone else…', data: { status: 409, fields: [ 'regular_price' ], current: { regular_price: '77' }, expected: { regular_price: '12' } } };
		const d = deps( {
			findRow: ( id ) => ( id === 86980 ? variation( 86980, 86979, { regular_price: '12' } ) : undefined ),
			batchVariationsAcross: vi.fn( async ( update: Array< { id: number } > ) => ( { update: update.map( ( row ) => ( { id: row.id, error: conflict } ) ) } ) ) as never,
		} );

		const result = await runBatchUpdate( { variations: { 86979: [ { id: 86980, regular_price: '5' } ] } }, { source: 'extension' }, d );

		expect( vi.mocked( d.batchVariationsAcross ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [ { id: 86980, regular_price: '5', parent_id: 86979, _wcpl_expect: { regular_price: '12' } } ] );
		expect( vi.mocked( d.batchVariationsAcross ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { batchId: 'ext-1', source: 'extension' } );
		expect( result.updated ).toEqual( [] );
		expect( result.errors ).toEqual( [ { id: 86980, code: 'wc_products_list_conflict', message: conflict.message, data: conflict.data } ] );
		// The server logged the conflict itself: nothing is posted for it.
		expect( d.logSkipped ).not.toHaveBeenCalled();
	} );

	it( 'runs as a save job (rows locked while it runs), plans and closes a write of several rows', async () => {
		const d = deps();

		const result = await runBatchUpdate( { products: [ { id: 1, sku: 'A' }, { id: 2, sku: 'B' } ], variations: { 86979: [ { id: 86980, sku: 'C' } ] } }, {}, d );

		expect( d.pendingDuring ).toEqual( [ true, true ] );
		expect( isRowPending( 1 ) ).toBe( false );
		expect( vi.mocked( d.batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { batchId: 'ext-1', source: 'quick', planned: 3 } );
		expect( d.closeBatch ).toHaveBeenCalledWith( 'ext-1' );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 86980, 1, 2 ] );
		expect( d.patchItems ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'one row: no planned header, no close', async () => {
		const d = deps();

		await runBatchUpdate( { products: [ { id: 1, sku: 'A' } ] }, {}, d );

		expect( vi.mocked( d.batchProducts ).mock.calls[ 0 ]?.[ 1 ] ).not.toHaveProperty( 'planned' );
		expect( d.closeBatch ).not.toHaveBeenCalled();
	} );

	it( 'keeps back rows a save of this tab still holds, and records them as locked', async () => {
		const d = deps();
		const job = beginSaveJob( [ { id: 2, parent_id: 0 } ] );

		try {
			const result = await runBatchUpdate( { products: [ { id: 1, sku: 'A' }, { id: 2, sku: 'B' } ] }, { source: 'extension' }, d );

			expect( vi.mocked( d.batchProducts ).mock.calls[ 0 ]?.[ 0 ] ).toEqual( [ { id: 1, sku: 'A' } ] );
			expect( result.errors ).toEqual( [ expect.objectContaining( { id: 2, code: 'wc_products_list_locked' } ) ] );
			expect( d.logSkipped ).toHaveBeenCalledWith( 'ext-1', 'extension', [ expect.objectContaining( { id: 2, reason: 'locked' } ) ] );
		} finally {
			finishSaveJob( job );
		}
	} );

	it( 'records rows whose request got no answer as failed', async () => {
		const d = deps( {
			batchProducts: vi.fn( async () => {
				throw Object.assign( new Error( 'Could not get a valid response from the server.' ), { code: 'fetch_error' } );
			} ) as never,
		} );

		const result = await runBatchUpdate( { products: [ { id: 1, sku: 'A' } ] }, { source: 'extension' }, d );

		expect( result.errors ).toEqual( [ { id: 1, code: 'fetch_error', message: 'Could not get a valid response from the server.' } ] );
		expect( d.logSkipped ).toHaveBeenCalledWith( 'ext-1', 'extension', [ { id: 1, reason: 'failed', message: 'Could not get a valid response from the server.' } ] );
		expect( isRowPending( 1 ) ).toBe( false );
	} );
} );

describe( 'requestItem', () => {
	it( "puts the extension's own expected values over the loaded row's; `expect: false` sends only its own", () => {
		const loaded = simple( 5, { regular_price: '10', sku: 'OLD' } );

		expect( requestItem( { id: 5, regular_price: '9', sku: 'NEW', _wcpl_expect: { sku: 'MINE' } }, () => loaded, true ) ).toEqual( {
			id: 5,
			regular_price: '9',
			sku: 'NEW',
			_wcpl_expect: { regular_price: '10', sku: 'MINE' },
		} );
		expect( requestItem( { id: 5, regular_price: '9' }, () => loaded, false ) ).toEqual( { id: 5, regular_price: '9' } );
		expect( requestItem( { id: 5, regular_price: '9' }, () => undefined, true ) ).toEqual( { id: 5, regular_price: '9' } );
	} );
} );

describe( 'registered fields: rest.expect', () => {
	it( "adds the field's expected values to every write of it", () => {
		registerField( {
			id: 'demo_note',
			label: 'Note',
			type: 'text',
			rest: {
				write: ( value: unknown ) => ( { demo: { note: value } } ),
				expect: ( item: Record< string, unknown >, payload: Record< string, unknown > ) => ( 'demo' in payload ? { 'demo.note': item.demo_note ?? '' } : null ),
			},
		} as never );

		const row = simple( 5, { demo_note: 'before' } );

		expect( expectedValues( row, { demo: { note: 'after' } } ) ).toEqual( { 'demo.note': 'before' } );
		expect( expectedValues( row, { sku: 'X' } ) ).toEqual( { sku: row.sku } );

		resetRegistry();
		expect( expectedValues( row, { demo: { note: 'after' } } ) ).toBeNull();
	} );

	it( 'a provider that throws leaves the write without its check, not broken', () => {
		setExpectProvider( 'broken', () => {
			throw new Error( 'bug' );
		} );

		expect( expectedValues( simple( 5, { regular_price: '3' } ), { regular_price: '4' } ) ).toEqual( { regular_price: '3' } );
		setExpectProvider( 'broken' );
	} );
} );

describe( 'failed rows', () => {
	it( 'posts one row per failed id, as deleted when wc/v3 no longer finds it, never the ones the server logged', () => {
		expect(
			failedSkips(
				[
					{ id: 1, message: 'offline', code: 'fetch_error' },
					{ id: 1, message: 'again' },
					{ id: 2, message: 'gone', code: 'woocommerce_rest_product_invalid_id' },
					{ id: 3, message: 'clash', code: 'wc_products_list_conflict' },
					{ id: 4, message: 'busy', code: 'wc_products_list_locked' },
					{ id: 5, message: 'editing', code: 'wc_products_list_editing' },
					{ id: 0, message: 'request' },
				],
				[ 'status' ]
			)
		).toEqual( [
			{ id: 1, reason: 'failed', fields: [ 'status' ], message: 'offline' },
			{ id: 2, reason: 'deleted', fields: [ 'status' ], message: 'gone' },
		] );
	} );

	it( "of an action's results, takes only the ones whose request got no answer", () => {
		expect(
			unansweredResults( [
				{ id: 1, ok: true },
				{ id: 2, ok: false, code: 'not_found', message: 'Gone.' },
				{ id: 3, ok: false, code: 'fetch_error', message: 'Offline.', data: { wcpl_request_failed: true, status: 0 } },
			] )
		).toEqual( [ { id: 3, code: 'fetch_error', message: 'Offline.' } ] );
	} );
} );
