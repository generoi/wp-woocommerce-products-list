/**
 * The product list and the status counts, on top of the query cache.
 * `patchItems` / `removeItems` are the optimistic path: every cached page
 * (products and variations) that holds the row changes at once, before the
 * request is made; `invalidateProducts` is the slow, certain path.
 */
import { useCallback, useEffect, useMemo, useRef } from '@wordpress/element';
import { addAction, doAction } from '@wordpress/hooks';
import { getCounts, listProducts } from '../api/client';
import type { ListResult } from '../api/client';
import { buildProductListQuery } from '../api/query';
import type { View } from '../dataviews';
import { ACTIONS } from '../extensions/hooks';
import { getChildrenState, invalidateVariations, patchVariationRows, removeVariationRows } from '../hierarchy/use-hierarchy';
import { getSettings } from '../settings';
import type { BatchResult, ProductField, ProductListItem, QueryParams } from '../types';
import { cache, useQuery } from './query-cache';

export const PRODUCTS_PREFIX = 'products:';
export const VARIATIONS_PREFIX = 'variations:';
export const COUNTS_KEY = 'counts';

export function productsKey( query: QueryParams ): string {
	return `${ PRODUCTS_PREFIX }${ JSON.stringify( query ) }`;
}

export function variationsKey( parentId: number, page: number ): string {
	return `${ VARIATIONS_PREFIX }${ parentId }:${ page }`;
}

const EMPTY: ProductListItem[] = [];

/**
 * Rows the user wrote (a save or a server action went through for them)
 * since the list query last changed. Only writes count: a cache merge
 * (an editor hydrating its rows, a rollback, a parent's refreshed price
 * range) leaves a row free to leave the filtered list. A refetch of the same query keeps those that no longer match it
 * (a "Missing in Svenska" row just translated) on screen, marked
 * `_noLongerMatches`, like a quick edit that does not refetch: the rows the
 * user just worked on do not vanish under the open editor. Changing the
 * filter, search, page or tab drops them.
 */
const editedIds = new Set< number >();

/** Remember rows the user just wrote, so a refetch of the same view keeps them (marked "no longer matches"). */
export function markEdited( ids: Iterable< number > ): void {
	for ( const id of ids ) {
		if ( Number.isInteger( id ) && id > 0 ) {
			editedIds.add( id );
		}
	}
}

/** Whether a row counts as written in this view (tests). */
export function isEdited( id: number ): boolean {
	return editedIds.has( id );
}

/** Forget the edited rows (the list query changed). */
export function resetEditedRows(): void {
	editedIds.clear();
}

/**
 * Put the edited rows of `previous` that `next` no longer has back at their
 * old positions, marked `_noLongerMatches`; `total` counts them so the
 * footer agrees with the table.
 */
export function retainEditedRows( previous: ListResult< ProductListItem > | undefined, next: ListResult< ProductListItem >, edited: ReadonlySet< number > = editedIds ): ListResult< ProductListItem > {
	if ( ! previous || ! edited.size ) {
		return next;
	}

	const present = new Set( next.items.map( ( item ) => item.id ) );
	const items = next.items.slice();
	let kept = 0;

	previous.items.forEach( ( item, index ) => {
		if ( item._kind !== 'product' || item._placeholder || ! edited.has( item.id ) || present.has( item.id ) ) {
			return;
		}

		items.splice( Math.min( index, items.length ), 0, { ...item, _noLongerMatches: true } );
		kept += 1;
	} );

	return kept ? { ...next, items, total: next.total + kept } : next;
}

export interface ProductListState {
	items: ProductListItem[];
	total: number;
	totalPages: number;
	isLoading: boolean;
	isFetching: boolean;
	error?: Error;
	query: QueryParams;
	refetch: () => Promise< void >;
}

