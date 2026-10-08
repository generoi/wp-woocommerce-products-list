import { addFilter, removeFilter } from '@wordpress/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatPrice, parsePrice, roundPrice } from '../../resources/fields/currency';
import { CORE_FIELD_IDS, createProductFields, fieldsForItems, getField } from '../../resources/fields/registry';
import { saleBelowRegular } from '../../resources/fields/sale-price';
import { setSettings } from '../../resources/settings';
import type { DeclarativeField, ProductListItem, ProductRow, Settings, VariationRow } from '../../resources/types';
import { sampleSettings } from './settings.test';

function product( overrides: Partial< ProductRow > = {} ): ProductRow {
	return { id: 1, type: 'simple', name: 'Vilja', _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0, ...overrides } as ProductRow;
}

function variation( overrides: Partial< VariationRow > = {} ): VariationRow {
	return { id: 11, parent_id: 2, name: '42', _kind: 'variation', _level: 1, _parentId: 2, _hasChildren: false, _childCount: 0, ...overrides } as VariationRow;
}

const declarative: DeclarativeField = {
	id: 'i18n:se.name',
	label: 'Name (Svenska)',
	type: 'text',
	description: '',
	path: 'i18n.se.name.value',
	reference: 'i18n.se.name.source',
	writeKey: 'i18n',
	writePath: 'i18n.se.name',
	editable: true,
	bulk: 'default',
	readonly: false,
	applies: { product: true, variation: false },
	options: [],
	group: 'i18n:se',
	tab: 'i18n:se',
	visible: true,
	order: 10,
	enableSorting: false,
	sortParam: null,
	restFields: [ 'i18n' ],
	filter: null,
	width: null,
	source: 'gds-woo-i18n',
};

describe( 'createProductFields', () => {
	afterEach( () => setSettings( undefined ) );

	it( 'builds the core fields with rest mapping', () => {
		const settings = sampleSettings();
		setSettings( settings );
		const fields = createProductFields( settings );
		const ids = fields.map( ( f ) => f.id );

		expect( ids.slice( 0, 6 ) ).toEqual( [ 'name', 'images', 'status', 'type', 'sku', 'price' ] );
		expect( ids ).not.toContain( 'brands' );
		expect( ids ).not.toContain( 'cost_of_goods_sold' );
		expect( CORE_FIELD_IDS ).toEqual( expect.arrayContaining( ids ) );

		const price = getField( fields, 'price' );
		expect( price?.rest ).toMatchObject( { fields: [ 'price', 'regular_price', 'sale_price', 'on_sale', 'date_on_sale_from', 'date_on_sale_from_gmt', 'date_on_sale_to' ], param: 'price', sortParam: 'price', applies: { product: true, variation: true } } );
		expect( price?.edit ).toBe( false );

		const categories = getField( fields, 'categories' );
		expect( categories?.rest.applies.variation ).toBe( false );
		expect( categories?.rest.write?.( [ 1, '2' ], product() ) ).toEqual( { categories: [ { id: 1 }, { id: 2 } ] } );
		expect( categories?.getValue?.( { item: product( { categories: [ { id: 5, name: 'Boots', slug: 'boots' } ] } ) } ) ).toEqual( [ 5 ] );

		expect( getField( fields, 'sale_price' )?.edit ).toMatchObject( { group: 'pricing', bulk: 'money' } );
		expect( getField( fields, 'stock_quantity' )?.edit ).toMatchObject( { bulk: 'integer' } );
		// The Stock column sorts by the managed quantity (the server knows orderby=stock_quantity, not stock_status).
		expect( getField( fields, 'stock_status' ) ).toMatchObject( { enableSorting: true, rest: { sortParam: 'stock_quantity' } } );
		expect( getField( fields, 'name' )?.enableHiding ).toBe( false );
		expect( fields.every( ( f ) => f.source === 'core' ) ).toBe( true );
	} );

	it( 'adds brands and cost of goods when the features are on', () => {
		const settings = sampleSettings( { features: { cogs: true, brands: true, reviews: true, hardDelete: false } } );
		setSettings( settings );
		const fields = createProductFields( settings );

		expect( getField( fields, 'brands' )?.rest.param ).toBe( 'brand' );
		expect( getField( fields, 'cost_of_goods_sold' )?.rest.write?.( '12.5', product() ) ).toEqual( { cost_of_goods_sold: { values: [ { defined_value: 12.5 } ] } } );
	} );

	it( 'merges declarative and registered fields, last definition wins, then filters', () => {
		const settings: Settings = sampleSettings( { fields: [ declarative ] } );
		setSettings( settings );

		addFilter( 'wcProductsList.fields', 'test', ( fields: Array< { id: string } >, passed: Settings ) => {
			expect( passed ).toBe( settings );

			return fields.filter( ( f ) => f.id !== 'tags' );
		} );

		try {
			const fields = createProductFields( settings );
			const i18n = getField( fields, 'i18n:se.name' );

			expect( i18n ).toBeDefined();
			expect( i18n?.rest.fields ).toEqual( [ 'i18n' ] );
			expect( i18n?.rest.read?.( { ...product(), i18n: { se: { name: { value: 'Saga', source: 'Saaga' } } } } as ProductListItem ) ).toBe( 'Saga' );
			expect( getField( fields, 'tags' ) ).toBeUndefined();
			expect( fields.filter( ( f ) => f.id === 'name' ) ).toHaveLength( 1 );
		} finally {
			removeFilter( 'wcProductsList.fields', 'test' );
		}
	} );
} );

