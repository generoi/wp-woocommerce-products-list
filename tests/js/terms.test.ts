import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMS_STORAGE_PREFIX, TERMS_STORAGE_TTL, clearTermElements, readStoredTerms, termElements } from '../../resources/fields/terms';

const getTerms = vi.fn();

vi.mock( '../../resources/api/client', () => ( {
	getTerms: ( ...args: unknown[] ) => getTerms( ...args ),
} ) );

beforeEach( () => {
	getTerms.mockReset();
	window.sessionStorage.clear();
} );

afterEach( () => clearTermElements() );

describe( 'termElements', () => {
	it( 'pages through the taxonomy once and stores the list for the next page load', async () => {
		getTerms
			.mockResolvedValueOnce( { items: [ { id: 155, name: 'Affenzahn' } ], total: 2, totalPages: 2 } )
			.mockResolvedValueOnce( { items: [ { id: 7, name: 'Froddo' } ], total: 2, totalPages: 2 } );

		const terms = await termElements( 'product_brand' );

		expect( terms ).toEqual( [ { value: 155, label: 'Affenzahn' }, { value: 7, label: 'Froddo' } ] );
		expect( getTerms ).toHaveBeenCalledTimes( 2 );
		expect( await termElements( 'product_brand' ) ).toBe( terms );
		expect( readStoredTerms( 'product_brand' ) ).toEqual( terms );
	} );

	it( 'answers from a fresh stored copy without a request, and ignores a stale one', async () => {
		const stored = [ { value: 155, label: 'Affenzahn' } ];
		window.sessionStorage.setItem( TERMS_STORAGE_PREFIX + 'product_brand', JSON.stringify( { at: Date.now(), terms: stored } ) );

		expect( await termElements( 'product_brand' ) ).toEqual( stored );
		expect( getTerms ).not.toHaveBeenCalled();

		clearTermElements( 'product_brand' );
		expect( readStoredTerms( 'product_brand' ) ).toBeNull();

		window.sessionStorage.setItem( TERMS_STORAGE_PREFIX + 'product_cat', JSON.stringify( { at: Date.now() - TERMS_STORAGE_TTL - 1, terms: stored } ) );
		getTerms.mockResolvedValueOnce( { items: [ { id: 1, name: 'Boots' } ], total: 1, totalPages: 1 } );

		expect( await termElements( 'product_cat' ) ).toEqual( [ { value: 1, label: 'Boots' } ] );
		expect( getTerms ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'forgets a failed fetch so the next call retries', async () => {
		getTerms.mockRejectedValueOnce( new Error( 'down' ) ).mockResolvedValueOnce( { items: [], total: 0, totalPages: 1 } );

		await expect( termElements( 'product_tag' ) ).rejects.toThrow( 'down' );
		expect( await termElements( 'product_tag' ) ).toEqual( [] );
	} );
} );
