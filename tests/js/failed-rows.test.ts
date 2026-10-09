import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFailedRows, failureMessage, failureNoticeActions } from '../../resources/edit/failed-rows';
import { selectRows } from '../../resources/list/selection';
import { notify } from '../../resources/actions/notices';
import { setSettings } from '../../resources/settings';
import { editSettings } from './edit-fixtures';

vi.mock( '../../resources/list/selection', () => ( { selectRows: vi.fn() } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() } } ) );

const LOCKED = 'FE6Auditor is editing this product in the product editor. Nothing was saved for this item; try again when they are done.';

describe( 'failure notices name the rows', () => {
	afterEach( () => {
		setSettings( undefined );
		vi.clearAllMocks();
	} );

	it( 'names each failed row with why, grouped by reason, at most three, then "and N more"', () => {
		const names = new Map( [
			[ 1, 'FE6AUDIT A Wally' ],
			[ 2, 'FE6AUDIT B Wally' ],
		] );

		expect( describeFailedRows( [ { id: 1, message: LOCKED } ], names ) ).toBe( `FE6AUDIT A Wally: ${ LOCKED }` );
		// The result's own name wins; an unknown row is named by its id; a repeated id counts once.
		expect(
			describeFailedRows(
				[
					{ id: 1, message: 'Locked.' },
					{ id: 3, message: 'Locked.', name: 'Pelsi Black' },
					{ id: 4, message: 'Deleted meanwhile.' },
					{ id: 1, message: 'Locked.' },
				],
				names
			)
		).toBe( 'FE6AUDIT A Wally, Pelsi Black: Locked.; #4: Deleted meanwhile.' );

		const many = Array.from( { length: 7 }, ( _, index ) => ( { id: 10 + index, message: 'Locked.', name: `P${ index }` } ) );
		expect( describeFailedRows( many ) ).toBe( 'P0, P1, P2 and 4 more: Locked.' );

		const reasons = [ 'a', 'b', 'c', 'd', 'e' ].map( ( message, index ) => ( { id: index + 1, message, name: `R${ index }` } ) );
		expect( describeFailedRows( reasons ) ).toBe( 'R0: a; R1: b; R2: c and 2 more' );
	} );

	it( 'says what did not happen: updated, moved to the Trash, still in the Trash, duplicated', () => {
		const failed = [ { id: 1, message: LOCKED, name: 'FE6AUDIT A Wally' } ];

		expect( failureMessage( 'update', failed ) ).toBe( `1 item could not be updated: FE6AUDIT A Wally: ${ LOCKED }` );
		expect( failureMessage( 'trash', failed ) ).toBe( `1 product was not moved to the Trash: FE6AUDIT A Wally: ${ LOCKED }` );
		expect( failureMessage( 'restore', [ ...failed, { id: 2, message: LOCKED, name: 'B' } ] ) ).toBe( `2 products are still in the Trash: FE6AUDIT A Wally, B: ${ LOCKED }` );
		expect( failureMessage( 'duplicate', failed ) ).toMatch( /^1 product could not be duplicated: FE6AUDIT A Wally/ );
	} );

	it( '"Select the N failed" keeps the notice, and when the list shows none of the rows it leaves the selection alone and says so', () => {
		setSettings( editSettings( { links: { ...editSettings().links, history: '/wp-admin/admin.php?page=h' } } ) );
		const actions = failureNoticeActions( 'b1', [ { id: 1, message: 'x' }, { id: 2, message: 'gone', code: 'wc_products_list_deleted' } ] );

		expect( actions.map( ( action ) => action.label ) ).toEqual( [ 'Select the 1 failed', 'View in History' ] );
		expect( actions[ 0 ]?.keepsNotice ).toBe( true );

		vi.mocked( selectRows ).mockReturnValueOnce( true );
		actions[ 0 ]?.onClick?.();
		expect( selectRows ).toHaveBeenCalledWith( [ 1 ] );
		expect( notify.info ).not.toHaveBeenCalled();

		vi.mocked( selectRows ).mockReturnValueOnce( false );
		actions[ 0 ]?.onClick?.();
		expect( notify.info ).toHaveBeenCalledWith( expect.stringContaining( 'not in the list you are viewing' ) );
	} );

	it( 'rows left in the Trash (a refused Undo of Move to Trash): "Open the Trash" in place of Select', () => {
		setSettings( editSettings( { links: { ...editSettings().links, page: '/wp-admin/edit.php?post_type=product&page=wc-products-list', history: '/wp-admin/admin.php?page=h' } } ) );
		const actions = failureNoticeActions( 'b2', [ { id: 1, message: LOCKED } ], { inTrash: true } );

		expect( actions.map( ( action ) => action.label ) ).toEqual( [ 'Open the Trash', 'View in History' ] );
		expect( actions[ 0 ]?.url ).toContain( 'tab=trash' );
	} );
} );
