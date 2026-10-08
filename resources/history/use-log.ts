/** The change log through the query cache: `log:<json of query>`. */
import { useCallback } from '@wordpress/element';
import { getLog } from '../api/client';
import type { ListResult, LogQuery, LogRow } from '../api/client';
import { cache, useQuery } from '../store/query-cache';

export const LOG_PREFIX = 'log:';

export type { LogQuery, LogRow } from '../api/client';

export function logKey( query: LogQuery ): string {
	return `${ LOG_PREFIX }${ JSON.stringify( query ) }`;
}

const EMPTY: LogRow[] = [];

export interface LogState {
	items: LogRow[];
	total: number;
	totalPages: number;
	isLoading: boolean;
	isFetching: boolean;
	error?: Error;
	refetch(): Promise< void >;
}

export function useLog( query: LogQuery, options: { enabled?: boolean } = {} ): LogState {
	const key = logKey( query );
	const result = useQuery< ListResult< LogRow > >( key, ( signal ) => getLog( query, { signal } ), { keepPreviousData: true, enabled: options.enabled ?? true } );
	const refetch = useCallback( async () => {
		await result.refetch();
	}, [ result ] );

	return {
		items: result.data?.items ?? EMPTY,
		total: result.data?.total ?? 0,
		totalPages: result.data?.totalPages ?? 1,
		isLoading: result.isLoading,
		isFetching: result.isFetching,
		error: result.error,
		refetch,
	};
}

/** Drop every cached log page (after a save, an action or a revert). */
export function invalidateLog(): void {
	cache.invalidate( LOG_PREFIX );
}
