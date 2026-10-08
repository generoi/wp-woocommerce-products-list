import { act, fireEvent, render } from '@testing-library/react';
import { dispatch, select } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TIMEOUT, createDismissTimers, MAX_SNACKBARS, Notices, NOTICES_HEIGHT_VAR, overflowingNotices, PLAIN_TIMEOUT, snackbarTimeout } from '../../resources/ui/notices';

describe( 'snackbarTimeout', () => {
	it( 'hides an Undo snackbar after 10 s and a plain one after 6 s; errors and explicit ones stay', () => {
		expect( snackbarTimeout( { id: 'a', status: 'success', actions: [ { label: 'Undo' } ] } ) ).toBe( ACTION_TIMEOUT );
		expect( ACTION_TIMEOUT ).toBeGreaterThanOrEqual( 8000 );
		expect( snackbarTimeout( { id: 'b', status: 'success', actions: [] } ) ).toBe( PLAIN_TIMEOUT );
		// core/notices stores explicitDismiss: false by default; that is not an opt-in to stay.
		expect( snackbarTimeout( { id: 'c', status: 'info', explicitDismiss: false } ) ).toBe( PLAIN_TIMEOUT );
		expect( snackbarTimeout( { id: 'd', status: 'success', explicitDismiss: true } ) ).toBeNull();
		expect( snackbarTimeout( { id: 'e', status: 'error', actions: [] } ) ).toBeNull();
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
} );
