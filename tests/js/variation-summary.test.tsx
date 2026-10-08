import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterToParams } from '../../resources/api/query';
import { PriceCell, VariationSaleSummary } from '../../resources/fields/components/price-cell';
import { createProductFields, getField } from '../../resources/fields/registry';
import { createVariationStockFilter, variationStockLabel, variationStockOf } from '../../resources/fields/stock-status';
import { setSettings } from '../../resources/settings';
import type { ListRowMeta, ProductListItem } from '../../resources/types';
import { sampleSettings } from './settings.test';

function meta( extra: Partial< ListRowMeta > ): ListRowMeta {
	return { variation_count: 16, edit_link: '', can_edit: true, can_delete: true, parent_id: 0, ...extra };
}

function variable( extra: Partial< ProductListItem > ): ProductListItem {
	return { id: 1, type: 'variable', price: '105', _kind: 'product', _level: 0, _parentId: null, _hasChildren: true, _childCount: 16, ...extra } as ProductListItem;
}

const settings = sampleSettings( { timezone: '+00:00', stockStatuses: [ { value: 'instock', label: 'In stock' }, { value: 'outofstock', label: 'Out of stock' } ] } );

function withSettings(): void {
	beforeEach( () => setSettings( settings ) );
	afterEach( () => setSettings( undefined ) );
}

describe( 'variation stock on the parent row', () => {
	withSettings();

	it( 'shows how many variations are out of stock, and nothing when none are or the server sent no summary', () => {
		const fields = createProductFields( settings );
		const stock = getField( fields, 'stock_status' )!;
		const Render = stock.render as ( props: { item: ProductListItem; field: unknown } ) => JSX.Element;

		const { container } = render( <Render item={ variable( { stock_status: 'instock', wc_products_list: meta( { variation_stock: { out_of_stock: 4, total: 16 } } ) } ) } field={ stock } /> );
		expect( container ).toHaveTextContent( 'In stock' );
		expect( container.querySelector( '.wc-products-list__stock-variations' ) ).toHaveTextContent( '4 of 16 variations out of stock' );

		expect( variationStockOf( variable( { wc_products_list: meta( { variation_stock: { out_of_stock: 0, total: 16 } } ) } ) ) ).toBeNull();
		expect( variationStockOf( variable( { wc_products_list: meta( {} ) } ) ) ).toBeNull();
		expect( variationStockOf( { ...variable( {} ), _kind: 'variation', wc_products_list: meta( { variation_stock: { out_of_stock: 1, total: 1 } } ) } as ProductListItem ) ).toBeNull();
		expect( variationStockLabel( { out_of_stock: 1, total: 1 } ) ).toBe( '1 of 1 variation out of stock' );
	} );

	it( 'offers a "variations in a stock status" filter that is not a column and maps to variation_stock_status', () => {
		const filter = createVariationStockFilter( settings );

		expect( filter.filterOnly ).toBe( true );
		expect( filter.enableHiding ).toBe( false );
		expect( filter.elements?.map( ( option ) => option.label ) ).toEqual( [ 'Any variation: In stock', 'Any variation: Out of stock' ] );
		expect( filterToParams( { field: 'variation_stock', operator: 'is', value: 'outofstock' }, filter ) ).toEqual( { variation_stock_status: 'outofstock' } );
		expect( createProductFields( settings ).some( ( field ) => field.id === 'variation_stock' ) ).toBe( true );
	} );
} );

describe( 'variation sales on the parent row', () => {
	withSettings();

	it( 'shows a scheduled badge with the count and window next to "From"', () => {
		render( <PriceCell item={ variable( { wc_products_list: meta( { sale_summary: { on_sale: 0, scheduled: 12, from: '2036-10-12T00:00:00', to: '2036-10-18T23:59:00' } } ) } ) } /> );

		expect( screen.getByText( /^From 105,00 €/ ) ).toBeInTheDocument();
		expect( screen.getByText( 'Scheduled' ).parentElement ).toHaveTextContent( 'Scheduled 12 variations 12.10.2036 – 18.10.2036' );
		expect( screen.getByTitle( 'Scheduled sale: 12 variations 12.10.2036 – 18.10.2036' ) ).toBeInTheDocument();
	} );

	it( 'shows an on-sale badge while the variations are on sale, and nothing without a summary', () => {
		const { container, rerender } = render( <VariationSaleSummary item={ variable( { wc_products_list: meta( { sale_summary: { on_sale: 3, scheduled: 0, from: null, to: null } } ) } ) } /> );

		expect( screen.getByText( 'On sale' ) ).toHaveClass( 'is-sale' );
		expect( container ).toHaveTextContent( 'On sale 3 variations' );

		rerender( <VariationSaleSummary item={ variable( { wc_products_list: meta( { sale_summary: { on_sale: 0, scheduled: 0, from: null, to: null } } ) } ) } /> );
		expect( container ).toBeEmptyDOMElement();
		rerender( <VariationSaleSummary item={ variable( { wc_products_list: meta( {} ) } ) } /> );
		expect( container ).toBeEmptyDOMElement();
	} );
} );
