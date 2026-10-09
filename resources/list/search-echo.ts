/**
 * DataViews' search box keeps its own text and only takes `view.search`
 * when that changes. When the screen refuses a search (the open editor's
 * discard guard said "Keep editing"), `view.search` stays where it was, so
 * the box would go on showing a query the list never applied.
 *
 * `useSearchEcho` puts the box back: `reject( next )` renders the view once
 * with the refused search (what the box already shows, so nothing changes)
 * and then with the applied one, which DataViews sees as a change and
 * copies into the box. The echo render never reaches the list query: only
 * `shownView` carries it, and only for one commit.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import type { View } from '../dataviews';

export interface SearchEcho {
	/** The view to hand DataViews: `view`, or for one render the refused search on top of it. */
	shownView: View;
	/** The screen did not apply `next`: put the search box back to `view.search` if `next` changed it. */
	reject( next: View ): void;
}

export function useSearchEcho( view: View ): SearchEcho {
	const [ echo, setEcho ] = useState< string | null >( null );

	useEffect( () => {
		if ( echo !== null ) {
			setEcho( null );
		}
	}, [ echo ] );

	const applied = view.search ?? '';
	// Read when the guard answers, which may be long after the search was typed.
	const appliedRef = useRef( applied );
	useLayoutEffect( () => {
		appliedRef.current = applied;
	} );
	const reject = useCallback( ( next: View ) => {
		const refused = next.search ?? '';

		if ( refused !== appliedRef.current ) {
			setEcho( refused );
		}
	}, [] );

	const shownView = useMemo( () => ( echo !== null && echo !== applied ? ( { ...view, search: echo } as View ) : view ), [ view, echo, applied ] );

	return { shownView, reject };
}
