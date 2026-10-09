import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProductListQuery, variationFilterParams } from '../../resources/api/query';
import type { View } from '../../resources/dataviews';
import { attributeProductParams, attributeTaxonomyOf, createAttributeFilters } from '../../resources/fields/attributes';
import { clearTermElements, termElements, termSlugs, TERMS_STORAGE_PREFIX } from '../../resources/fields/terms';
import { HierarchyViewProvider, NameCell } from '../../resources/hierarchy';
import { rangeSelection, withVariationTitles } from '../../resources/hierarchy/hierarchical-dataviews';
import { normalizeProduct, normalizeVariation } from '../../resources/hierarchy/normalize';
import { getChildrenState, getVariationFilter, resetHierarchyStore, useHierarchy } from '../../resources/hierarchy/use-hierarchy';
import type { FetchVariations } from '../../resources/hierarchy/use-hierarchy';
import { isBulkEditShortcut, selectMatchingVariations } from '../../resources/list/products-screen';
import { setSettings } from '../../resources/settings';
import { getItemId } from '../../resources/types';
import type { ProductField, ProductListItem, ProductRow, QueryParams, RawVariation, Settings } from '../../resources/types';
import { sampleSettings } from './settings.test';

const getTerms = vi.fn();

vi.mock( '../../resources/api/client', () => ( {
	getVariations: vi.fn(),
	getTerms: ( ...args: unknown[] ) => getTerms( ...args ),
	listProducts: vi.fn(),
	getCounts: vi.fn(),
} ) );

function settingsWithAttributes(): Settings {
	return sampleSettings( {
		taxonomies: [
			{ name: 'product_cat', label: 'Categories', restKey: 'categories', hierarchical: true, attribute: false },
			{ name: 'pa_color', label: 'Colour', restKey: 'attributes', hierarchical: false, attribute: true },
			{ name: 'pa_size', label: 'Size', restKey: 'attributes', hierarchical: false, attribute: true },
		],
	} );
}

function parent( id: number, count = 3 ): ProductRow {
	return normalizeProduct( { id, type: 'variable', name: `P${ id }`, wc_products_list: { variation_count: count, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 } } );
}

function seedTerms( taxonomy: string, terms: Array< { value: number; label: string; slug: string } > ): void {
	window.sessionStorage.setItem( TERMS_STORAGE_PREFIX + taxonomy, JSON.stringify( { at: Date.now(), terms } ) );
}

const viewWith = ( filters: View[ 'filters' ] ): View => ( { type: 'table', page: 1, perPage: 20, fields: [ 'name' ], filters } );

function setup(): void {
	beforeEach( () => {
		setSettings( settingsWithAttributes() );
		resetHierarchyStore();
		clearTermElements();
		getTerms.mockReset();
	} );

	afterEach( () => {
		setSettings( undefined );
		window.sessionStorage.clear();
	} );
}

