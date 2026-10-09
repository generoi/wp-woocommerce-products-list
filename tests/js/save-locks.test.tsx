/**
 * Locked rows (a save in flight in this tab): actions leave them alone, the
 * keyboard cannot reach their controls, the progress bar speaks only at
 * milestones, and failed rows reach the batch's History.
 */
import { render, screen } from '@testing-library/react';
import apiFetch from '@wordpress/api-fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductAction, ProductListItem } from '../../resources/types';
import { simple, variation } from './edit-fixtures';

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };

vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '@wordpress/api-fetch', () => {
	const fn = vi.fn();
	( fn as unknown as { use: unknown } ).use = vi.fn();

	return { default: fn };
} );

const fetchMock = apiFetch as unknown as ReturnType< typeof vi.fn >;
const { withScope, READ_ONLY_ACTIONS } = await import( '../../resources/actions/context' );
const { finishSaveJob, startSaveJob } = await import( '../../resources/store/save-activity' );
const { lockRowControls } = await import( '../../resources/hierarchy/row-lock' );
const { saveAnnouncement } = await import( '../../resources/list/save-activity-bar' );
const { logSkipped } = await import( '../../resources/api/client' );

afterEach( () => {
	vi.clearAllMocks();
	fetchMock.mockReset();
} );

describe( 'actions on locked rows', () => {
	const free = simple( 1 );
	const locked = simple( 2 );
	const lockedChild = variation( 31, 30 );

	it( 'hides mutating actions on a locked row (or a variation of a locked parent); read-only ones stay', () => {
		const job = startSaveJob( [ 2, 30 ] );
		const feature = withScope( { id: 'feature', label: 'Mark as featured', supportsBulk: true, callback: vi.fn() } as ProductAction );
		const view = withScope( { id: 'view', label: 'View', callback: vi.fn() } as ProductAction );

		expect( feature.isEligible?.( free ) ).toBe( true );
		expect( feature.isEligible?.( locked ) ).toBe( false );
		expect( feature.isEligible?.( lockedChild ) ).toBe( false );
		expect( READ_ONLY_ACTIONS.has( 'history' ) ).toBe( true );
		expect( view.isEligible?.( locked ) ).toBe( true );

		finishSaveJob( job );
		expect( feature.isEligible?.( locked ) ).toBe( true );
	} );

	it( 'a bulk callback leaves locked rows out with a notice, and does not run when every row is locked', () => {
		const job = startSaveJob( [ 2 ] );
		const callback = vi.fn();
		const trash = withScope( { id: 'trash', label: 'Move to Trash', supportsBulk: true, callback } as ProductAction ) as ProductAction & { callback: ( items: ProductListItem[], context: unknown ) => void };

		trash.callback( [ free, locked ], {} );
		expect( callback ).toHaveBeenCalledWith( [ free ], {} );
		expect( notify.info ).toHaveBeenCalledWith( 'Some selected rows are still being updated; they were left out.' );

		callback.mockClear();
		trash.callback( [ locked ], {} );
		expect( callback ).not.toHaveBeenCalled();
		expect( notify.info ).toHaveBeenLastCalledWith( 'These rows are still being updated. Try again once the update is done.' );
		finishSaveJob( job );
	} );

	it( 'a modal action gets only the free rows, and closes at once when none is left', () => {
		const job = startSaveJob( [ 2 ] );
		const Inner = ( { items }: { items: ProductListItem[] } ) => <p>{ items.map( ( item ) => item.id ).join( ',' ) }</p>;
		const action = withScope( { id: 'delete', label: 'Delete', supportsBulk: true, RenderModal: Inner } as ProductAction ) as ProductAction & { RenderModal: ( props: { items: ProductListItem[]; closeModal?: () => void } ) => JSX.Element };

		render( <action.RenderModal items={ [ free, locked ] } closeModal={ vi.fn() } /> );
		expect( screen.getByText( '1' ) ).toBeInTheDocument();

		const closeModal = vi.fn();

		render( <action.RenderModal items={ [ locked ] } closeModal={ closeModal } /> );
		expect( closeModal ).toHaveBeenCalled();
		finishSaveJob( job );
	} );
} );

