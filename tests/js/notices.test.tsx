import { describe, expect, it } from 'vitest';
import { stickyWhenActionable } from '../../resources/ui/notices';

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