describe( 'attribute filters', () => {
	setup();

	it( 'adds one filter-only field per pa_* taxonomy', () => {
		const fields = createAttributeFilters( settingsWithAttributes() );

		expect( fields.map( ( field ) => field.id ) ).toEqual( [ 'attribute:pa_color', 'attribute:pa_size' ] );
		expect( fields[ 0 ] ).toMatchObject( { label: 'Attribute: Colour', filterOnly: true, readOnly: true, edit: false, enableHiding: false, filterBy: { operators: [ 'isAny' ] } } );
		expect( attributeTaxonomyOf( 'attribute:pa_size' ) ).toBe( 'pa_size' );
		expect( attributeTaxonomyOf( 'categories' ) ).toBeNull();
	} );

	it( 'filters the products with wc/v3 attribute + attribute_term', () => {
		const settings = settingsWithAttributes();
		const fields = createAttributeFilters( settings );
		const query = buildProductListQuery( viewWith( [ { field: 'attribute:pa_color', operator: 'isAny', value: [ 12, 13 ] } ] ), 'all', fields, settings );

		expect( query ).toMatchObject( { attribute: 'pa_color', attribute_term: '12,13' } );
		expect( attributeProductParams( 'pa_color', [], 'isAny' ) ).toEqual( {} );
	} );

	it( 'keeps term slugs next to the ids, from the server and from the stored copy', async () => {
		getTerms.mockResolvedValue( { items: [ { id: 12, name: 'Black with wool', slug: 'black-with-wool', parent: 0, count: 6 } ], total: 1, totalPages: 1 } );

		expect( termSlugs( 'pa_color', [ 12 ] ) ).toBeNull();
		await termElements( 'pa_color' );
		expect( termSlugs( 'pa_color', [ 12 ] ) ).toEqual( [ 'black-with-wool' ] );
		expect( termSlugs( 'pa_color', [ 12, 99 ] ) ).toBeNull();

		clearTermElements();
		seedTerms( 'pa_size', [ { value: 38, label: '38', slug: '38' } ] );
		expect( termSlugs( 'pa_size', [ '38' ] ) ).toEqual( [ '38' ] );
	} );
} );

describe( 'variationFilterParams', () => {
	setup();

	const fields: ProductField[] = [];

	it( 'is empty without variation-level filters', () => {
		expect( variationFilterParams( viewWith( [ { field: 'categories', operator: 'isAny', value: [ 1 ] } ] ), fields ) ).toEqual( { params: {}, pending: [], key: '' } );
	} );

	it( 'maps the stock filters, the variation one winning', () => {
		expect( variationFilterParams( viewWith( [ { field: 'stock_status', operator: 'is', value: 'instock' } ] ), fields ).params ).toEqual( { stock_status: 'instock' } );
		expect(
			variationFilterParams(
				viewWith( [
					{ field: 'stock_status', operator: 'is', value: 'instock' },
					{ field: 'variation_stock', operator: 'is', value: 'outofstock' },
				] ),
				fields
			).params
		).toEqual( { stock_status: 'outofstock' } );
	} );

	it( 'maps attribute filters to slugs, or reports the taxonomies still to load', () => {
		const view = viewWith( [
			{ field: 'attribute:pa_color', operator: 'isAny', value: [ 12 ] },
			{ field: 'attribute:pa_size', operator: 'isAny', value: [ 38 ] },
		] );

		seedTerms( 'pa_color', [ { value: 12, label: 'Black with wool', slug: 'black-with-wool' } ] );
		const partial = variationFilterParams( view, fields );
		expect( partial.pending ).toEqual( [ 'pa_size' ] );
		expect( partial.params ).toEqual( { attributes: [ { attribute: 'pa_color', terms: [ 'black-with-wool' ] } ] } );

		seedTerms( 'pa_size', [ { value: 38, label: '38', slug: '38' } ] );
		const full = variationFilterParams( view, fields );
		expect( full.pending ).toEqual( [] );
		expect( full.params ).toEqual( {
			attributes: [
				{ attribute: 'pa_color', terms: [ 'black-with-wool' ] },
				{ attribute: 'pa_size', terms: [ '38' ] },
			],
		} );
		expect( full.key ).toBe( JSON.stringify( full.params ) );
	} );

	it( "uses an extension field's toVariationParams", () => {
		const custom = { id: 'ean', rest: { fields: [], applies: { product: true, variation: false }, toVariationParams: ( value: unknown ) => ( { global_unique_id: String( value ) } ) } } as unknown as ProductField;

		expect( variationFilterParams( viewWith( [ { field: 'ean', operator: 'is', value: '123' } ] ), [ custom ] ).params ).toEqual( { global_unique_id: '123' } );
	} );
} );

