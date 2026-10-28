/**
 * Leaving the page with a change typed into the table and not saved yet
 * asks first (a change saves when the row is left, which closing the tab
 * is not).
 */
import { useEffect } from '@wordpress/element';
import { draftCount } from './drafts';

export function useDraftsLeaveGuard(): void {
	useEffect( () => {
		const onBeforeUnload = ( event: BeforeUnloadEvent ) => {
			if ( draftCount() > 0 ) {
				event.preventDefault();
				// Older browsers need a return value to ask.
				event.returnValue = '';
			}
		};

		window.addEventListener( 'beforeunload', onBeforeUnload );

		return () => window.removeEventListener( 'beforeunload', onBeforeUnload );
	}, [] );
}