export function useProductList( view: View, tab: string, fields: ProductField[] ): ProductListState {
	const settings = getSettings();
	const query = useMemo( () => buildProductListQuery( view, tab, fields, settings ), [ view, tab, fields, settings ] );
	const key = productsKey( query );
	const result = useQuery< ListResult< ProductListItem > >(
		key,
		async ( signal ) => {
			const previous = cache.get< ListResult< ProductListItem > >( key )?.data;
			const next = await listProducts( query, { signal } );

			return retainEditedRows( previous, next );
		},
		{ keepPreviousData: true }
	);

	// A new filter, search, page or tab is a new view: rows edited in the old one may leave.
	const lastKeyRef = useRef( key );

	useEffect( () => {
		if ( lastKeyRef.current !== key ) {
			lastKeyRef.current = key;
			resetEditedRows();
		}
	}, [ key ] );
	const data = result.data;

	// `wcProductsList.loaded` once per completed list request: the cache's
	// `updatedAt` moves on a fetch, not on the optimistic patches that give
	// `data` a new identity after every save.
	const loadedAt = result.updatedAt;
	const announcedRef = useRef< { key: string; at: number } | null >( null );

	useEffect( () => {
		if ( ! data || result.isFetching || ! loadedAt ) {
			return;
		}

		if ( announcedRef.current?.key === key && announcedRef.current.at === loadedAt ) {
			return;
		}

		announcedRef.current = { key, at: loadedAt };
		doAction( ACTIONS.loaded, data.items, { tab, view, total: data.total } );
	}, [ data, result.isFetching, loadedAt, key, tab, view ] );

	const refetch = useCallback( async () => {
		await result.refetch();
	}, [ result ] );

	return {
		items: data?.items ?? EMPTY,
		total: data?.total ?? 0,
		totalPages: data?.totalPages ?? 1,
		isLoading: result.isLoading,
		isFetching: result.isFetching,
		error: result.error,
		query,
		refetch,
	};
}

const NO_COUNTS: Record< string, number > = {};

export function useCounts(): { counts: Record< string, number >; refetch: () => Promise< void >; isLoading: boolean } {
	const result = useQuery< Record< string, number > >( COUNTS_KEY, ( signal ) => getCounts( { signal } ), { keepPreviousData: true } );
	const refetch = useCallback( async () => {
		await result.refetch();
	}, [ result ] );

	return { counts: result.data ?? NO_COUNTS, refetch, isLoading: result.isLoading };
}

function patchList( key: string, byId: Map< number, Partial< ProductListItem > > ): void {
	cache.patch< ListResult< ProductListItem > >( key, ( data ) => {
		let changed = false;
		const items = data.items.map( ( item ) => {
			const patch = byId.get( item.id );

			if ( ! patch || item._placeholder ) {
				return item;
			}

			changed = true;

			return { ...item, ...patch, id: item.id } as ProductListItem;
		} );

		return changed ? { ...data, items } : data;
	} );
}

/**
 * Merge partial rows by id into every cached product page and variations
 * page. A pure cache merge: it does not mark the rows edited (`markEdited`
 * does, on a successful write), so hydrating an editor or rolling back a
 * failed save never pins a row in a filter it no longer matches.
 */
export function patchItems( items: Array< Partial< ProductListItem > & { id: number } > ): void {
	if ( ! items.length ) {
		return;
	}

	const byId = new Map< number, Partial< ProductListItem > >();

	for ( const item of items ) {
		byId.set( item.id, { ...( byId.get( item.id ) ?? {} ), ...item } );
	}

	for ( const key of [ ...cache.keys( PRODUCTS_PREFIX ), ...cache.keys( VARIATIONS_PREFIX ) ] ) {
		patchList( key, byId );
	}

	// Expanded variations live in the hierarchy's own store.
	patchVariationRows( items );
}

type RemovedListener = ( ids: number[] ) => void;

const removedListeners = new Set< RemovedListener >();

/**
 * Called with the ids `removeItems` dropped (the selection lets go of them,
 * so the next footer action cannot reach a row that is gone).
 */
export function subscribeRemoved( listener: RemovedListener ): () => void {
	removedListeners.add( listener );

	return () => {
		removedListeners.delete( listener );
	};
}