describe( 'useHierarchy with a variation filter', () => {
	setup();

	function fetchStub() {
		const calls: Array< { parentId: number; page: number; params?: QueryParams } > = [];
		const fetch: FetchVariations = async ( parentId, page, { params } ) => {
			calls.push( { parentId, page, params } );
			const all = [ 1, 2, 3 ].map( ( n ) => ( { id: parentId * 100 + n, name: `V${ n }`, status: 'publish', stock_status: n === 2 ? 'outofstock' : 'instock' } ) as RawVariation );
			const items = params?.stock_status ? all.filter( ( row ) => row.stock_status === params.stock_status ) : all;

			return { items, total: items.length, totalPages: 1 };
		};

		return { fetch, calls };
	}

	const fields: ProductField[] = [];

	it( 'loads only the matching variations, marks them filtered, and lifts it per parent', async () => {
		const { fetch, calls } = fetchStub();
		const filter = { key: 'k1', params: { stock_status: 'outofstock' } };
		const { result } = renderHook( () => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null, variationFilter: filter } ) );

		expect( result.current.variationFilterActive ).toBe( true );
		expect( getVariationFilter().key ).toBe( 'k1' );

		await act( async () => {
			await result.current.expand( 1 );
		} );

		expect( calls[ 0 ]?.params ).toEqual( { stock_status: 'outofstock' } );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '102' ] );
		expect( result.current.childrenOf( 1 ) ).toMatchObject( { status: 'loaded', total: 1, filtered: true } );

		// "Select all variations" selects what matches.
		let selected: string[] = [];
		await act( async () => {
			selected = await result.current.selectVariations( 1 );
		} );
		expect( selected ).toEqual( [ '102' ] );

		// "Every variation" (apply to variations) never reads the filtered rows.
		let ids: number[] = [];
		await act( async () => {
			ids = await result.current.variationIdsOf( [ 1 ] );
		} );
		expect( ids ).toEqual( [ 101, 102, 103 ] );

		await act( async () => {
			result.current.showAllVariations?.( 1 );
			await result.current.expand( 1 );
		} );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '101', '102', '103' ] );
		expect( result.current.childrenOf( 1 )?.filtered ).toBeUndefined();

		await act( async () => {
			result.current.showMatchingVariations?.( 1 );
			await result.current.expand( 1 );
		} );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '102' ] );
	} );

	it( 'reloads the expanded parents when the filter changes', async () => {
		const { fetch, calls } = fetchStub();
		const { result, rerender } = renderHook( ( { filter } ) => useHierarchy( [ parent( 1 ) ], fields, { fetchVariations: fetch, storage: null, variationFilter: filter } ), {
			initialProps: { filter: { key: '', params: {} as QueryParams } },
		} );

		await act( async () => {
			await result.current.expand( 1 );
		} );
		expect( result.current.rows ).toHaveLength( 4 );
		expect( result.current.variationFilterActive ).toBe( false );

		await act( async () => {
			rerender( { filter: { key: 'k', params: { stock_status: 'outofstock' } } } );
		} );
		await act( async () => {
			await result.current.expand( 1 );
		} );

		expect( calls.at( -1 )?.params ).toEqual( { stock_status: 'outofstock' } );
		expect( result.current.rows.map( getItemId ) ).toEqual( [ '1', '102' ] );
	} );
} );

