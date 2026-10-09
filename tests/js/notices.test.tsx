import { act, fireEvent, render } from '@testing-library/react';
import { dispatch, select } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TIMEOUT, createDismissTimers, MAX_SNACKBARS, Notices, NOTICES_HEIGHT_VAR, outcomeNoticeId, overflowingNotices, PLAIN_TIMEOUT, snackbarTimeout } from '../../resources/ui/notices';
/** edit/inline-editor.tsx SAVED_NOTICE_ID (not imported: the editor module is heavy). */
const SAVED_NOTICE_ID = 'wc-pl-saved';

describe( 'snackbarTimeout', () => {
	it( 'hides an Undo snackbar after 10 s and a plain one after 6 s; errors and explicit ones stay', () => {
		expect( snackbarTimeout( { id: 'a', status: 'success', actions: [ { label: 'Undo' } ] } ) ).toBe( ACTION_TIMEOUT );
		expect( ACTION_TIMEOUT ).toBeGreaterThanOrEqual( 8000 );
		expect( snackbarTimeout( { id: 'b', status: 'success', actions: [] } ) ).toBe( PLAIN_TIMEOUT );
		// core/notices stores explicitDismiss: false by default; that is not an opt-in to stay.
		expect( snackbarTimeout( { id: 'c', status: 'info', explicitDismiss: false } ) ).toBe( PLAIN_TIMEOUT );
		expect( snackbarTimeout( { id: 'd', status: 'success', explicitDismiss: true } ) ).toBeNull();
		expect( snackbarTimeout( { id: 'e', status: 'error', actions: [] } ) ).toBeNull();
		// Move to Trash: its Undo stays until dismissed (History cannot restore a trashed batch).
		expect( snackbarTimeout( { id: 'wc-pl-trash-batch-1', status: 'success', actions: [ { label: 'Undo' } ] } ) ).toBeNull();
		expect( snackbarTimeout( { id: 'wc-pl-trash-batch-1', status: 'success', actions: [] } ) ).toBe( PLAIN_TIMEOUT );
	} );
} );

describe( 'overflowingNotices', () => {
	it( 'names the oldest snackbars beyond the cap', () => {
		const notices = [ 'a', 'b', 'c', 'd', 'e' ].map( ( id ) => ( { id } ) );

		expect( overflowingNotices( notices, 3 ) ).toEqual( [ 'a', 'b' ] );
		expect( overflowingNotices( notices.slice( 0, 3 ), 3 ) ).toEqual( [] );
		expect( overflowingNotices( [], 3 ) ).toEqual( [] );
		expect( MAX_SNACKBARS ).toBeGreaterThanOrEqual( 2 );
	} );

	it( 'keeps only the latest Undo: an older success snackbar with an action is superseded', () => {
		const undo = { label: 'Undo' };
		const notices = [
			{ id: 'campaign', status: 'success', actions: [ undo ] },
			{ id: 'retry', status: 'error', actions: [ { label: 'Retry' } ] },
			{ id: 'plain', status: 'info', actions: [] },
			{ id: 'restock', status: 'success', actions: [ undo ] },
		];

		expect( overflowingNotices( notices, 3 ) ).toEqual( [ 'campaign' ] );
		expect( overflowingNotices( notices.slice( 0, 3 ), 3 ) ).toEqual( [] );
	} );

	it( 'never drops an error or a notice asked to stay, and does not count them toward the cap', () => {
		const notices = [
			{ id: 'error', status: 'error' },
			{ id: 'reverting', status: 'info', explicitDismiss: true },
			{ id: 'a', status: 'info' },
			{ id: 'b', status: 'info' },
			{ id: 'c', status: 'info' },
			{ id: 'd', status: 'info' },
		];

		expect( overflowingNotices( notices, 3 ) ).toEqual( [ 'a' ] );
	} );

	it( 'gives each background save outcome its own id, apart from the shared success id', () => {
		const first = outcomeNoticeId( 'batch-1' );

		expect( first ).not.toBe( SAVED_NOTICE_ID );
		expect( outcomeNoticeId( 'batch-2' ) ).not.toBe( first );
		expect( outcomeNoticeId( '' ) ).not.toBe( outcomeNoticeId( '' ) );
	} );
} );

