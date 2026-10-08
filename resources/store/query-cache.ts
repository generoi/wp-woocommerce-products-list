/**
 * A small request cache: one entry per key, in-flight dedupe, abort of a
 * superseded fetch, `patch` for optimistic updates, `invalidate(prefix)`
 * that refetches whatever is still on screen. Components read it through
 * `useQuery` (useSyncExternalStore), so a patch re-renders every list that
 * shows the row. No @wordpress/data: the shapes here are simple and the
 * hot path (a 100-row page) has to stay cheap.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from '@wordpress/element';
import { isAbortError } from '../api/errors';

export type Fetcher< T > = ( signal: AbortSignal ) => Promise< T >;

export interface CacheEntry< T > {
	key: string;
	data: T | undefined;
	error: Error | undefined;
	/** True while a request for this key is in flight. */
	isFetching: boolean;
	/** Set when the entry was invalidated and nobody refetched yet. */
	isStale: boolean;
	updatedAt: number;
}

interface Internal< T > {
	entry: CacheEntry< T >;
	fetcher?: Fetcher< T >;
	controller?: AbortController;
	promise?: Promise< T >;
	listeners: Set< () => void >;
}

export interface FetchOptions {
	/** When true (default) a fetch in flight for the key is reused; false aborts it and starts over. */
	dedupe?: boolean;
}

export interface QueryCache {
	get< T >( key: string ): CacheEntry< T > | undefined;
	fetch< T >( key: string, fetcher: Fetcher< T >, options?: FetchOptions ): Promise< T >;
	patch< T >( key: string, updater: ( data: T ) => T ): void;
	/** Drop every entry whose key starts with `prefix`; subscribed ones refetch. */
	invalidate( prefix: string ): void;
	subscribe( key: string, listener: () => void ): () => void;
	keys( prefix?: string ): string[];
	/** Remove one entry without refetching. */
	remove( key: string ): void;
	clear(): void;
}

const MAX_IDLE_ENTRIES = 60;

function emptyEntry< T >( key: string ): CacheEntry< T > {
	return { key, data: undefined, error: undefined, isFetching: false, isStale: false, updatedAt: 0 };
}

export function createQueryCache(): QueryCache {
	const store = new Map< string, Internal< unknown > >();

	function internal< T >( key: string ): Internal< T > {
		let item = store.get( key ) as Internal< T > | undefined;

		if ( ! item ) {
			item = { entry: emptyEntry< T >( key ), listeners: new Set() };
			store.set( key, item as Internal< unknown > );
		}

		return item;
	}

	function update< T >( item: Internal< T >, changes: Partial< CacheEntry< T > > ): void {
		item.entry = { ...item.entry, ...changes };
		item.listeners.forEach( ( listener ) => listener() );
	}

	/** Keep memory bounded: drop the oldest entries nobody subscribes to. */
	function evict(): void {
		const idle = Array.from( store.values() ).filter( ( item ) => item.listeners.size === 0 && ! item.entry.isFetching );

		if ( idle.length <= MAX_IDLE_ENTRIES ) {
			return;
		}

		idle.sort( ( a, b ) => a.entry.updatedAt - b.entry.updatedAt )
			.slice( 0, idle.length - MAX_IDLE_ENTRIES )
			.forEach( ( item ) => store.delete( item.entry.key ) );
	}

	/** The entry keeps its data while the request runs; `useQuery` decides what to show meanwhile. */
	function run< T >( item: Internal< T >, fetcher: Fetcher< T > ): Promise< T > {
		item.controller?.abort();
		const controller = new AbortController();
		item.controller = controller;
		item.fetcher = fetcher;
		update( item, { isFetching: true, error: undefined } );

		const promise = fetcher( controller.signal ).then(
			( data ) => {
				if ( item.controller !== controller ) {
					// Superseded: a newer fetch of the same key owns the entry.
					return data;
				}

				item.controller = undefined;
				item.promise = undefined;
				update( item, { data, error: undefined, isFetching: false, isStale: false, updatedAt: Date.now() } );
				evict();

				return data;
			},
			( error: unknown ) => {
				if ( item.controller === controller ) {
					item.controller = undefined;
					item.promise = undefined;

					if ( isAbortError( error ) ) {
						update( item, { isFetching: false } );
					} else {
						update( item, { error: error instanceof Error ? error : new Error( String( error ) ), isFetching: false } );
					}
				}

				throw error;
			}
		);

		item.promise = promise;

		return promise;
	}

	return {
		get< T >( key: string ) {
			return store.get( key )?.entry as CacheEntry< T > | undefined;
		},

		fetch< T >( key: string, fetcher: Fetcher< T >, options: FetchOptions = {} ) {
			const item = internal< T >( key );

			if ( item.promise && options.dedupe !== false ) {
				item.fetcher = fetcher;

				return item.promise;
			}

			return run( item, fetcher );
		},

		patch< T >( key: string, updater: ( data: T ) => T ) {
			const item = store.get( key ) as Internal< T > | undefined;

			if ( ! item || item.entry.data === undefined ) {
				return;
			}

			const next = updater( item.entry.data );

			if ( next !== item.entry.data ) {
				update( item, { data: next } );
			}
		},

		invalidate( prefix: string ) {
			for ( const [ key, item ] of Array.from( store.entries() ) ) {
				if ( ! key.startsWith( prefix ) ) {
					continue;
				}

				if ( item.listeners.size > 0 && item.fetcher ) {
					update( item, { isStale: true } );
					void run( item, item.fetcher ).catch( () => {} );
				} else {
					item.controller?.abort();
					store.delete( key );
				}
			}
		},

		subscribe( key: string, listener: () => void ) {
			const item = internal( key );
			item.listeners.add( listener );

			return () => {
				item.listeners.delete( listener );

				// Nobody is looking any more: an in-flight request is wasted work.
				if ( item.listeners.size === 0 && item.controller ) {
					item.controller.abort();
					item.controller = undefined;
					item.promise = undefined;
					item.entry = { ...item.entry, isFetching: false };
				}
			};
		},

		keys( prefix = '' ) {
			return Array.from( store.keys() ).filter( ( key ) => key.startsWith( prefix ) );
		},

		remove( key: string ) {
			const item = store.get( key );

			if ( ! item ) {
				return;
			}

			item.controller?.abort();
			store.delete( key );
			update( item, emptyEntry( key ) );
		},

		clear() {
			for ( const key of Array.from( store.keys() ) ) {
				this.remove( key );
			}
		},
	};
}

