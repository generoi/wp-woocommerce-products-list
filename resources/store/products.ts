/**
 * The product list and the status counts, on top of the query cache.
 * `patchItems` / `removeItems` are the optimistic path: every cached page
 * (products and variations) that holds the row changes at once, before the
 * request is made; `invalidateProducts` is the slow, certain path.
 */
import { useCallback, useEffect, useMemo } from '@wordpress/element';
import { doAction } from '@wordpress/hooks';
import { getCounts, listProducts } from '../api/client';
import type { ListResult } from '../api/client';
import { buildProductListQuery } from '../api/query';
import type { View } from '../dataviews';
import { ACTIONS } from '../extensions/hooks';
import { invalidateVariations, patchVariationRows, removeVariationRows } from '../hierarchy/use-hierarchy';
import { getSettings } from '../settings';
import type { ProductField, ProductListItem, QueryParams } from '../types';
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
	const result = useQuery< ListResult< ProductListItem > >( key, ( signal ) => listProducts( query, { signal } ), { keepPreviousData: true } );
	const data = result.data;

	useEffect( () => {
		if ( data && ! result.isFetching ) {
			doAction( ACTIONS.loaded, data.items, { tab, view, total: data.total } );
		}
	}, [ data, result.isFetching, tab, view ] );

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

/** Merge partial rows by id into every cached product page and variations page. */
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

/** Drop rows by id from every cached page (a trash or delete that already happened). */
export function removeItems( ids: number[] ): void {
	if ( ! ids.length ) {
		return;
	}

	const set = new Set( ids );

	for ( const key of [ ...cache.keys( PRODUCTS_PREFIX ), ...cache.keys( VARIATIONS_PREFIX ) ] ) {
		cache.patch< ListResult< ProductListItem > >( key, ( data ) => {
			const items = data.items.filter( ( item ) => ! set.has( item.id ) );

			return items.length === data.items.length ? data : { ...data, items, total: Math.max( 0, data.total - ( data.items.length - items.length ) ) };
		} );
	}

	removeVariationRows( ids );
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
