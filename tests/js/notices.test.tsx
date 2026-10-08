import { describe, expect, it } from 'vitest';
import { MAX_SNACKBARS, overflowingNotices, stickyWhenActionable } from '../../resources/ui/notices';

describe( 'stickyWhenActionable', () => {
	it( 'keeps a snackbar with an Undo until dismissed and leaves the rest to the timeout', () => {
		const undo = { id: 'a', content: '2 products moved to the Trash.', actions: [ { label: 'Undo' } ] };
		expect( stickyWhenActionable( undo ) ).toEqual( { ...undo, explicitDismiss: true } );

		const plain = { id: 'b', content: 'Saved.', actions: [] };
		expect( stickyWhenActionable( plain ) ).toBe( plain );

		// core/notices stores false by default; a notice with actions is sticky regardless.
		const stored = { ...undo, explicitDismiss: false };
		expect( stickyWhenActionable( stored ) ).toEqual( { ...undo, explicitDismiss: true } );
		const already = { ...undo, explicitDismiss: true };
		expect( stickyWhenActionable( already ) ).toBe( already );
	} );
} );

describe( 'overflowingNotices', () => {
	it( 'names the oldest snackbars beyond the cap, so sticky Undo bars do not pile up', () => {
		const notices = [ 'a', 'b', 'c', 'd', 'e' ].map( ( id ) => ( { id } ) );

		expect( overflowingNotices( notices, 3 ) ).toEqual( [ 'a', 'b' ] );
		expect( overflowingNotices( notices.slice( 0, 3 ), 3 ) ).toEqual( [] );
		expect( overflowingNotices( [], 3 ) ).toEqual( [] );
		expect( MAX_SNACKBARS ).toBeGreaterThanOrEqual( 2 );
	} );
} );