describe( 'the parent note under a variation filter', () => {
	setup();

	function renderNote( state: { status: 'loaded'; items: never[]; total: number; filtered?: boolean } ) {
		const onShowAllChildren = vi.fn();
		const onShowMatchingChildren = vi.fn();
		const item = parent( 7, 15 );

		render(
			<HierarchyViewProvider
				value={ {
					getItemParentId: () => null,
					getItemHasChildren: () => true,
					expandedItemIds: [ 7 ],
					onChangeExpandedItemIds: () => {},
					childrenState: new Map( [ [ 7, state ] ] ),
					variationFilterActive: true,
					onShowAllChildren,
					onShowMatchingChildren,
				} }
			>
				<NameCell item={ item } />
			</HierarchyViewProvider>
		);

		return { onShowAllChildren, onShowMatchingChildren };
	}

	it( 'says how many match and offers Show all', () => {
		const { onShowAllChildren } = renderNote( { status: 'loaded', items: [], total: 3, filtered: true } );

		expect( screen.getByText( /3 of 15 variations match/ ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( 'button', { name: 'Show all' } ) );
		expect( onShowAllChildren ).toHaveBeenCalledWith( 7 );
	} );

	it( 'offers Only matching once opened up', () => {
		const { onShowMatchingChildren } = renderNote( { status: 'loaded', items: [], total: 15 } );

		expect( screen.getByText( /All 15 variations/ ) ).toBeTruthy();
		fireEvent.click( screen.getByRole( 'button', { name: 'Only matching' } ) );
		expect( onShowMatchingChildren ).toHaveBeenCalledWith( 7 );
	} );
} );

describe( 'row checkboxes', () => {
	setup();

	const rows: ProductListItem[] = [ parent( 1 ), normalizeVariation( { id: 101, name: '38' }, parent( 1 ) ), normalizeVariation( { id: 102, name: '39' }, parent( 1 ) ), parent( 2 ) ];

	it( 'shift-click selects the range from the anchor, and clears it the same way', () => {
		expect( rangeSelection( rows, getItemId, [ '1' ], [ '1', '2' ], '1' ) ).toEqual( [ '1', '2', '101', '102' ] );
		expect( rangeSelection( rows, getItemId, [ '1', '101', '102', '2' ], [ '1', '101', '102' ], '101' ) ).toEqual( [ '1' ] );
		// No anchor, or a page-wide change: as DataViews said.
		expect( rangeSelection( rows, getItemId, [], [ '2' ], null ) ).toEqual( [ '2' ] );
		expect( rangeSelection( rows, getItemId, [], [ '1', '2' ], '1' ) ).toEqual( [ '1', '2' ] );
	} );

	it( "names a variation's checkbox after its parent", () => {
		const [ name ] = withVariationTitles( [ { id: 'name', label: 'Name', getValue: ( { item }: { item: ProductListItem } ) => item.name } as never ], 'name' ) as Array< { getValue: ( args: { item: ProductListItem } ) => unknown } >;

		expect( name!.getValue( { item: rows[ 1 ]! } ) ).toBe( 'P1 — 38' );
		expect( name!.getValue( { item: rows[ 0 ]! } ) ).toBe( 'P1' );
	} );
} );

describe( 'screen helpers', () => {
	setup();

	it( 'recognises Alt+B (Option+B on a Mac sends another key but the same code)', () => {
		const base = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };

		expect( isBulkEditShortcut( { ...base, code: 'KeyB', key: '∫' } ) ).toBe( true );
		expect( isBulkEditShortcut( { ...base, code: 'KeyB', key: 'b', ctrlKey: true } ) ).toBe( false );
		expect( isBulkEditShortcut( { ...base, altKey: false, code: 'KeyB', key: 'b' } ) ).toBe( false );
	} );

	it( 'Select matching variations expands the page and adds the loaded variations', async () => {
		const parents = [ parent( 1 ), parent( 2 ), normalizeProduct( { id: 3, type: 'simple', name: 'S' } ) as ProductRow ];
		const v = ( id: number, parentId: number ) => normalizeVariation( { id, name: String( id ) }, parentId ) as never;
		const children = new Map( [
			[ 1, { status: 'loaded', items: [ v( 101, 1 ) ] } ],
			[ 2, { status: 'loading', items: [] } ],
		] );
		const addRows = vi.fn();
		const expandAll = vi.fn( async () => true );

		const count = await selectMatchingVariations( parents, { expandAll, isExpanded: ( id ) => id !== 3 }, { addRows }, () => children );

		expect( expandAll ).toHaveBeenCalled();
		expect( count ).toBe( 1 );
		expect( addRows.mock.calls[ 0 ]?.[ 0 ].map( getItemId ) ).toEqual( [ '101' ] );
		expect( getChildrenState() ).toBeInstanceOf( Map );
	} );
} );
