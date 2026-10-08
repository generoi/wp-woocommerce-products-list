import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryCache, useQuery } from '../../resources/store/query-cache';

function deferred< T >() {
	let resolve!: ( value: T ) => void;
	let reject!: ( error: unknown ) => void;
	const promise = new Promise< T >( ( res, rej ) => {
		resolve = res;
		reject = rej;
	} );

	return { promise, resolve, reject };
}

describe( 'createQueryCache', () => {
	it( 'dedupes an in-flight fetch of the same key', async () => {
		const cache = createQueryCache();
		const d = deferred< number >();
		const fetcher = vi.fn( () => d.promise );

		const a = cache.fetch( 'k', fetcher );
		const b = cache.fetch( 'k', fetcher );

		expect( fetcher ).toHaveBeenCalledTimes( 1 );
		expect( cache.get( 'k' )?.isFetching ).toBe( true );
		d.resolve( 1 );
		expect( await a ).toBe( 1 );
		expect( await b ).toBe( 1 );
		expect( cache.get( 'k' ) ).toMatchObject( { data: 1, isFetching: false, error: undefined } );
	} );

	it( 'aborts a superseded fetch when told not to dedupe', async () => {
		const cache = createQueryCache();
		const first = deferred< string >();
		const second = deferred< string >();
		const signals: AbortSignal[] = [];
		let calls = 0;
		const fetcher = ( signal: AbortSignal ) => {
			signals.push( signal );
			calls += 1;

			return calls === 1 ? first.promise : second.promise;
		};

		const a = cache.fetch( 'k', fetcher ).catch( ( e ) => e );
		const b = cache.fetch( 'k', fetcher, { dedupe: false } );

		expect( signals[ 0 ]?.aborted ).toBe( true );
		expect( signals[ 1 ]?.aborted ).toBe( false );

		first.reject( Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ) );
		second.resolve( 'new' );

		await a;
		expect( await b ).toBe( 'new' );
		expect( cache.get( 'k' )?.data ).toBe( 'new' );
		expect( cache.get( 'k' )?.error ).toBeUndefined();
	} );

	it( 'records errors and keeps the previous data', async () => {
		const cache = createQueryCache();
		await cache.fetch( 'k', async () => 'ok' );
		await cache.fetch( 'k', async () => {
			throw new Error( 'boom' );
		}, { dedupe: false } ).catch( () => {} );

		expect( cache.get( 'k' ) ).toMatchObject( { data: 'ok', isFetching: false } );
		expect( cache.get( 'k' )?.error?.message ).toBe( 'boom' );
	} );

	it( 'patches data and notifies subscribers', async () => {
		const cache = createQueryCache();
		const listener = vi.fn();
		cache.subscribe( 'k', listener );
		await cache.fetch( 'k', async () => ( { items: [ { id: 1, name: 'a' } ] } ) );
		listener.mockClear();

		cache.patch< { items: Array< { id: number; name: string } > } >( 'k', ( data ) => ( { items: data.items.map( ( i ) => ( { ...i, name: 'b' } ) ) } ) );

		expect( listener ).toHaveBeenCalledTimes( 1 );
		expect( cache.get< { items: Array< { name: string } > } >( 'k' )?.data?.items[ 0 ]?.name ).toBe( 'b' );

		cache.patch( 'k', ( data ) => data );
		expect( listener ).toHaveBeenCalledTimes( 1 );
		cache.patch( 'missing', ( data ) => data );
	} );

	it( 'invalidate drops idle entries and refetches subscribed ones', async () => {
		const cache = createQueryCache();
		let version = 0;
		const fetcher = vi.fn( async () => ++version );

		await cache.fetch( 'products:a', fetcher );
		await cache.fetch( 'products:b', fetcher );
		await cache.fetch( 'counts', fetcher );
		const unsubscribe = cache.subscribe( 'products:a', () => {} );

		cache.invalidate( 'products:' );

		expect( cache.keys( 'products:' ) ).toEqual( [ 'products:a' ] );
		expect( cache.get( 'counts' )?.data ).toBe( 3 );
		expect( cache.get( 'products:a' )?.isFetching ).toBe( true );
		await waitFor( () => expect( cache.get( 'products:a' )?.data ).toBe( 4 ) );
		unsubscribe();
	} );

	it( 'aborts a fetch nobody is subscribed to any more', () => {
		const cache = createQueryCache();
		const d = deferred< number >();
		let seen: AbortSignal | undefined;
		const unsubscribe = cache.subscribe( 'k', () => {} );
		cache.fetch( 'k', ( signal ) => {
			seen = signal;

			return d.promise;
		} ).catch( () => {} );

		unsubscribe();

		expect( seen?.aborted ).toBe( true );
		expect( cache.get( 'k' )?.isFetching ).toBe( false );
	} );
} );

describe( 'useQuery', () => {
	it( 'loads once per key and keeps the previous data while the next key loads', async () => {
		vi.resetModules();
		const { useQuery: useFreshQuery } = await import( '../../resources/store/query-cache' );
		const pending = new Map< string, ReturnType< typeof deferred< string > > >();
		const fetcher = vi.fn( ( key: string ) => {
			const d = deferred< string >();
			pending.set( key, d );

			return d.promise;
		} );

		const { result, rerender } = renderHook( ( { key }: { key: string } ) => useFreshQuery( key, () => fetcher( key ), { keepPreviousData: true } ), {
			initialProps: { key: 'a' },
		} );

		expect( result.current.isLoading ).toBe( true );
		expect( fetcher ).toHaveBeenCalledTimes( 1 );

		await act( async () => {
			pending.get( 'a' )?.resolve( 'A' );
			await pending.get( 'a' )?.promise;
		} );

		expect( result.current ).toMatchObject( { data: 'A', isLoading: false, isFetching: false } );

		rerender( { key: 'b' } );

		expect( fetcher ).toHaveBeenCalledTimes( 2 );
		expect( result.current ).toMatchObject( { data: 'A', isLoading: false, isFetching: true } );

		await act( async () => {
			pending.get( 'b' )?.resolve( 'B' );
			await pending.get( 'b' )?.promise;
		} );

		expect( result.current ).toMatchObject( { data: 'B', isFetching: false } );

		// Back to a cached key: no request.
		rerender( { key: 'a' } );
		expect( fetcher ).toHaveBeenCalledTimes( 2 );
		expect( result.current.data ).toBe( 'A' );
	} );

	it( 'does nothing without a key or when disabled', async () => {
		vi.resetModules();
		const { useQuery: useFreshQuery } = await import( '../../resources/store/query-cache' );
		const fetcher = vi.fn( async () => 1 );
		const { result } = renderHook( () => useFreshQuery( null, fetcher ) );

		expect( result.current ).toMatchObject( { data: undefined, isLoading: false, isFetching: false } );
		expect( fetcher ).not.toHaveBeenCalled();

		const disabled = renderHook( () => useFreshQuery( 'k', fetcher, { enabled: false } ) );
		expect( disabled.result.current.isFetching ).toBe( false );
		expect( fetcher ).not.toHaveBeenCalled();
	} );
} );

// Keep the app singleton import exercised.
void useQuery;
