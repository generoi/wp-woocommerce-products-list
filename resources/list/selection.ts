/**
 * The Catalog's selection, kept across pages, searches, filters and sorts
 * (a status tab is a different list and clears it). DataViews only knows
 * the rows on the current page, so:
 *
 * - `onPageSelectionChange` is what DataViews calls: it replaces the
 *   page's part of the selection and leaves the rest alone (the header
 *   checkbox and the footer's "deselect" are page-scoped, as in Shopify);
 * - `set` replaces the whole selection (actions dropping the rows they
 *   processed, "Select all variations");
 * - `rows` are the selected rows, the page's fresh objects where present
 *   and the stored ones otherwise, so a bulk edit can act on rows the user
 *   selected on another page;
 * - `selectAllMatching` resolves every product of the current list query
 *   (pages of `limits.perPageMax`, trimmed `_fields`) into the selection,
 *   with progress and a cancel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { addAction, removeAction } from '@wordpress/hooks';
import { isGoneCode } from '../edit/errors';
import { __, sprintf } from '@wordpress/i18n';
import { listProducts } from '../api/client';
import type { ListResult } from '../api/client';
import { CORE_REQUEST_FIELDS } from '../api/query';
import { ACTIONS } from '../extensions/hooks';
import { getSettings } from '../settings';
import { getItemId } from '../types';
import type { BatchResult, ProductListItem, QueryParams } from '../types';

/** Products "Select all" resolves at most; above it the user narrows the list first. */
export const MAX_SELECT_ALL = 5000;

/** What a stored row needs: what the hierarchy, the actions and the edit modal's hydration read before fetching the rest. */
export const SELECT_ALL_FIELDS = [ ...CORE_REQUEST_FIELDS, 'name' ] as const;

export type SelectAllProgress = { loaded: number; total: number };

export type FetchPage = ( query: QueryParams, options: { signal: AbortSignal } ) => Promise< ListResult< ProductListItem > >;

export interface SelectionApi {
	/** Selected ids (DataViews ids, post ids as strings), page rows first in page order, then the rest. */
	selection: string[];
	/** The selected rows: fresh page objects where present, stored ones otherwise. */
	rows: ProductListItem[];
	/** Selected ids that are not on the current page. */
	offPageCount: number;
	/** DataViews' page-scoped change. */
	onPageSelectionChange( ids: string[] ): void;
	/** Replace the whole selection; unknown ids (no row on the page nor stored) are dropped. */
	set( ids: string[] ): void;
	clear(): void;
	/** Add every product matching `query` (the current list request); resolves to the number selected. */
	selectAllMatching( query: QueryParams, total: number ): Promise< number >;
	cancelSelectAll(): void;
	selectAllProgress: SelectAllProgress | null;
	selectAllError: string | null;
}

export interface UseSelectionOptions {
	fetchPage?: FetchPage;
	maxSelectAll?: number;
}

type Stored = Map< string, ProductListItem >;

function sameKeys( a: Stored, b: Stored ): boolean {
	if ( a.size !== b.size ) {
		return false;
	}

	for ( const key of a.keys() ) {
		if ( ! b.has( key ) ) {
			return false;
		}
	}

	return true;
}

/**
 * @param pageRows  The rows DataViews shows (parents and expanded variations; placeholders are ignored).
 * @param resetKey  A change clears the selection (the status tab).
 */
