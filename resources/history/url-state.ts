/**
 * History's filters in the page URL, so a filtered view is a link that can
 * be handed on ("the German SEO titles changed on #40771 last week"): the
 * changes view's filters, its search and the mode, kept in the query string
 * with `history.replaceState` (no reload, no new history entry per click).
 */
import { addQueryArgs, getQueryArg, removeQueryArgs } from '@wordpress/url';
import type { Filter } from '../dataviews';

/** Filter field → [URL parameter, operator]. */
const PARAMS: Array< [ string, string, string ] > = [
	[ 'object_id', 'object_id', 'is' ],
	[ 'batch_id', 'batch', 'is' ],
	[ 'source', 'source', 'is' ],
	[ 'action', 'log_action', 'is' ],
	[ 'field', 'field', 'is' ],
	[ 'user', 'user', 'is' ],
	[ 'created_at', 'since', 'after' ],
	[ 'created_at', 'until', 'before' ],
];

const ALL = [ ...PARAMS.map( ( [ , param ] ) => param ), 's', 'view' ];

/** The filters and search a URL names. */
export function filtersFromUrl( href: string ): { filters: Filter[]; search: string } {
	const filters: Filter[] = [];

	for ( const [ field, param, operator ] of PARAMS ) {
		const raw = getQueryArg( href, param );

		if ( typeof raw !== 'string' || raw === '' ) {
			continue;
		}

		if ( field === 'object_id' || field === 'user' ) {
			const id = Number( raw );

			if ( Number.isInteger( id ) && id > 0 ) {
				filters.push( { field, operator, value: id } as Filter );
			}

			continue;
		}

		filters.push( { field, operator, value: raw } as Filter );
	}

	const search = getQueryArg( href, 's' );

	return { filters, search: typeof search === 'string' ? search : '' };
}

/** `href` with the view's filters and search in its query (the others removed). */
export function urlWithFilters( href: string, view: { filters?: Filter[]; search?: string }, mode: 'batches' | 'changes' ): string {
	const args: Record< string, string > = {};

	if ( mode === 'changes' ) {
		args.view = 'changes';

		for ( const filter of view.filters ?? [] ) {
			const value = Array.isArray( filter.value ) ? filter.value[ 0 ] : filter.value;
			const entry = PARAMS.find( ( [ field, , operator ] ) => field === filter.field && ( field !== 'created_at' || operator === filter.operator ) );

			if ( entry && value !== undefined && value !== null && value !== '' ) {
				args[ entry[ 1 ] ] = String( value );
			}
		}

		if ( view.search && view.search.trim() !== '' ) {
			args.s = view.search.trim();
		}
	}

	return addQueryArgs( removeQueryArgs( href, ...ALL ), args );
}

/** Put the view in the address bar without a reload. */
export function syncUrl( view: { filters?: Filter[]; search?: string }, mode: 'batches' | 'changes' ): void {
	if ( typeof window === 'undefined' || ! window.history?.replaceState ) {
		return;
	}

	const next = urlWithFilters( window.location.href, view, mode );

	if ( next !== window.location.href ) {
		try {
			window.history.replaceState( window.history.state, '', next );
		} catch {
			// A sandboxed frame may refuse; the view still works.
		}
	}
}
