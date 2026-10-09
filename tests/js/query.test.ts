import { addFilter, removeFilter } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProductListQuery, buildVariationsQuery, fieldsParam, filterToParams } from '../../resources/api/query';
import type { View } from '../../resources/dataviews';
import { createProductFields } from '../../resources/fields/registry';
import { setSettings } from '../../resources/settings';
import type { ProductField } from '../../resources/types';
import { sampleSettings } from './settings.test';

const settings = sampleSettings( { features: { cogs: false, brands: true, reviews: true, hardDelete: false } } );

function view( overrides: Partial< View > = {} ): View {
	return { type: 'table', page: 1, perPage: 20, titleField: 'name', mediaField: 'images', fields: [ 'sku', 'price' ], ...overrides } as View;
}

describe( 'buildProductListQuery', () => {
	let fields: ProductField[];

	beforeEach( () => {
		setSettings( settings );
		fields = createProductFields( settings );
	} );

	afterEach( () => setSettings( undefined ) );

	it( 'requests the fixed core keys plus what the visible columns read', () => {
		const query = buildProductListQuery( view(), 'all', fields, settings );

		expect( query._fields ).toBe( 'date_on_sale_from,date_on_sale_from_gmt,date_on_sale_to,featured,id,images,name,on_sale,parent_id,permalink,price,regular_price,sale_price,sku,status,type,wc_products_list' );
		expect( query.image_size ).toBe( 'thumbnail' );
		expect( query.per_page ).toBe( 20 );
		expect( query.page ).toBe( 1 );
	} );

	it( 'leaves hidden columns out and never exceeds the per_page cap', () => {
		const query = buildProductListQuery( view( { fields: [], showMedia: false, perPage: 500, page: 3 } ), 'all', fields, settings );

		expect( query._fields ).toBe( 'featured,id,name,parent_id,permalink,status,type,wc_products_list' );
		expect( query.per_page ).toBe( 100 );
		expect( query.page ).toBe( 3 );
	} );

	it( 'maps the status tab', () => {
		expect( buildProductListQuery( view(), 'all', fields, settings ) ).toMatchObject( { tab: 'all', include_status: 'publish,draft,pending,private,future' } );
		expect( buildProductListQuery( view(), 'draft', fields, settings ) ).toMatchObject( { tab: 'draft', status: 'draft' } );
		expect( buildProductListQuery( view(), 'trash', fields, settings ).include_status ).toBeUndefined();
	} );

	it( 'searches name or SKU', () => {
		const query = buildProductListQuery( view( { search: '  saga 42 ' } ), 'all', fields, settings );

		expect( query.search_name_or_sku ).toBe( 'saga 42' );
		expect( query.search ).toBeUndefined();
		expect( buildProductListQuery( view( { search: '' } ), 'all', fields, settings ).search_name_or_sku ).toBeUndefined();
	} );

	it( 'maps sorting to the wc/v3 orderby values', () => {
		expect( buildProductListQuery( view( { sort: { field: 'name', direction: 'asc' } } ), 'all', fields, settings ) ).toMatchObject( { orderby: 'title', order: 'asc' } );
		expect( buildProductListQuery( view( { sort: { field: 'date_created', direction: 'desc' } } ), 'all', fields, settings ) ).toMatchObject( { orderby: 'date', order: 'desc' } );
		expect( buildProductListQuery( view( { sort: { field: 'sku', direction: 'desc' } } ), 'all', fields, settings ) ).toMatchObject( { orderby: 'sku', order: 'desc' } );
		expect( buildProductListQuery( view( { sort: { field: 'stock_quantity', direction: 'asc' } } ), 'all', fields, settings ) ).toMatchObject( { orderby: 'stock_quantity' } );
		expect( buildProductListQuery( view( { sort: { field: 'images', direction: 'asc' } } ), 'all', fields, settings ).orderby ).toBeUndefined();
	} );

	it( 'maps filters through each field rest.param', () => {
		const query = buildProductListQuery(
			view( {
				filters: [
					{ field: 'categories', operator: 'isAny', value: [ 12, 14 ] },
					{ field: 'tags', operator: 'isNone', value: [ 3 ] },
					{ field: 'brands', operator: 'isAny', value: [ 140 ] },
					{ field: 'type', operator: 'isAny', value: [ 'variable' ] },
					{ field: 'stock_status', operator: 'is', value: 'instock' },
					{ field: 'featured', operator: 'is', value: true },
					{ field: 'on_sale', operator: 'is', value: 'false' },
					{ field: 'price', operator: 'between', value: [ 10, 200 ] },
					{ field: 'stock_quantity', operator: 'lessThanOrEqual', value: 5 },
					{ field: 'date_created', operator: 'after', value: '2026-01-01T00:00:00' },
					{ field: 'unknown', operator: 'is', value: 'x' },
				],
			} ),
			'all',
			fields,
			settings
		);

		expect( query ).toMatchObject( {
			category: '12,14',
			exclude_tag: '3',
			brand: '140',
			include_types: 'variable',
			stock_status: 'instock',
			featured: true,
			on_sale: false,
			min_price: 10,
			max_price: 200,
			max_stock_quantity: 5,
			after: '2026-01-01T00:00:00',
		} );
		expect( query.unknown ).toBeUndefined();
	} );

	it( 'uses a declarative filter option params', () => {
		const withFilter = sampleSettings( {
			filters: [
				{
					id: 'translation',
					label: 'Translation',
					type: 'select',
					param: null,
					options: [ { value: 'missing:se', label: 'Missing in Svenska', params: { 'gds_i18n[lang]': 'se', 'gds_i18n[status]': 'missing' } } ],
					operators: [ 'is' ],
					isPrimary: true,
					multiple: false,
					variations: true,
					order: 10,
					source: 'gds-woo-i18n',
				},
			],
		} );
		setSettings( withFilter );
		const extended = createProductFields( withFilter );
		const query = buildProductListQuery( view( { filters: [ { field: 'translation', operator: 'is', value: 'missing:se' } ] } ), 'all', extended, withFilter );

		expect( query[ 'gds_i18n[lang]' ] ).toBe( 'se' );
		expect( query[ 'gds_i18n[status]' ] ).toBe( 'missing' );
	} );

	it( 'runs the wcProductsList.query filter last', () => {
		addFilter( 'wcProductsList.query', 'test', ( params: Record< string, unknown >, context: { tab: string } ) => ( { ...params, gds_i18n_langs: 'se', seenTab: context.tab } ) );

		try {
			expect( buildProductListQuery( view(), 'publish', fields, settings ) ).toMatchObject( { gds_i18n_langs: 'se', seenTab: 'publish' } );
		} finally {
			removeFilter( 'wcProductsList.query', 'test' );
		}
	} );

	it( 'drops empty values', () => {
		const field = fields.find( ( f ) => f.id === 'categories' ) as ProductField;

		expect( filterToParams( { field: 'categories', operator: 'isAny', value: [] }, field ) ).toEqual( {} );
		expect( filterToParams( { field: 'categories', operator: 'isAny', value: [] }, undefined ) ).toEqual( {} );
		expect( fieldsParam( view( { fields: [] } ), fields ) ).toContain( 'wc_products_list' );
	} );

	it( 'asks for the SKU while searching, so a variation SKU match can be told apart', () => {
		expect( fieldsParam( view( { fields: [] } ), fields ).split( ',' ) ).not.toContain( 'sku' );
		expect( fieldsParam( view( { fields: [], search: '8585055472542' } ), fields ).split( ',' ) ).toContain( 'sku' );
	} );
} );

