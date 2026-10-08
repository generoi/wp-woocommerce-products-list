import { describe, expect, it, vi } from 'vitest';
import { editFetchFields, hydrateItems, hydrateSelection, tabFetchFields } from '../../resources/edit/hydrate';
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
		// `status` rides along: a row trashed since the list loaded is told apart from one picked on the Trash tab.
		expect( d.listProducts.mock.calls[ 0 ]![ 0 ] ).toMatchObject( { include: '2,1', per_page: 2, _fields: 'id,regular_price,status' } );
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

describe( 'hydrateSelection merging', () => {
	it( 'merges nested objects key by key, so a partial i18n fetch keeps the name the list shows', async () => {
		const cached = product( { id: 1, i18n: { se: { name: { value: 'Ullsockor', source: 'Villasukat' } } }, dimensions: { length: '1', width: '2' } } );
		const listProducts = vi.fn( async () => ( {
			items: [ product( { id: 1, i18n: { se: { meta_title: { value: '', source: '' } }, de: { meta_title: { value: 'T', source: '' } } }, dimensions: { length: '5', width: '2', height: '3' }, categories: [ { id: 9 } ] } ) ],
			total: 0,
			totalPages: 1,
		} ) );
		const deps = { listProducts, getVariations: vi.fn() } as unknown as HydrateDeps;

		const { items } = await hydrateSelection( [ cached ], [ 'id', 'i18n.se.meta_title' ], deps );
		const row = items[ 0 ] as unknown as { i18n: Record< string, Record< string, unknown > >; dimensions: Record< string, string >; categories: unknown[] };

		expect( row.i18n.se ).toEqual( { name: { value: 'Ullsockor', source: 'Villasukat' }, meta_title: { value: '', source: '' } } );
		expect( row.i18n.de ).toEqual( { meta_title: { value: 'T', source: '' } } );
		expect( row.dimensions ).toEqual( { length: '5', width: '2', height: '3' } );
		// Arrays and scalars are replaced, not merged.
		expect( row.categories ).toEqual( [ { id: 9 } ] );
	} );

	it( 'names the rows trashed since the list loaded, and leaves rows picked on the Trash tab alone', async () => {
		const listProducts = vi.fn( async ( query: Record< string, unknown > ) => ( {
			items: String( query.include )
				.split( ',' )
				.map( ( id ) => product( { id: Number( id ), status: id === '3' ? 'publish' : 'trash' } ) ),
			total: 0,
			totalPages: 1,
		} ) );
		const deps = { listProducts, getVariations: vi.fn() } as unknown as HydrateDeps;

		const { trashed, missing } = await hydrateSelection( [ product( { id: 1, status: 'publish' } ), product( { id: 2, status: 'trash' } ), product( { id: 3, status: 'publish' } ) ], [ 'id', 'name' ], deps );

		expect( trashed ).toEqual( [ 1 ] );
		expect( missing ).toEqual( [] );
		expect( listProducts.mock.calls[ 0 ]?.[ 0 ] ).toMatchObject( { _fields: 'id,name,status' } );
	} );
} );

describe( 'per-tab field lists', () => {
	it( 'loads one tab at a time: the General load has no language fields, the language tab only its own', () => {
		const items = [ product( { id: 1 } ) ];
		const general = editFetchFields( fields, items, 'quick', { tab: 'general' } );
		const all = editFetchFields( fields, items, 'quick' );

		expect( general ).toContain( 'regular_price' );
		expect( general ).toContain( 'description' );
		expect( general.some( ( key ) => key.startsWith( 'i18n' ) ) ).toBe( false );
		expect( all.length ).toBeGreaterThanOrEqual( general.length );

		const se = tabFetchFields( fields, items, 'quick', { id: 'i18n:se', label: 'Svenska' } );

		// The core registry has no language fields of its own; the i18n integration adds them.
		expect( se ).toEqual( [] );
		expect( tabFetchFields( fields, items, 'quick', { id: 'general', label: 'General' } ) ).toContain( 'regular_price' );
	} );
} );
