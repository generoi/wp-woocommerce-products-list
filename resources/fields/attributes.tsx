/**
 * One filter per global attribute (`pa_*`): "Colour is any of Black with
 * wool", "Size is 38". Not columns.
 *
 * - The product list gets wc/v3's own `attribute` + `attribute_term` (term
 *   ids, OR): the variable products that carry the value. wc/v3 takes one
 *   attribute per request; with two attribute filters the products are
 *   narrowed by the last one and the variations by both.
 * - Expanded parents list only the variations with that value
 *   (`attributes[][attribute]` + `[terms][]` on the variations endpoint,
 *   which matches the variation's `attribute_pa_*` meta, a term slug), so
 *   "Select all variations" on such a parent selects the matching sizes or
 *   colours only (api/query.ts `variationFilterParams`).
 */
import { __, sprintf } from '@wordpress/i18n';
import type { Filter } from '../dataviews';
import type { ProductField, QueryParams, Settings } from '../types';
import { field } from './helpers';
import { termElements, termSlugs } from './terms';

export const ATTRIBUTE_FIELD_PREFIX = 'attribute:';

/** The taxonomy of an attribute filter field id ("attribute:pa_color" → "pa_color"), or null. */
export function attributeTaxonomyOf( id: string ): string | null {
	return id.startsWith( ATTRIBUTE_FIELD_PREFIX ) ? id.slice( ATTRIBUTE_FIELD_PREFIX.length ) : null;
}

function ids( value: unknown ): number[] {
	return ( Array.isArray( value ) ? value : [ value ] ).map( Number ).filter( ( id ) => Number.isInteger( id ) && id > 0 );
}

/** Products: wc/v3 `attribute` + `attribute_term` (comma separated term ids). */
export function attributeProductParams( taxonomy: string, value: unknown, operator: Filter[ 'operator' ] ): QueryParams {
	const terms = ids( value );

	if ( ! terms.length || ( operator !== 'isAny' && operator !== 'is' ) ) {
		return {};
	}

	return { attribute: taxonomy, attribute_term: terms.join( ',' ) };
}

/**
 * Variations: the `attributes` list param of the variations endpoint, by
 * slug. Null while the slugs are not known yet (the terms have not
 * loaded): the caller loads them and asks again.
 */
export function attributeVariationFilter( taxonomy: string, value: unknown, operator: Filter[ 'operator' ] ): { attribute: string; terms: string[] } | null | undefined {
	const terms = ids( value );

	if ( ! terms.length || ( operator !== 'isAny' && operator !== 'is' ) ) {
		return undefined;
	}

	const slugs = termSlugs( taxonomy, terms );

	return slugs ? { attribute: taxonomy, terms: slugs } : null;
}

export function createAttributeFilters( settings: Settings ): ProductField[] {
	return ( settings.taxonomies ?? [] )
		.filter( ( taxonomy ) => taxonomy.attribute )
		.map( ( taxonomy ) => {
			const base = field( {
				id: ATTRIBUTE_FIELD_PREFIX + taxonomy.name,
				type: 'array',
				/* translators: %s: an attribute name ("Colour") */
				label: sprintf( __( 'Attribute: %s', 'wp-woocommerce-products-list' ), taxonomy.label ),
				filterBy: { operators: [ 'isAny' ] },
				getElements: () => termElements( taxonomy.name ),
				readOnly: true,
				enableSorting: false,
				enableGlobalSearch: false,
				enableHiding: false,
				filterOnly: true,
				render: () => null,
				getValue: () => undefined,
				rest: { fields: [], applies: { product: true, variation: false } },
				edit: false,
			} );

			return {
				...base,
				rest: {
					...base.rest,
					toParams: ( value: unknown, operator: Filter[ 'operator' ] ) => attributeProductParams( taxonomy.name, value, operator ),
				},
			} as ProductField;
		} );
}