/** The app singleton. */
export const cache: QueryCache = createQueryCache();

export interface UseQueryOptions {
	keepPreviousData?: boolean;
	enabled?: boolean;
	/** Refetch when the cached data is older than this (ms); default: never while mounted. */
	staleTime?: number;
}

export interface UseQueryResult< T > {
	data: T | undefined;
	error: Error | undefined;
	/** No data to show yet. */
	isLoading: boolean;
	/** A request is in flight (also during background refetches). */
	isFetching: boolean;
	refetch: () => Promise< T >;
}

const NO_ENTRY = emptyEntry< never >( '' );

/**
 * Read one key through the cache. With `keepPreviousData` the hook hands
 * back the last data it showed while a new key loads, so pagination and
 * search never flash an empty table.
 */
export function useQuery< T >( key: string | null, fetcher: Fetcher< T >, options: UseQueryOptions = {} ): UseQueryResult< T > {
	const { keepPreviousData = false, enabled = true, staleTime } = options;
	const fetcherRef = useRef( fetcher );

	useEffect( () => {
		fetcherRef.current = fetcher;
	} );

	const subscribe = useCallback( ( listener: () => void ) => ( key ? cache.subscribe( key, listener ) : () => {} ), [ key ] );
	const getSnapshot = useCallback( () => ( key ? cache.get< T >( key ) ?? NO_ENTRY : NO_ENTRY ), [ key ] );
	const entry = useSyncExternalStore( subscribe, getSnapshot, getSnapshot ) as CacheEntry< T >;

	// The last data this hook showed, so a new key can keep it on screen
	// while loading (state set during render: React's derived-state pattern).
	const [ previous, setPrevious ] = useState< { key: string; data: T } | undefined >( undefined );

	if ( key && entry.data !== undefined && ( previous?.key !== key || previous.data !== entry.data ) ) {
		setPrevious( { key, data: entry.data } );
	}

	useEffect( () => {
		if ( ! key || ! enabled ) {
			return;
		}

		const current = cache.get< T >( key );
		const fresh = current?.data !== undefined && ( staleTime === undefined || Date.now() - current.updatedAt < staleTime );

		if ( ! fresh && ! current?.isFetching ) {
			cache.fetch( key, ( signal ) => fetcherRef.current( signal ) ).catch( () => {} );
		}
	}, [ key, enabled, staleTime ] );

	const refetch = useCallback( () => {
		if ( ! key ) {
			return Promise.reject( new Error( 'No key' ) );
		}

		return cache.fetch( key, ( signal ) => fetcherRef.current( signal ), { dedupe: false } );
	}, [ key ] );

	const data = entry.data ?? ( keepPreviousData ? previous?.data : undefined );
	const isFetching = Boolean( key && enabled ) && ( entry.isFetching || ( entry.data === undefined && ! entry.error ) );

	return {
		data,
		error: entry.error,
		isLoading: data === undefined && isFetching,
		isFetching,
		refetch,
	};
}
