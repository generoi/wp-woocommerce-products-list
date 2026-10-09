import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { normalizeProduct, normalizeVariation } from '../../resources/hierarchy/normalize';
import { MAX_SEARCH_EXPANDS, parentsMatchedByVariations, searchTokens, useSearchReveal, variationSearchMatches } from '../../resources/hierarchy/search-match';
import type { ProductListItem, ProductRow } from '../../resources/types';

function parent( id: number, name: string, sku = '', count = 24 ): ProductRow {
	return normalizeProduct( { id, type: 'variable', name, sku, wc_products_list: { variation_count: count, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 } } );
}

const icono = parent( 42857, 'Be Lenka Icono', 'BL-ICONO' );
const simple = normalizeProduct( { id: 5, type: 'simple', name: 'Socks', sku: '8585055472542-S' } );
const variations = [ normalizeVariation( { id: 29755, sku: '8585055472535' }, icono ), normalizeVariation( { id: 29756, sku: '8585055472542' }, icono ) ];

describe( 'search-match', () => {
	it( 'splits the search into lowercase tokens', () => {
		expect( searchTokens( '  Lenka   ICONO ' ) ).toEqual( [ 'lenka', 'icono' ] );
		expect( searchTokens( undefined ) ).toEqual( [] );
	} );

	it( 'expands only the variable parents that matched through a variation', () => {
		expect( parentsMatchedByVariations( [ icono ], searchTokens( '8585055472542' ) ) ).toEqual( [ 42857 ] );
		// The parent's own name or SKU matched: nothing to open.
		expect( parentsMatchedByVariations( [ icono ], searchTokens( 'lenka' ) ) ).toEqual( [] );
		expect( parentsMatchedByVariations( [ icono ], searchTokens( 'bl-icono' ) ) ).toEqual( [] );
		expect( parentsMatchedByVariations( [ simple as ProductRow ], searchTokens( '8585055472542' ) ) ).toEqual( [] );
	} );

	it( 'marks the variations whose SKU carries a token the parent does not', () => {
		const rows: ProductListItem[] = [ icono, ...variations ];

		expect( Array.from( variationSearchMatches( rows, searchTokens( '8585055472542' ) ) ) ).toEqual( [ 29756 ] );
		expect( Array.from( variationSearchMatches( rows, searchTokens( 'lenka 8585055472535' ) ) ) ).toEqual( [ 29755 ] );
		expect( variationSearchMatches( rows, [] ).size ).toBe( 0 );
	} );

	it( 'expands the matched parents once per search and reveals the first match', () => {
		const expand = vi.fn( async () => {} );
		const reveal = vi.fn();
		const parents = [ icono, ...Array.from( { length: 15 }, ( _, i ) => parent( 100 + i, `Other ${ i }` ) ) ];
		const props = { search: '8585055472542', parents, rows: parents as ProductListItem[], isFetching: false, isExpanded: () => false, expand, reveal };

		const { rerender } = renderHook( ( p ) => useSearchReveal( p ), { initialProps: props } );

		expect( expand ).toHaveBeenCalledTimes( MAX_SEARCH_EXPANDS );
		expect( expand ).toHaveBeenCalledWith( 42857 );
		expect( reveal ).not.toHaveBeenCalled();

		// The variations arrive: the match is revealed once; a collapse later is not undone.
		const rows = [ icono, ...variations ];
		rerender( { ...props, rows } );
		expect( reveal ).toHaveBeenCalledTimes( 1 );
		expect( reveal.mock.calls[ 0 ]?.[ 0 ] ).toMatchObject( { id: 29756 } );

		rerender( { ...props, rows: [ icono ] } );
		expect( expand ).toHaveBeenCalledTimes( MAX_SEARCH_EXPANDS );
	} );

	it( 'waits for the list to settle and does nothing without a search', () => {
		const expand = vi.fn( async () => {} );
		const props = { search: '8585055472542', parents: [ icono ], rows: [ icono ] as ProductListItem[], isFetching: true, isExpanded: () => false, expand, reveal: vi.fn() };
		const { rerender } = renderHook( ( p ) => useSearchReveal( p ), { initialProps: props } );

		expect( expand ).not.toHaveBeenCalled();
		rerender( { ...props, search: '', isFetching: false } );
		expect( expand ).not.toHaveBeenCalled();
	} );
} );
