import { describe, expect, it, vi } from 'vitest';
import { carriesViewText, editFetchFields, hydrateItems, hydrateSelection, readContextOf, tabFetchFields } from '../../resources/edit/hydrate';
import type { HydrateDeps } from '../../resources/edit/hydrate';
import type { ProductField, ProductListItem } from '../../resources/types';
import { createCoreFields } from '../../resources/fields/registry';
import { editSettings, field, simple, variation as variationRow } from './edit-fixtures';

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
		// Bulk never edits the SKU or long text; the SKU comes along only to tell the rows apart in the item list.
		expect( bulk ).toContain( 'sku' );
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

	it( 'loads the descriptions in edit context (raw, as stored), and nothing else', async () => {
		const d = deps();
		const across = vi.fn( async ( ids: number[], parentOf: ReadonlyMap< number, number >, _options: { context?: string } ) => ids.map( ( id ) => variation( { id, parent_id: parentOf.get( id ) ?? 0 } ) ) );
		const rows: ProductListItem[] = [ product( { id: 2 } ), variation( { id: 11, parent_id: 1 } ) ];

		await hydrateSelection( rows, [ 'id', 'description' ], { ...d, getVariationsByIds: across } as HydrateDeps );
		await hydrateSelection( rows, [ 'id', 'regular_price' ], { ...d, getVariationsByIds: across } as HydrateDeps );
		await hydrateSelection( [ variation( { id: 11, parent_id: 1 } ) ], [ 'id', 'short_description' ], d );

		expect( d.listProducts.mock.calls[ 0 ]![ 0 ] ).toMatchObject( { context: 'edit' } );
		expect( across.mock.calls[ 0 ]![ 2 ] ).toMatchObject( { context: 'edit' } );
		expect( d.listProducts.mock.calls[ 1 ]![ 0 ] ).not.toHaveProperty( 'context' );
		expect( across.mock.calls[ 1 ]![ 2 ]!.context ).toBeUndefined();
		expect( d.getVariations.mock.calls[ 0 ]![ 2 ].params ).toMatchObject( { include: '11', context: 'edit' } );
	} );

	it( 'tells which reads and which saved rows concern the raw texts', () => {
		expect( readContextOf( [ 'id', 'description' ] ) ).toBe( 'edit' );
		expect( readContextOf( [ 'id', 'name', 'i18n.se.short_description' ] ) ).toBeUndefined();
		expect( carriesViewText( { id: 1, short_description: '<p>x</p>' } ) ).toBe( true );
		expect( carriesViewText( { id: 1, regular_price: '5' } ) ).toBe( false );
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

describe( 'a language tab in bulk edit', () => {
	it( 'loads the market prices with the tab, although they are no bulk field, so the price tool sees the sale price', () => {
		// gds-woo-i18n: market prices are `bulk: false` (changed with "Adjust market prices"), the name is a bulk field.
		const i18n = [
			field( 'i18n:se.name', { edit: { group: 'i18n:se', bulk: 'default' }, rest: { fields: [ 'i18n.se.name' ], applies: { product: true, variation: true } } } ),
			field( 'i18n:se.regular_price', { edit: { group: 'i18n:se', bulk: false }, rest: { fields: [ 'i18n.se.regular_price' ], applies: { product: true, variation: true } } } ),
			field( 'i18n:se.sale_price', { edit: { group: 'i18n:se', bulk: false }, rest: { fields: [ 'i18n.se.sale_price' ], applies: { product: true, variation: true } } } ),
		];
		const items = [ product( { id: 1 } ), product( { id: 2 } ) ];
		const tab = { id: 'i18n:se', label: 'Svenska' };

		expect( tabFetchFields( [ ...fields, ...i18n ], items, 'bulk', tab ) ).toEqual( expect.arrayContaining( [ 'id', 'i18n.se.regular_price', 'i18n.se.sale_price' ] ) );
		expect( tabFetchFields( [ ...fields, ...i18n ], items, 'bulk', { id: 'general', label: 'General' } ) ).not.toContain( 'i18n.se.sale_price' );
	} );
} );

describe( 'mergeHydrated with an empty answer', () => {
	it( 'keeps an object the row holds when the server sends [] or null for it', async () => {
		const { mergeHydrated } = await import( '../../resources/edit/hydrate' );
		const cached = { id: 1, i18n: { se: { name: { value: 'Ullsockor' } } } };

		expect( mergeHydrated( cached, { i18n: [] } ).i18n ).toEqual( cached.i18n );
		expect( mergeHydrated( cached, { i18n: null } ).i18n ).toEqual( cached.i18n );
		expect( mergeHydrated( { id: 1, tags: [ 'a' ] }, { tags: [] } ).tags ).toEqual( [] );
	} );
} );

describe( 'mergeHydrated with a translated value', () => {
	it( 'replaces a value entry whole: a "copied" flag the fresh value lacks does not survive', async () => {
		const { mergeHydrated } = await import( '../../resources/edit/hydrate' );
		const cached = { id: 1, i18n: { se: { name: { value: 'Ullsocka', source: 'Wool sock', same: true, copiedFrom: 'no' }, short_description: { value: 'Kort' } } } };
		const merged = mergeHydrated( cached, { i18n: { se: { name: { value: 'Yllesocka', source: 'Wool sock' } } } } );

		expect( merged.i18n.se.name ).toEqual( { value: 'Yllesocka', source: 'Wool sock' } );
		// The other fields of the language stay: only the entry is replaced.
		expect( merged.i18n.se.short_description ).toEqual( { value: 'Kort' } );
	} );
} );
