/**
 * The list's variation-level filters as variations-endpoint params, for the
 * hierarchy (api/query.ts `variationFilterParams`). An attribute filter
 * restored from the URL may name term ids whose slugs have not loaded yet:
 * they load here and the params are built again.
 */
import { useEffect, useMemo, useState } from '@wordpress/element';
import { variationFilterParams } from '../api/query';
import type { VariationFilter } from '../api/query';
import type { View } from '../dataviews';
import { termElements } from '../fields/terms';
import type { ProductField } from '../types';

export function useVariationFilter( view: View, fields: ProductField[] ): VariationFilter {
	const [ loadedAt, setLoadedAt ] = useState( 0 );
	// `loadedAt` re-runs the build once pending slugs arrived.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const filter = useMemo( () => variationFilterParams( view, fields ), [ view.filters, fields, loadedAt ] );
	const pendingKey = filter.pending.join( ',' );

	useEffect( () => {
		if ( ! pendingKey ) {
			return;
		}

		let cancelled = false;

		void Promise.all( pendingKey.split( ',' ).map( ( taxonomy ) => termElements( taxonomy ).catch( () => [] ) ) ).then( () => {
			if ( ! cancelled ) {
				setLoadedAt( Date.now() );
			}
		} );

		return () => {
			cancelled = true;
		};
	}, [ pendingKey ] );

	return filter;
}