describe( 'a background save failure notice', () => {
	afterEach( () => {
		select( noticesStore )
			.getNotices()
			.forEach( ( notice ) => void dispatch( noticesStore ).removeNotice( notice.id ) );
	} );

	it( 'survives a later save\'s success (with Undo) and 3 further info notices', async () => {
		const undo = { label: 'Undo', onClick: () => {} };
		const failureId = outcomeNoticeId( 'batch-bg' );

		render( <Notices /> );

		await act( async () => {
			void dispatch( noticesStore ).createErrorNotice( '1889 updated, 195 failed.', {
				id: failureId,
				type: 'snackbar',
				explicitDismiss: true,
				actions: [ undo, { label: 'Select the 197 failed', onClick: () => {} } ],
			} );
		} );
		await act( async () => {
			void dispatch( noticesStore ).createSuccessNotice( '1 item updated.', { id: SAVED_NOTICE_ID, type: 'snackbar', actions: [ undo ] } );
		} );
		await act( async () => {
			for ( const id of [ 'i1', 'i2', 'i3' ] ) {
				void dispatch( noticesStore ).createInfoNotice( id, { id, type: 'snackbar' } );
			}
		} );

		const ids = select( noticesStore )
			.getNotices()
			.map( ( notice ) => notice.id );

		expect( ids ).toContain( failureId );
		expect( ids ).not.toContain( SAVED_NOTICE_ID );
		expect( ids ).toEqual( expect.arrayContaining( [ 'i1', 'i2', 'i3' ] ) );
	} );

	it( 'is not replaced or superseded when held rows are reported by another background save', async () => {
		const undo = { label: 'Undo', onClick: () => {} };
		const failureId = outcomeNoticeId( 'batch-1' );
		const heldId = outcomeNoticeId( 'batch-2' );

		render( <Notices /> );

		await act( async () => {
			void dispatch( noticesStore ).createErrorNotice( 'failed', { id: failureId, type: 'snackbar', explicitDismiss: true, actions: [ undo ] } );
			void dispatch( noticesStore ).createInfoNotice( 'held', { id: heldId, type: 'snackbar', explicitDismiss: true, actions: [ undo ] } );
			void dispatch( noticesStore ).createSuccessNotice( 'saved', { id: SAVED_NOTICE_ID, type: 'snackbar', actions: [ undo ] } );
		} );

		const ids = select( noticesStore )
			.getNotices()
			.map( ( notice ) => notice.id );

		expect( ids ).toEqual( expect.arrayContaining( [ failureId, heldId, SAVED_NOTICE_ID ] ) );
	} );
} );

describe( 'createDismissTimers', () => {
	afterEach( () => {
		vi.useRealTimers();
	} );

	it( 'expires each notice after its timeout, pauses with the time left and skips sticky ones', () => {
		vi.useFakeTimers();
		const expired: string[] = [];
		const timers = createDismissTimers( ( id ) => expired.push( id ) );

		timers.sync( [
			{ id: 'undo', timeout: 10000 },
			{ id: 'plain', timeout: 6000 },
			{ id: 'error', timeout: null },
		] );

		vi.advanceTimersByTime( 4000 );
		timers.pause();
		vi.advanceTimersByTime( 60000 );
		expect( expired ).toEqual( [] );

		timers.resume();
		vi.advanceTimersByTime( 2000 );
		expect( expired ).toEqual( [ 'plain' ] );

		// A re-sync of a running notice does not restart its timer.
		timers.sync( [ { id: 'undo', timeout: 10000 }, { id: 'error', timeout: null } ] );
		vi.advanceTimersByTime( 4000 );
		expect( expired ).toEqual( [ 'plain', 'undo' ] );

		vi.advanceTimersByTime( 600000 );
		expect( expired ).toEqual( [ 'plain', 'undo' ] );
		timers.dispose();
	} );

	it( 'forgets a notice removed before it expired', () => {
		vi.useFakeTimers();
		const expired: string[] = [];
		const timers = createDismissTimers( ( id ) => expired.push( id ) );

		timers.sync( [ { id: 'a', timeout: 1000 } ] );
		timers.sync( [] );
		vi.advanceTimersByTime( 5000 );
		expect( expired ).toEqual( [] );
	} );
} );