describe( 'buildVariationsQuery', () => {
	beforeEach( () => setSettings( settings ) );
	afterEach( () => setSettings( undefined ) );

	it( 'asks for 100 per page and only the keys variations have', () => {
		const fields = createProductFields( settings );
		const query = buildVariationsQuery( 40223, 2, fields, settings, view( { fields: [ 'sku', 'price', 'categories', 'stock_status' ] } ) );

		expect( query ).toMatchObject( { page: 2, per_page: 100, image_size: 'thumbnail' } );
		expect( String( query._fields ).split( ',' ) ).toEqual( expect.arrayContaining( [ 'id', 'attributes', 'image', 'sku', 'price', 'stock_status', 'wc_products_list' ] ) );
		expect( query._fields ).not.toContain( 'categories' );
		expect( query._fields ).not.toContain( 'images' );
	} );

	it( 'runs the wcProductsList.variationsQuery filter', () => {
		addFilter( 'wcProductsList.variationsQuery', 'test', ( params: Record< string, unknown >, context: { parentId: number } ) => ( { ...params, parent: context.parentId } ) );

		try {
			expect( buildVariationsQuery( 7, 1, [], settings ).parent ).toBe( 7 );
		} finally {
			removeFilter( 'wcProductsList.variationsQuery', 'test' );
		}
	} );
} );

describe( 'core request fields', () => {
	beforeEach( () => setSettings( settings ) );
	afterEach( () => setSettings( undefined ) );

	it( 'always asks products for `featured` (the feature actions decide on it) and never variations', () => {
		const fields = createProductFields( settings );

		expect( buildProductListQuery( view( { fields: [] } ), 'all', fields, settings )._fields ).toContain( 'featured' );
		expect( String( buildVariationsQuery( 1, 1, fields, settings, view( { fields: [] } ) )._fields ).split( ',' ) ).not.toContain( 'featured' );
		expect( String( buildVariationsQuery( 1, 1, fields, settings )._fields ).split( ',' ) ).not.toContain( 'featured' );
	} );
} );
