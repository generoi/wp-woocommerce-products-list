import { describe, expect, it } from 'vitest';
import { footerCountLabel } from '../../resources/hierarchy/footer-count';
import type { ProductListItem } from '../../resources/types/product';

function product( id: number ): ProductListItem {
	return { id, _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0 } as unknown as ProductListItem;
}

function variation( id: number, parentId: number, placeholder?: string ): ProductListItem {
	return { id, _kind: 'variation', _level: 1, _parentId: parentId, _hasChildren: false, _childCount: 0, ...( placeholder ? { _placeholder: placeholder } : {} ) } as unknown as ProductListItem;
}

describe( 'footerCountLabel', () => {
	it( 'counts products on the page against the total and variations apart', () => {
		const data = [ ...Array.from( { length: 100 }, ( _, i ) => product( i + 1 ) ), ...Array.from( { length: 36 }, ( _, i ) => variation( 1000 + i, 1 ) ) ];

		expect( footerCountLabel( { data, selection: [], totalItems: 855 } ) ).toBe( '100 of 855 products · 36 variations shown' );
	} );

	it( 'never counts placeholder rows', () => {
		const data = [ product( 1 ), product( 2 ), variation( 0, 1, 'loading' ) ];

		expect( footerCountLabel( { data, selection: [], totalItems: 855 } ) ).toBe( '2 of 855 products' );
	} );

	it( 'splits a selection by kind', () => {
		const data = [ product( 1 ), product( 2 ), product( 3 ), variation( 11, 1 ), variation( 12, 1 ) ];

		expect( footerCountLabel( { data, selection: [ '1', '2', '3', '11', '12' ], totalItems: 855 } ) ).toBe( '5 selected (3 products, 2 variations)' );
		expect( footerCountLabel( { data, selection: [ '1' ], totalItems: 855 } ) ).toBe( '1 selected' );
	} );

	it( 'shows the plain total on the last page', () => {
		const data = Array.from( { length: 855 }, ( _, i ) => product( i + 1 ) );

		expect( footerCountLabel( { data, selection: [], totalItems: 855 } ) ).toBe( '855 products' );
	} );
} );