describe( '<Notices />', () => {
	afterEach( () => {
		vi.useRealTimers();
		select( noticesStore )
			.getNotices()
			.forEach( ( notice ) => void dispatch( noticesStore ).removeNotice( notice.id ) );
	} );

	it( 'hides an Undo snackbar after the timeout unless hovered, and replaces an older Undo', async () => {
		vi.useFakeTimers();
		const view = render( <Notices /> );

		act( () => {
			void dispatch( noticesStore ).createSuccessNotice( '348 items updated.', { id: 'first', type: 'snackbar', actions: [ { label: 'Undo', onClick: () => undefined } ] } );
		} );
		expect( view.container.textContent ).toContain( '348 items updated.' );
		expect( document.documentElement.style.getPropertyValue( NOTICES_HEIGHT_VAR ) ).toMatch( /px$/ );

		act( () => {
			void dispatch( noticesStore ).createSuccessNotice( '73 items updated.', { id: 'second', type: 'snackbar', actions: [ { label: 'Undo', onClick: () => undefined } ] } );
		} );
		expect( select( noticesStore ).getNotices().map( ( notice ) => notice.id ) ).toEqual( [ 'second' ] );

		const stack = view.container.querySelector( '.wc-products-list__notices' ) as HTMLElement;
		fireEvent.mouseEnter( stack );
		act( () => {
			vi.advanceTimersByTime( ACTION_TIMEOUT * 3 );
		} );
		expect( select( noticesStore ).getNotices() ).toHaveLength( 1 );

		fireEvent.mouseLeave( stack );
		act( () => {
			vi.advanceTimersByTime( ACTION_TIMEOUT );
		} );
		expect( select( noticesStore ).getNotices() ).toHaveLength( 0 );
		expect( view.container.querySelector( '.wc-products-list__notices' ) ).toBeNull();
		expect( document.documentElement.style.getPropertyValue( NOTICES_HEIGHT_VAR ) ).toBe( '' );
	} );
} );

describe( 'withExtraActions', () => {
	it( 'keeps the first action on the snackbar and renders the rest as links in the content', async () => {
		const { withExtraActions } = await import( '../../resources/ui/notices' );
		const { render, screen } = await import( '@testing-library/react' );
		const undo = vi.fn();
		const notice = withExtraActions( { id: 'n', content: '5 items updated.', actions: [ { label: 'Undo', onClick: undo }, { label: 'View in History', url: 'https://example.test/history?batch=b' } ] } );

		expect( notice.actions ).toHaveLength( 1 );
		render( <div>{ notice.content as never }</div> );
		expect( screen.getByText( 'View in History' ).closest( 'a' ) ).toHaveAttribute( 'href', 'https://example.test/history?batch=b' );
		expect( withExtraActions( { id: 'm', content: 'x', actions: [ { label: 'Undo' } ] } ).content ).toBe( 'x' );
	} );

	it( 'renders an action that keeps the notice as a link in the content, so clicking it does not remove the notice', async () => {
		const { withExtraActions } = await import( '../../resources/ui/notices' );
		const { fireEvent, render, screen } = await import( '@testing-library/react' );
		const select = vi.fn();
		const notice = withExtraActions( {
			id: 'f',
			content: '1 item could not be updated: Pelsi Black: Locked.',
			actions: [
				{ label: 'Select the 1 failed', onClick: select, keepsNotice: true },
				{ label: 'View in History', url: 'https://example.test/history?batch=b' },
			],
		} );

		// The core action (which removes the notice on click) is History; Select is in the content.
		expect( notice.actions ).toEqual( [ expect.objectContaining( { label: 'View in History' } ) ] );
		render( <div>{ notice.content as never }</div> );
		fireEvent.click( screen.getByText( 'Select the 1 failed' ) );
		expect( select ).toHaveBeenCalled();

		// Alone, it still goes into the content: no core action to remove the notice.
		const alone = withExtraActions( { id: 'g', content: 'x', actions: [ { label: 'Select the 1 failed', onClick: select, keepsNotice: true } ] } );
		expect( alone.actions ).toEqual( [] );
	} );
} );
