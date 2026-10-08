/**
 * The view lives in two places: layout, columns, sort and page size in the
 * user's preferences (core `wp-preferences`, user meta, survives reloads and
 * devices); page, search, filters and the status tab in the URL (a link
 * shares exactly what is on screen, back/forward work).
 */
import { useDispatch, useSelect } from '@wordpress/data';
import { useCallback, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { store as preferencesStore } from '@wordpress/preferences';
import { addQueryArgs, getQueryArgs, removeQueryArgs } from '@wordpress/url';
import type { Filter, View } from '../dataviews';
import { createDefaultView, isStatusTab, PER_PAGE_SIZES } from '../list/default-view';
import type { StatusTabId } from '../list/default-view';
import type { ProductField, Settings } from '../types';

export const PREFERENCES_SCOPE = 'wc-products-list';
export const PREFERENCE_VIEW = 'view';

const URL_PAGE = 'paged';
const URL_SEARCH = 's';
const URL_TAB = 'tab';
const URL_FILTERS = 'filters';

interface Transient {
	page: number;
	search: string;
	filters: Filter[];
	tab: StatusTabId;
}

/** Everything but the keys that go to the URL (page, search, filters). */
export type PersistedView = Omit< View, 'page' | 'search' | 'filters' >;

export function splitView( view: View ): { persisted: PersistedView; transient: Omit< Transient, 'tab' > } {
	const { page, search, filters, ...persisted } = view;

	return { persisted: persisted as PersistedView, transient: { page: page ?? 1, search: search ?? '', filters: filters ?? [] } };
}

function parseFilters( raw: unknown ): Filter[] {
	if ( typeof raw !== 'string' || ! raw ) {
		return [];
	}

	try {
		const parsed = JSON.parse( raw ) as unknown;

		return Array.isArray( parsed ) ? parsed.filter( ( f ): f is Filter => typeof f === 'object' && f !== null && typeof ( f as Filter ).field === 'string' ) : [];
	} catch {
		return [];
	}
}

export function readUrlState( href: string = window.location.href ): Transient {
	const args = getQueryArgs( href );
	const page = Number( args[ URL_PAGE ] );

	return {
		page: Number.isInteger( page ) && page > 0 ? page : 1,
		search: typeof args[ URL_SEARCH ] === 'string' ? args[ URL_SEARCH ] : '',
		filters: parseFilters( args[ URL_FILTERS ] ),
		tab: isStatusTab( args[ URL_TAB ] ) ? args[ URL_TAB ] : 'all',
	};
}

export function urlForState( state: Transient, href: string = window.location.href ): string {
	const base = removeQueryArgs( href, URL_PAGE, URL_SEARCH, URL_TAB, URL_FILTERS );
	const args: Record< string, string > = {};

	if ( state.page > 1 ) {
		args[ URL_PAGE ] = String( state.page );
	}

	if ( state.search ) {
		args[ URL_SEARCH ] = state.search;
	}

	if ( state.tab !== 'all' ) {
		args[ URL_TAB ] = state.tab;
	}

	if ( state.filters.length ) {
		args[ URL_FILTERS ] = JSON.stringify( state.filters );
	}

	return addQueryArgs( base, args );
}

function writeUrl( state: Transient ): void {
	const next = urlForState( state );

	if ( next !== window.location.href ) {
		window.history.replaceState( window.history.state, '', next );
	}
}

/** Keep only what the current fields and layouts can show. */
export function sanitizePersisted( persisted: Partial< PersistedView > | undefined, defaults: View, fields: ProductField[] ): PersistedView {
	const { persisted: base } = splitView( defaults );

	if ( ! persisted || typeof persisted !== 'object' ) {
		return base;
	}

	const ids = new Set( fields.map( ( f ) => f.id ) );
	const type = persisted.type && [ 'table', 'grid', 'list' ].includes( persisted.type ) ? persisted.type : base.type;
	const perPage = PER_PAGE_SIZES.includes( persisted.perPage ?? 0 ) ? persisted.perPage : base.perPage;
	const viewFields = Array.isArray( persisted.fields ) ? persisted.fields.filter( ( id ) => ids.has( id ) ) : base.fields;
	const sort = persisted.sort && ids.has( persisted.sort.field ) ? persisted.sort : base.sort;
	const layout = type === 'table' ? mergeTableLayout( base.layout, persisted.layout ) : persisted.layout ?? base.layout;

	return { ...base, ...persisted, type, perPage, fields: viewFields, sort, layout } as PersistedView;
}

type TableLayout = { styles?: Record< string, unknown > } & Record< string, unknown >;

/**
 * A saved table layout keeps its column widths, and gets the default width
 * of every column it has none for: a column added since the view was saved
 * (a new translation column) must not open at DataViews' fallback width.
 */
export function mergeTableLayout( defaults: unknown, saved: unknown ): TableLayout | undefined {
	const base = ( defaults ?? {} ) as TableLayout;
	const stored = ( saved ?? {} ) as TableLayout;
	const styles = { ...( base.styles ?? {} ), ...( stored.styles ?? {} ) };

	return { ...base, ...stored, styles };
}

function same( a: unknown, b: unknown ): boolean {
	return JSON.stringify( a ) === JSON.stringify( b );
}

export interface ViewState {
	view: View;
	setView: ( view: View ) => void;
	tab: StatusTabId;
	setTab: ( tab: StatusTabId ) => void;
	/** True when the persisted part differs from the default (shows the reset button). */
	isModified: boolean;
	resetView: () => void;
	defaultView: View;
}

export function useView( fields: ProductField[], settings: Settings ): ViewState {
	const defaultView = useMemo( () => createDefaultView( settings, fields ), [ settings, fields ] );
	const stored = useSelect( ( select ) => select( preferencesStore ).get( PREFERENCES_SCOPE, PREFERENCE_VIEW ) as Partial< PersistedView > | undefined, [] );
	const { set } = useDispatch( preferencesStore );
	const [ transient, setTransient ] = useState< Transient >( () => readUrlState() );
	const persisted = useMemo( () => sanitizePersisted( stored, defaultView, fields ), [ stored, defaultView, fields ] );

	const view = useMemo< View >( () => ( { ...persisted, page: transient.page, search: transient.search, filters: transient.filters } ) as View, [ persisted, transient ] );

	const persistedRef = useRef( persisted );

	useEffect( () => {
		persistedRef.current = persisted;
	}, [ persisted ] );

	useEffect( () => {
		writeUrl( transient );
	}, [ transient ] );

	// Back/forward: the URL is the source of truth for the transient part.
	useEffect( () => {
		const onPopState = () => setTransient( readUrlState() );
		window.addEventListener( 'popstate', onPopState );

		return () => window.removeEventListener( 'popstate', onPopState );
	}, [] );

	const setView = useCallback(
		( next: View ) => {
			const split = splitView( next );

			setTransient( ( current ) => {
				const changed = current.page !== split.transient.page || current.search !== split.transient.search || ! same( current.filters, split.transient.filters );

				return changed ? { ...current, ...split.transient } : current;
			} );

			if ( ! same( split.persisted, persistedRef.current ) ) {
				void set( PREFERENCES_SCOPE, PREFERENCE_VIEW, split.persisted );
			}
		},
		[ set ]
	);

	const setTab = useCallback( ( tab: StatusTabId ) => {
		setTransient( ( current ) => ( current.tab === tab ? current : { ...current, tab, page: 1 } ) );
	}, [] );

	const resetView = useCallback( () => {
		void set( PREFERENCES_SCOPE, PREFERENCE_VIEW, undefined );
	}, [ set ] );

	const isModified = ! same( persisted, splitView( defaultView ).persisted );

	return { view, setView, tab: transient.tab, setTab, isModified, resetView, defaultView };
}