describe( 'row lock for the keyboard', () => {
	it( 'takes the row\'s controls out of the tab order and restores them', () => {
		document.body.innerHTML = '<table><tbody><tr><td><input type="checkbox" id="cb"></td><td><span id="mark"><a href="#" id="inside">x</a></span><a href="/p" id="link">Name</a></td><td><button id="actions" type="button">Actions</button><button id="off" type="button" disabled>Off</button></td></tr></tbody></table>';

		const row = document.querySelector( 'tr' )!;
		const unlock = lockRowControls( row, document.getElementById( 'mark' ) );
		const checkbox = document.getElementById( 'cb' ) as HTMLInputElement;
		const actions = document.getElementById( 'actions' ) as HTMLButtonElement;

		expect( row ).toHaveAttribute( 'aria-busy', 'true' );
		expect( row ).toHaveAttribute( 'aria-disabled', 'true' );
		expect( checkbox.disabled ).toBe( true );
		expect( checkbox.tabIndex ).toBe( -1 );
		expect( actions.disabled ).toBe( true );
		expect( document.getElementById( 'link' )!.tabIndex ).toBe( -1 );
		expect( document.getElementById( 'inside' ) ).not.toHaveAttribute( 'tabindex' );

		unlock();
		expect( row ).not.toHaveAttribute( 'aria-busy' );
		expect( row ).not.toHaveAttribute( 'aria-disabled' );
		expect( checkbox.disabled ).toBe( false );
		expect( checkbox ).not.toHaveAttribute( 'tabindex' );
		expect( actions.disabled ).toBe( false );
		expect( ( document.getElementById( 'off' ) as HTMLButtonElement ).disabled ).toBe( true );
	} );
} );

describe( 'progress announcements', () => {
	it( 'change only at the start and at each quarter', () => {
		const said = new Set< string >();

		for ( let done = 0; done <= 1000; done += 7 ) {
			said.add( saveAnnouncement( done, 1000 ) );
		}
		said.add( saveAnnouncement( 1000, 1000 ) );

		expect( saveAnnouncement( 0, 0 ) ).toBe( 'Preparing the update…' );
		expect( Array.from( said ) ).toEqual( [ `Updating ${ ( 1000 ).toLocaleString() } rows.`, 'Update 25 % done.', 'Update 50 % done.', 'Update 75 % done.', 'All rows written; finishing the update…' ] );
	} );

	it( 'say "Reverting" while every job in flight is a revert (Undo, History)', () => {
		expect( saveAnnouncement( 0, 0, true ) ).toBe( 'Preparing the revert…' );
		expect( saveAnnouncement( 0, 40, true ) ).toBe( 'Reverting 40 rows.' );
		expect( saveAnnouncement( 20, 40, true ) ).toBe( 'Revert 50 % done.' );
		expect( saveAnnouncement( 40, 40, true ) ).toBe( 'All rows put back; finishing the revert…' );
	} );

	it( 'the activity is a revert only while no save runs next to it', async () => {
		const activity = await import( '../../resources/store/save-activity' );
		const { renderHook } = await import( '@testing-library/react' );
		const revert = activity.beginSaveJob( [ { id: 501, parent_id: 0 } ], 'revert' );
		const { result, rerender } = renderHook( () => activity.useSaveActivity() );

		expect( result.current?.reverting ).toBe( true );

		const save = activity.beginSaveJob( [ { id: 502, parent_id: 0 } ] );

		rerender();
		expect( result.current?.reverting ).toBe( false );
		expect( activity.pendingAmong( [ 500, 501, 502 ] ) ).toEqual( [ 501, 502 ] );
		activity.finishSaveJob( save );
		activity.finishSaveJob( revert );
	} );
} );

describe( 'logSkipped with failed rows', () => {
	it( 'sends `failed` with the error, and falls back to `other` when the server does not know the reason yet', async () => {
		fetchMock.mockRejectedValueOnce( { code: 'rest_invalid_param', message: 'Invalid parameter(s): items', data: { status: 400 } } ).mockResolvedValueOnce( {} );

		await logSkipped( '00000000-0000-4000-8000-000000000000', 'bulk', [
			{ id: 6, reason: 'failed', fields: [ 'featured' ], message: 'You are probably offline.' },
			{ id: 8, reason: 'trashed' },
		] );

		const sent = fetchMock.mock.calls.map( ( [ options ] ) => ( options as { data: { items: Array< { id: number; reason: string; message?: string } > } } ).data.items );

		expect( sent[ 0 ]?.[ 0 ] ).toEqual( { id: 6, reason: 'failed', fields: [ 'featured' ], message: 'You are probably offline.' } );
		expect( sent[ 1 ]?.[ 0 ] ).toEqual( { id: 6, reason: 'other', fields: [ 'featured' ], message: 'Not saved: You are probably offline.' } );
		expect( sent[ 1 ]?.[ 1 ] ).toEqual( { id: 8, reason: 'trashed' } );
	} );
} );