export function useSelection( pageRows: ProductListItem[], resetKey: string, options: UseSelectionOptions = {} ): SelectionApi {
	const fetchPage = options.fetchPage ?? ( listProducts as FetchPage );
	const maxSelectAll = options.maxSelectAll ?? MAX_SELECT_ALL;
	const [ stored, setStored ] = useState< Stored >( () => new Map() );
	const [ selectAllProgress, setSelectAllProgress ] = useState< SelectAllProgress | null >( null );
	const [ selectAllError, setSelectAllError ] = useState< string | null >( null );
	const selectAllRef = useRef< AbortController | null >( null );

	const pageById = useMemo( () => {
		const map = new Map< string, ProductListItem >();

		for ( const row of pageRows ) {
			if ( ! row._placeholder ) {
				map.set( getItemId( row ), row );
			}
		}

		return map;
	}, [ pageRows ] );
	// Read by the callbacks DataViews and the actions hold on to.
	const pageByIdRef = useRef( pageById );
	useLayoutEffect( () => {
		pageByIdRef.current = pageById;
	} );

	const cancelSelectAll = useCallback( () => {
		selectAllRef.current?.abort();
		selectAllRef.current = null;
		setSelectAllProgress( null );
	}, [] );

	// Another status tab is another list.
	const resetKeyRef = useRef( resetKey );
	useEffect( () => {
		if ( resetKeyRef.current !== resetKey ) {
			resetKeyRef.current = resetKey;
			cancelSelectAll();
			setStored( ( current ) => ( current.size ? new Map() : current ) );
		}
	}, [ resetKey, cancelSelectAll ] );

	useEffect( () => () => cancelSelectAll(), [ cancelSelectAll ] );

	// Rows that were saved or deleted leave the selection, so the next bulk
	// action cannot silently target what the last one already changed; rows
	// that failed stay selected for a retry.
	useEffect( () => {
		const namespace = 'wcProductsList/selection';
		const drop = ( ids: Iterable< number > ) => {
			const gone = new Set( Array.from( ids, String ) );

			if ( ! gone.size ) {
				return;
			}

			setStored( ( current ) => {
				const next = new Map( Array.from( current ).filter( ( [ id ] ) => ! gone.has( id ) ) );

				return next.size === current.size ? current : next;
			} );
		};

		addAction( ACTIONS.saved, namespace, ( result: BatchResult, context?: { source?: string } ) => {
			// A bulk edit that went through is done with its selection, whichever
			// rows it wrote (with "apply to variations" the parents are not in `updated`).
			if ( context?.source === 'bulk' && ( result?.errors ?? [] ).length === 0 ) {
				setStored( ( current ) => ( current.size ? new Map() : current ) );

				return;
			}

			drop( [
				...( result?.updated ?? [] ).map( ( row ) => row.id ),
				// Rows the server no longer has leave too; the rest stay for a retry.
				...( result?.errors ?? [] ).filter( ( error ) => isGoneCode( error.code ) ).map( ( error ) => error.id ),
			] );
		} );
		addAction( ACTIONS.deleted, namespace, ( ids: number[] ) => drop( Array.isArray( ids ) ? ids : [] ) );

		return () => {
			removeAction( ACTIONS.saved, namespace );
			removeAction( ACTIONS.deleted, namespace );
		};
	}, [] );

	const onPageSelectionChange = useCallback( ( ids: string[] ) => {
		const page = pageByIdRef.current;

		setStored( ( current ) => {
			const next: Stored = new Map();

			for ( const id of ids ) {
				const row = page.get( id ) ?? current.get( id );

				if ( row ) {
					next.set( id, row );
				}
			}

			for ( const [ id, row ] of current ) {
				if ( ! page.has( id ) && ! next.has( id ) ) {
					next.set( id, row );
				}
			}

			return sameKeys( current, next ) ? current : next;
		} );
	}, [] );

	const set = useCallback( ( ids: string[] ) => {
		const page = pageByIdRef.current;

		setStored( ( current ) => {
			const next: Stored = new Map();

			for ( const id of ids ) {
				const row = page.get( id ) ?? current.get( id );

				if ( row ) {
					next.set( id, row );
				}
			}

			return sameKeys( current, next ) ? current : next;
		} );
	}, [] );

	const clear = useCallback( () => {
		cancelSelectAll();
		setSelectAllError( null );
		setStored( ( current ) => ( current.size ? new Map() : current ) );
	}, [ cancelSelectAll ] );

	const selectAllMatching = useCallback(
		async ( query: QueryParams, total: number ): Promise< number > => {
			cancelSelectAll();
			setSelectAllError( null );

			if ( total > maxSelectAll ) {
				setSelectAllError(
					sprintf(
						/* translators: 1: the limit, 2: products matching */
						__( 'Select all works for up to %1$s products; this list has %2$s. Narrow it with a filter first.', 'wp-woocommerce-products-list' ),
						maxSelectAll.toLocaleString(),
						total.toLocaleString()
					)
				);

				return 0;
			}

			const controller = new AbortController();
			selectAllRef.current = controller;
			setSelectAllProgress( { loaded: 0, total } );

			const perPage = getSettings().limits.perPageMax;
			const base: QueryParams = { ...query, per_page: perPage, _fields: Array.from( new Set( SELECT_ALL_FIELDS ) ).sort().join( ',' ) };
			const found: ProductListItem[] = [];

			try {
				let page = 1;
				let pages = 1;

				do {
					const result = await fetchPage( { ...base, page }, { signal: controller.signal } );

					found.push( ...result.items.filter( ( row ) => ! row._placeholder ) );
					pages = result.totalPages || 1;
					page += 1;
					setSelectAllProgress( { loaded: found.length, total: result.total || total } );
				} while ( page <= pages && ! controller.signal.aborted );
			} catch ( error ) {
				if ( controller.signal.aborted ) {
					return 0;
				}

				setSelectAllError( error instanceof Error && error.message ? error.message : __( 'The products could not be loaded.', 'wp-woocommerce-products-list' ) );
				setSelectAllProgress( null );
				selectAllRef.current = null;

				return 0;
			}

			if ( controller.signal.aborted ) {
				return 0;
			}

			selectAllRef.current = null;
			setSelectAllProgress( null );

			const page = pageByIdRef.current;

			setStored( ( current ) => {
				const next = new Map( current );

				for ( const row of found ) {
					const id = getItemId( row );

					next.set( id, page.get( id ) ?? row );
				}

				return next;
			} );

			return found.length;
		},
		[ cancelSelectAll, fetchPage, maxSelectAll ]
	);

	const { selection, rows, offPageCount } = useMemo( () => {
		const onPage: ProductListItem[] = [];
		const elsewhere: ProductListItem[] = [];

		// Page order for the rows on the page (what DataViews and the footer count see), then the rest.
		for ( const [ id, row ] of pageById ) {
			if ( stored.has( id ) ) {
				onPage.push( row );
			}
		}

		for ( const [ id, row ] of stored ) {
			if ( ! pageById.has( id ) ) {
				elsewhere.push( row );
			}
		}

		const all = [ ...onPage, ...elsewhere ];

		return { selection: all.map( getItemId ), rows: all, offPageCount: elsewhere.length };
	}, [ stored, pageById ] );

	return { selection, rows, offPageCount, onPageSelectionChange, set, clear, selectAllMatching, cancelSelectAll, selectAllProgress, selectAllError };
}
