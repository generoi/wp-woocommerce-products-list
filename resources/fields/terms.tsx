/**
 * The taxonomy columns (categories, tags, brands): names in the table, ids
 * for filters and edits. Elements load lazily from the terms endpoint and
 * are cached per taxonomy; the filter sends term ids.
 */
import { __ } from '@wordpress/i18n';
import { getTerms } from '../api/client';
import type { Option } from '../dataviews';
import type { ProductField, RawTerm, Settings } from '../types';
import { TermsCell } from './components/terms-cell';
import { field, valueOf } from './helpers';

const termCache = new Map< string, Promise< Option[] > >();

export const TERMS_STORAGE_PREFIX = 'wcProductsList.terms.';

/** How long a stored term list serves filter chips before it is fetched again (ms). */
export const TERMS_STORAGE_TTL = 60 * 1000;

interface StoredTerms {
	at: number;
	terms: Option[];
}

function storage(): Pick< Storage, 'getItem' | 'setItem' | 'removeItem' > | null {
	try {
		return typeof window !== 'undefined' ? window.sessionStorage : null;
	} catch {
		return null;
	}
}

export function readStoredTerms( taxonomy: string, now: number = Date.now() ): Option[] | null {
	try {
		const raw = storage()?.getItem( TERMS_STORAGE_PREFIX + taxonomy );
		const parsed = raw ? ( JSON.parse( raw ) as StoredTerms ) : null;

		if ( ! parsed || ! Array.isArray( parsed.terms ) || typeof parsed.at !== 'number' || now - parsed.at > TERMS_STORAGE_TTL ) {
			return null;
		}

		return parsed.terms;
	} catch {
		return null;
	}
}

function storeTerms( taxonomy: string, terms: Option[] ): void {
	try {
		storage()?.setItem( TERMS_STORAGE_PREFIX + taxonomy, JSON.stringify( { at: Date.now(), terms } satisfies StoredTerms ) );
	} catch {
		// Full or unavailable store: the next load fetches again.
	}
}

async function fetchTermElements( taxonomy: string ): Promise< Option[] > {
	const out: Option[] = [];
	let page = 1;
	let totalPages = 1;

	do {
		const result = await getTerms( taxonomy, { page, perPage: 100 } );
		out.push( ...result.items.map( ( term ) => ( { value: term.id, label: term.name } ) ) );
		totalPages = result.totalPages;
		page += 1;
	} while ( page <= totalPages && page <= 20 );

	return out;
}

/**
 * All terms of a taxonomy as `{value: id, label}` (paged to the end, cached
 * per page load). A copy younger than TERMS_STORAGE_TTL in sessionStorage
 * answers at once, so a filter chip restored from the URL shows the term's
 * name instead of its id while the list loads.
 */
export function termElements( taxonomy: string ): Promise< Option[] > {
	let promise = termCache.get( taxonomy );

	if ( ! promise ) {
		const stored = readStoredTerms( taxonomy );

		promise = stored
			? Promise.resolve( stored )
			: fetchTermElements( taxonomy )
					.then( ( terms ) => {
						storeTerms( taxonomy, terms );

						return terms;
					} )
					.catch( ( error ) => {
						termCache.delete( taxonomy );
						throw error;
					} );
		termCache.set( taxonomy, promise );
	}

	return promise;
}

export function clearTermElements( taxonomy?: string ): void {
	const store = storage();

	if ( taxonomy ) {
		termCache.delete( taxonomy );
		store?.removeItem( TERMS_STORAGE_PREFIX + taxonomy );
	} else {
		for ( const key of Array.from( termCache.keys() ) ) {
			store?.removeItem( TERMS_STORAGE_PREFIX + key );
		}

		termCache.clear();
	}
}

interface TermsFieldSpec {
	id: 'categories' | 'tags' | 'brands';
	taxonomy: string;
	label: string;
	param: string;
	order: number;
}

function termsField( spec: TermsFieldSpec ): ProductField {
	return field( {
		id: spec.id,
		type: 'array',
		label: spec.label,
		enableSorting: false,
		filterBy: { operators: [ 'isAny', 'isNone' ] },
		getElements: () => termElements( spec.taxonomy ),
		render: ( { item } ) => <TermsCell terms={ valueOf( item, spec.id ) as RawTerm[] | undefined } />,
		getValue: ( { item } ) => ( ( valueOf( item, spec.id ) as RawTerm[] | undefined ) ?? [] ).map( ( term ) => term.id ),
		rest: {
			param: spec.param,
			// wc/v3 takes `[{id}]` lists.
			write: ( value ) => ( { [ spec.id ]: ( Array.isArray( value ) ? value : [] ).map( ( id ) => ( { id: Number( id ) } ) ) } ),
			applies: { product: true, variation: false },
		},
		edit: { group: 'organization', bulk: 'default', order: spec.order },
	} );
}

export function createTermsFields( settings: Settings ): ProductField[] {
	const fields = [
		termsField( { id: 'categories', taxonomy: 'product_cat', label: __( 'Categories', 'wp-woocommerce-products-list' ), param: 'category', order: 40 } ),
		termsField( { id: 'tags', taxonomy: 'product_tag', label: __( 'Tags', 'wp-woocommerce-products-list' ), param: 'tag', order: 41 } ),
	];

	if ( settings.features.brands ) {
		fields.push( termsField( { id: 'brands', taxonomy: 'product_brand', label: __( 'Brands', 'wp-woocommerce-products-list' ), param: 'brand', order: 42 } ) );
	}

	return fields;
}
