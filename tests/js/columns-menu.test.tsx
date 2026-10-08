import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { View } from '../../resources/dataviews';
import { createProductFields } from '../../resources/fields/registry';
import { ColumnsPanel, groupColumns, isColumnField, searchColumns, toggleColumn } from '../../resources/list/columns-menu';
import { setSettings } from '../../resources/settings';
import type { DeclarativeField, DeclarativeFilter, ProductField, Settings } from '../../resources/types';
import { sampleSettings } from './settings.test';

function i18nField( lang: string, key: string, label: string ): DeclarativeField {
	return {
		id: `i18n:${ lang }.${ key }`,
		label,
		type: 'text',
		description: '',
		path: `i18n.${ lang }.${ key }.value`,
		reference: `i18n.${ lang }.${ key }.source`,
		writeKey: 'i18n',
		writePath: `i18n.${ lang }.${ key }`,
		editable: true,
		bulk: 'default',
		readonly: false,
		applies: { product: true, variation: false },
		options: [],
		group: `i18n:${ lang }`,
		tab: `i18n:${ lang }`,
		visible: key === 'name',
		order: 10,
		enableSorting: false,
		sortParam: null,
		restFields: [ 'i18n' ],
		filter: null,
		width: null,
		source: 'gds-woo-i18n',
	};
}

const translationFilter: DeclarativeFilter = {
	id: 'translation',
	label: 'Translation',
	type: 'select',
	param: null,
	options: [ { value: 'missing:se', label: 'Missing in Svenska', params: { gds_i18n: 'se' } } ],
	operators: [ 'is' ],
	isPrimary: false,
	multiple: false,
	variations: false,
	order: 0,
	source: 'gds-woo-i18n',
};

const settings: Settings = sampleSettings( {
	fields: [ i18nField( 'se', 'name', 'Svenska: name' ), i18nField( 'se', 'description', 'Svenska: description' ), i18nField( 'de', 'name', 'Deutsch: name' ) ],
	filters: [ translationFilter ],
	languages: { default: 'fi', others: [ 'se', 'de' ], labels: { fi: 'Suomi', se: 'Svenska', de: 'Deutsch' } },
} );

const view = { type: 'table', page: 1, perPage: 20, titleField: 'name', mediaField: 'images', fields: [ 'sku', 'price' ] } as View;

let fields: ProductField[];

function withFields(): void {
	beforeEach( () => {
		setSettings( settings );
		fields = createProductFields( settings );
	} );

	afterEach( () => setSettings( undefined ) );
}

describe( 'groupColumns', () => {
	withFields();

	it( 'offers real columns only: not the title, the media, or a filter', () => {
		const ids = groupColumns( fields, view, settings ).flatMap( ( group ) => group.fields.map( ( field ) => field.id ) );

		expect( ids ).not.toContain( 'name' );
		expect( ids ).not.toContain( 'images' );
		expect( ids ).not.toContain( 'translation' );
		expect( ids ).not.toContain( 'variation_stock' );
		expect( ids ).toEqual( expect.arrayContaining( [ 'sku', 'price', 'regular_price', 'stock_quantity', 'i18n:se.name' ] ) );
		expect( isColumnField( fields.find( ( field ) => field.id === 'translation' )!, view ) ).toBe( false );
	} );

	it( 'sections the columns: product, pricing, stock, shipping, content, then one per language in the settings order', () => {
		const groups = groupColumns( fields, view, settings );

		expect( groups.map( ( group ) => group.id ) ).toEqual( [ 'product', 'pricing', 'stock', 'shipping', 'content', 'i18n:se', 'i18n:de' ] );
		expect( groups.map( ( group ) => group.label ) ).toEqual( [ 'Product', 'Pricing', 'Stock', 'Shipping', 'Content', 'Svenska', 'Deutsch' ] );

		const byId = Object.fromEntries( groups.map( ( group ) => [ group.id, group.fields.map( ( field ) => field.id ) ] ) );
		expect( byId.pricing ).toEqual( expect.arrayContaining( [ 'price', 'regular_price', 'sale_price', 'date_on_sale_from', 'on_sale', 'tax_status' ] ) );
		expect( byId.stock ).toEqual( expect.arrayContaining( [ 'stock_status', 'stock_quantity', 'manage_stock', 'backorders' ] ) );
		expect( byId.product ).toEqual( expect.arrayContaining( [ 'sku', 'status', 'type', 'categories', 'featured', 'date_created' ] ) );
		expect( byId[ 'i18n:se' ] ).toEqual( [ 'i18n:se.name', 'i18n:se.description' ] );
		expect( byId[ 'i18n:de' ] ).toEqual( [ 'i18n:de.name' ] );
	} );

	it( 'searches labels (and the section name) and drops empty sections', () => {
		const groups = groupColumns( fields, view, settings );

		expect( searchColumns( groups, '' ) ).toBe( groups );
		const sale = searchColumns( groups, 'sale' );
		expect( sale.map( ( group ) => group.id ) ).toEqual( [ 'pricing' ] );
		expect( sale[ 0 ]!.fields.map( ( field ) => field.id ) ).toEqual( [ 'sale_price', 'date_on_sale_from', 'date_on_sale_to', 'on_sale' ] );

		expect( searchColumns( groups, 'svenska' ).map( ( group ) => group.id ) ).toEqual( [ 'i18n:se' ] );
		expect( searchColumns( groups, 'zzz' ) ).toEqual( [] );
	} );

	it( 'toggles a column at the end of the list', () => {
		expect( toggleColumn( view, 'sale_price' ).fields ).toEqual( [ 'sku', 'price', 'sale_price' ] );
		expect( toggleColumn( view, 'sku' ).fields ).toEqual( [ 'price' ] );
	} );
} );

describe( 'ColumnsPanel', () => {
	withFields();

	it( 'finds a column by typing and toggles it through onChangeView', () => {
		const onChangeView = vi.fn();
		render( <ColumnsPanel fields={ fields } view={ view } onChangeView={ onChangeView } settings={ settings } /> );

		expect( screen.getByRole( 'checkbox', { name: 'SKU' } ) ).toBeChecked();
		expect( screen.getByRole( 'checkbox', { name: 'Svenska: name' } ) ).not.toBeChecked();

		fireEvent.change( screen.getByRole( 'searchbox', { name: 'Find a column' } ), { target: { value: 'quant' } } );
		expect( screen.getAllByRole( 'checkbox' ).map( ( box ) => box.closest( 'label' )?.textContent ) ).toEqual( [ 'Quantity' ] );

		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Quantity' } ) );
		expect( onChangeView ).toHaveBeenCalledWith( expect.objectContaining( { fields: [ 'sku', 'price', 'stock_quantity' ] } ) );

		fireEvent.change( screen.getByRole( 'searchbox', { name: 'Find a column' } ), { target: { value: 'nothing here' } } );
		expect( screen.getByText( 'No column matches.' ) ).toBeInTheDocument();
	} );
} );
