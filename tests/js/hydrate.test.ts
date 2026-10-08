import { describe, expect, it, vi } from 'vitest';
import { editFetchFields, hydrateItems } from '../../resources/edit/hydrate';
import type { HydrateDeps } from '../../resources/edit/hydrate';
import type { ProductField, ProductListItem } from '../../resources/types';
import { createCoreFields } from '../../resources/fields/registry';
import { editSettings, simple, variation as variationRow } from './edit-fixtures';

const fields: ProductField[] = createCoreFields( editSettings() );
const product = ( props: { id: number } & Record< string, unknown > ) => simple( props.id, props );
const variation = ( props: { id: number; parent_id: number } & Record< string, unknown > ) => variationRow( props.id, props.parent_id, props );

describe( 'editFetchFields', () => {
	it( 'always carries the base keys and both prices', () => {
		const keys = editFetchFields( fields, [ product( { id: 1 } ) ], 'quick' );

		expect( keys ).toEqual( expect.arrayContaining( [ 'id', 'type', 'status', 'parent_id', 'wc_products_list', 'name', 'price', 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to' ] ) );
	} );

	it( 'asks for the editable fields of the selection, not every column', () => {
		const quick = editFetchFields( fields, [ product( { id: 1 } ) ], 'quick' );
		const bulk = editFetchFields( fields, [ product( { id: 1 } ), product( { id: 2 } ) ], 'bulk' );

		expect( quick ).toContain( 'description' );
		expect( quick ).toContain( 'sku' );
		// Bulk never edits the SKU or long text.
		expect( bulk ).not.toContain( 'sku' );
		expect( bulk ).not.toContain( 'description' );
		expect( bulk ).toContain( 'stock_quantity' );
		expect( quick ).not.toContain( 'images' );
	} );
} );

describe( 'hydrateItems', () => {
	function deps() {
		const listProducts = vi.fn( async ( query: Record< string, unknown > ) => ( {
			items: String( query.include )
				.split( ',' )
				.map( ( id ) => product( { id: Number( id ), regular_price: '100', description: 'full' } ) ),
			total: 0,
			totalPages: 1,
		} ) );
		const getVariations = vi.fn( async ( parentId: number, _page: number, options: { params?: Record< string, unknown > } ) => ( {
			items: String( options.params?.include )
				.split( ',' )
				.map( ( id ) => variation( { id: Number( id ), parent_id: parentId, regular_price: '50' } ) ),
			total: 0,
			totalPages: 1,
		} ) );

		return { listProducts, getVariations } as unknown as HydrateDeps & { listProducts: ReturnType< typeof vi.fn >; getVariations: ReturnType< typeof vi.fn > };
	}

	it( 'reloads products in one request and variations per parent, keeping row order and hierarchy keys', async () => {
		const d = deps();
		const rows: ProductListItem[] = [
			variation( { id: 11, parent_id: 1 } ),
			product( { id: 2 } ),
			variation( { id: 12, parent_id: 1 } ),
			variation( { id: 21, parent_id: 3 } ),
			product( { id: 1 } ),
		];

		const result = await hydrateItems( rows, [ 'id', 'regular_price' ], d );

		expect( result.map( ( row ) => row.id ) ).toEqual( [ 11, 2, 12, 21, 1 ] );
		expect( d.listProducts ).toHaveBeenCalledTimes( 1 );
		expect( d.listProducts.mock.calls[ 0 ]![ 0 ] ).toMatchObject( { include: '2,1', per_page: 2, _fields: 'id,regular_price' } );
		expect( d.getVariations ).toHaveBeenCalledTimes( 2 );
		expect( d.getVariations.mock.calls.map( ( call ) => [ call[ 0 ], call[ 2 ].params.include ] ) ).toEqual( [ [ 1, '11,12' ], [ 3, '21' ] ] );
		expect( ( result[ 1 ] as { regular_price?: string } ).regular_price ).toBe( '100' );
		expect( ( result[ 0 ] as { regular_price?: string } ).regular_price ).toBe( '50' );
		expect( result[ 0 ]!._level ).toBe( rows[ 0 ]!._level );
		expect( result[ 0 ]!._kind ).toBe( 'variation' );
	} );

	it( 'chunks products by a hundred and keeps rows the server did not return', async () => {
		const d = deps();
		d.listProducts.mockImplementation( async ( query: Record< string, unknown > ) => ( {
			items: String( query.include )
				.split( ',' )
				.filter( ( id ) => id !== '7' )
				.map( ( id ) => product( { id: Number( id ), regular_price: '1' } ) ),
			total: 0,
			totalPages: 1,
		} ) );
		const rows = Array.from( { length: 150 }, ( _, i ) => product( { id: i + 1 } ) );

		const result = await hydrateItems( rows, [ 'id' ], d );

		expect( d.listProducts ).toHaveBeenCalledTimes( 2 );
		expect( result ).toHaveLength( 150 );
		expect( ( result[ 6 ] as { regular_price?: string } ).regular_price ).toBe( ( rows[ 6 ] as { regular_price?: string } ).regular_price );
		expect( ( result[ 7 ] as { regular_price?: string } ).regular_price ).toBe( '1' );
	} );
} );