describe( 'fieldsForItems', () => {
	const settings = sampleSettings();

	beforeEach( () => setSettings( settings ) );
	afterEach( () => setSettings( undefined ) );

	it( 'intersects the per-type field sets', () => {
		const fields = createProductFields( settings );
		const ids = ( items: ProductListItem[], mode: 'quick' | 'bulk' ) => fieldsForItems( fields, items, mode ).map( ( f ) => f.id );

		expect( ids( [ product() ], 'quick' ) ).toEqual( expect.arrayContaining( [ 'name', 'sku', 'regular_price', 'sale_price', 'stock_quantity', 'categories', 'featured' ] ) );
		expect( ids( [ product() ], 'quick' ) ).not.toContain( 'price' );
		expect( ids( [ product() ], 'quick' ) ).not.toContain( 'external_url' );

		const withVariable = ids( [ product(), product( { id: 2, type: 'variable', _hasChildren: true, _childCount: 3 } ) ], 'quick' );
		expect( withVariable ).not.toContain( 'regular_price' );
		expect( withVariable ).not.toContain( 'sale_price' );
		expect( withVariable ).toContain( 'stock_status' );
		expect( withVariable ).toContain( 'categories' );

		const withVariation = ids( [ product(), variation() ], 'quick' );
		expect( withVariation ).toContain( 'regular_price' );
		expect( withVariation ).not.toContain( 'categories' );
		expect( withVariation ).not.toContain( 'featured' );

		expect( ids( [ product( { type: 'external' } ) ], 'quick' ) ).toEqual( expect.arrayContaining( [ 'external_url', 'button_text', 'regular_price' ] ) );
		expect( ids( [ product( { type: 'external' } ) ], 'quick' ) ).not.toContain( 'stock_quantity' );
	} );

	it( 'drops unique and non-bulk fields in bulk mode', () => {
		const fields = createProductFields( settings );
		const ids = fieldsForItems( fields, [ product(), product( { id: 3 } ) ], 'bulk' ).map( ( f ) => f.id );

		expect( ids ).not.toContain( 'sku' );
		expect( ids ).not.toContain( 'name' );
		expect( ids ).not.toContain( 'description' );
		expect( ids ).toContain( 'regular_price' );
		expect( fieldsForItems( fields, [], 'bulk' ) ).toEqual( [] );
	} );
} );

describe( 'currency', () => {
	const settings = sampleSettings();

	it( 'formats per the shop settings', () => {
		expect( formatPrice( '1234.5', settings ) ).toBe( '1 234,50 €' );
		expect( formatPrice( 0, settings ) ).toBe( '0,00 €' );
		expect( formatPrice( '', settings ) ).toBe( '' );
		expect( formatPrice( null, settings ) ).toBe( '' );
		expect( formatPrice( '-12', { ...settings, currency: { ...settings.currency, position: 'left' } } ) ).toBe( '€-12,00' );
	} );

	it( 'parses the shop notation and plain decimals', () => {
		expect( parsePrice( '12,50', settings ) ).toBe( '12.5' );
		expect( parsePrice( '1 234,56', settings ) ).toBe( '1234.56' );
		expect( parsePrice( '12.5', settings ) ).toBe( '12.5' );
		expect( parsePrice( '12,505 €', settings ) ).toBe( '12.51' );
		expect( parsePrice( '', settings ) ).toBeNull();
		expect( parsePrice( 'abc', settings ) ).toBeNull();
		expect( parsePrice( 7, settings ) ).toBe( '7' );
	} );

	it( 'rounds to the currency precision without trailing zeros', () => {
		expect( roundPrice( 1.005, settings ) ).toBe( '1.01' );
		expect( roundPrice( 10, settings ) ).toBe( '10' );
		expect( roundPrice( 2.5, { ...settings, currency: { ...settings.currency, decimals: 0 } } ) ).toBe( '3' );
	} );

	it( 'validates sale below regular', () => {
		expect( saleBelowRegular( '10', '20' ) ).toBe( true );
		expect( saleBelowRegular( '20', '20' ) ).toBe( false );
		expect( saleBelowRegular( '', '20' ) ).toBe( true );
		expect( saleBelowRegular( '5', '' ) ).toBe( true );
	} );
} );