/** Parent id → how many of `ids` are its loaded or cached variations. */
function removedVariationsByParent( ids: ReadonlySet< number > ): Map< number, number > {
	const found = new Map< number, Set< number > >();
	const add = ( parentId: number, id: number ) => {
		if ( ! ids.has( parentId ) ) {
			found.set( parentId, ( found.get( parentId ) ?? new Set() ).add( id ) );
		}
	};

	for ( const [ parentId, state ] of getChildrenState() ) {
		for ( const item of state.items ) {
			if ( ids.has( item.id ) ) {
				add( parentId, item.id );
			}
		}
	}

	for ( const key of cache.keys( VARIATIONS_PREFIX ) ) {
		for ( const item of cache.get< ListResult< ProductListItem > >( key )?.data?.items ?? [] ) {
			const parentId = parentIdOf( item );

			if ( parentId && ids.has( item.id ) ) {
				add( parentId, item.id );
			}
		}
	}

	return new Map( Array.from( found, ( [ parentId, removed ] ) => [ parentId, removed.size ] ) );
}

/**
 * Drop rows by id from every cached page (a trash or delete that already
 * happened, or rows a save or an editor found gone meanwhile). The rows
 * leave the selection too, the status tab counts refetch, and the parents
 * of removed variations show one variation fewer at once and then refetch
 * their variations and their derived fields (the count, the price range).
 */
export function removeItems( ids: number[] ): void {
	if ( ! ids.length ) {
		return;
	}

	const set = new Set( ids );
	const parents = removedVariationsByParent( set );

	for ( const key of [ ...cache.keys( PRODUCTS_PREFIX ), ...cache.keys( VARIATIONS_PREFIX ) ] ) {
		cache.patch< ListResult< ProductListItem > >( key, ( data ) => {
			const items = data.items.filter( ( item ) => ! set.has( item.id ) );

			return items.length === data.items.length ? data : { ...data, items, total: Math.max( 0, data.total - ( data.items.length - items.length ) ) };
		} );
	}

	removeVariationRows( ids );

	if ( parents.size ) {
		const counts: Array< Partial< ProductListItem > & { id: number } > = [];

		for ( const key of cache.keys( PRODUCTS_PREFIX ) ) {
			for ( const item of cache.get< ListResult< ProductListItem > >( key )?.data?.items ?? [] ) {
				const removed = parents.get( item.id );

				if ( removed && item._kind === 'product' ) {
					const count = Math.max( 0, item._childCount - removed );
					const meta = ( item as { wc_products_list?: Record< string, unknown > } ).wc_products_list;

					counts.push( { id: item.id, _childCount: count, _hasChildren: count > 0, ...( meta ? { wc_products_list: { ...meta, variation_count: count } } : {} ) } as Partial< ProductListItem > & { id: number } );
				}
			}
		}

		const byId = new Map( counts.map( ( row ) => [ row.id, row ] ) );

		for ( const key of cache.keys( PRODUCTS_PREFIX ) ) {
			patchList( key, byId );
		}

		const parentIds = Array.from( parents.keys() );

		invalidateVariations( parentIds );
		void refreshParentIds( parentIds ).catch( () => {} );
	}

	invalidateCounts();

	for ( const listener of Array.from( removedListeners ) ) {
		listener( ids );
	}
}

/** Refetch what is on screen, drop the rest; counts too when asked. */
export function invalidateProducts( options: { counts?: boolean; variations?: boolean } = {} ): void {
	cache.invalidate( PRODUCTS_PREFIX );

	if ( options.variations !== false ) {
		cache.invalidate( VARIATIONS_PREFIX );
		invalidateVariations();
	}

	if ( options.counts ) {
		cache.invalidate( COUNTS_KEY );
	}
}

export function invalidateCounts(): void {
	cache.invalidate( COUNTS_KEY );
}

/**
 * The row of this id as the list loaded it (any cached product or
 * variations page, or the expanded variations), for the expected values of
 * a write made outside the editor (`window.wcProductsList.batchUpdate`).
 */
export function findCachedRow( id: number ): ProductListItem | undefined {
	for ( const key of [ ...cache.keys( PRODUCTS_PREFIX ), ...cache.keys( VARIATIONS_PREFIX ) ] ) {
		const row = cache.get< ListResult< ProductListItem > >( key )?.data?.items.find( ( item ) => item.id === id );

		if ( row ) {
			return row;
		}
	}

	for ( const state of getChildrenState().values() ) {
		const row = state.items.find( ( item ) => item.id === id );

		if ( row ) {
			return row;
		}
	}

	return undefined;
}

/** Ids of the products in any cached product page. */
export function cachedProductIds(): Set< number > {
	const ids = new Set< number >();

	for ( const key of cache.keys( PRODUCTS_PREFIX ) ) {
		for ( const item of cache.get< ListResult< ProductListItem > >( key )?.data?.items ?? [] ) {
			if ( item._kind === 'product' ) {
				ids.add( item.id );
			}
		}
	}

	return ids;
}

/**
 * What WooCommerce derives on a variable parent from its variations: the
 * price range, the on-sale flag, the stock summary. Refetched for the
 * parents of saved variations so the parent row does not show a stale
 * "From X" until a reload.
 */
export const PARENT_DERIVED_FIELDS = [
	'id',
	'type',
	'price',
	'regular_price',
	'sale_price',
	'on_sale',
	'date_on_sale_from',
	'date_on_sale_from_gmt',
	'date_on_sale_to',
	'date_on_sale_to_gmt',
	'stock_status',
	'stock_quantity',
	'manage_stock',
	'date_modified',
	'date_modified_gmt',
	'wc_products_list',
] as const;

function parentIdOf( row: ProductListItem ): number | undefined {
	if ( row._kind === 'variation' && row._parentId ) {
		return row._parentId;
	}

	const parent = ( row as { parent_id?: number } ).parent_id;

	return row._kind !== 'product' && parent ? parent : undefined;
}

/** Refetch the derived fields of the parents of `rows` that are in a cached page, and patch them in. */
export async function refreshParentsOf( rows: ProductListItem[], fetchList: typeof listProducts = listProducts ): Promise< number[] > {
	return refreshParentIds( rows.map( parentIdOf ).filter( ( id ): id is number => typeof id === 'number' ), fetchList );
}

/** Refetch the derived fields of these parents (those in a cached page) and patch them in. */
export async function refreshParentIds( ids: number[], fetchList: typeof listProducts = listProducts ): Promise< number[] > {
	const cached = cachedProductIds();
	const parents = Array.from( new Set( ids.filter( ( id ) => cached.has( id ) ) ) );

	if ( ! parents.length ) {
		return [];
	}

	const perPage = getSettings().limits.perPageMax;
	const refreshed: number[] = [];

	for ( let start = 0; start < parents.length; start += perPage ) {
		const chunk = parents.slice( start, start + perPage );
		const result = await fetchList( {
			include: chunk.join( ',' ),
			per_page: chunk.length,
			status: 'any',
			_fields: PARENT_DERIVED_FIELDS.join( ',' ),
		} );

		if ( result.items.length ) {
			patchItems( result.items );
			refreshed.push( ...result.items.map( ( item ) => item.id ) );
		}
	}

	return refreshed;
}

// The write path: rows a save or a server action actually changed.
addAction( ACTIONS.saved, 'wcProductsList/products/edited', ( result: BatchResult ) => {
	if ( Array.isArray( result?.updated ) ) {
		markEdited( result.updated.map( ( row ) => row.id ) );
	}
} );

addAction( ACTIONS.actionPerformed, 'wcProductsList/products/edited', ( result: { ids?: number[] } ) => {
	if ( Array.isArray( result?.ids ) ) {
		markEdited( result.ids );
	}
} );

addAction( ACTIONS.saved, 'wcProductsList/products/parents', ( result: BatchResult ) => {
	if ( Array.isArray( result?.updated ) && result.updated.length ) {
		void refreshParentsOf( result.updated ).catch( () => {} );
	}
} );
