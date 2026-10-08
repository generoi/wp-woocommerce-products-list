/**
 * The inline form's columns (edit/form-layouts.ts): the General tab in
 * three columns as WooCommerce's quick edit, a language tab with its long
 * controls on the right, a single column when a tab has one.
 */
import { describe, expect, it } from 'vitest';
import { buildInlineForm, columnOf, columnsOfTab, GENERAL_TAB_ID } from '../../resources/edit/form-layouts';
import type { Form, FormField } from '../../resources/dataviews';
import type { ProductField } from '../../resources/types';
import { coreFields, editSettings, field, simple } from './edit-fixtures';

const settings = editSettings();
const general = { id: GENERAL_TAB_ID, label: 'General' };

function ids( fields: ProductField[] ): string[] {
	return fields.map( ( entry ) => entry.id );
}

describe( 'columnsOfTab', () => {
	it( 'lays the General tab out by group with WooCommerce\'s exceptions', () => {
		const fields = coreFields().filter( ( entry ) => entry.edit !== false && ! entry.id.startsWith( 'i18n' ) );
		const columns = columnsOfTab( fields, general );

		expect( columns ).toHaveLength( 3 );
		// The fixture's `featured` sits in the organization group (the registry's is in visibility, column 1).
		expect( ids( columns[ 0 ]! ) ).toEqual( [ 'name', 'status', 'external_url' ] );
		expect( ids( columns[ 1 ]! ) ).toEqual( [ 'featured', 'categories' ] );
		expect( ids( columns[ 2 ]! ) ).toEqual( [ 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to', 'sku', 'stock_quantity', 'manage_stock', 'dimensions' ] );
		// A moved field is laid out under the group of its new column (SKU under Inventory, not a second "General").
		const form = buildInlineForm( fields, general, [ simple( 1 ) ], settings );
		const third = ( ( form.fields![ 0 ] as FormField ).children as FormField[] )[ 2 ]!.children as FormField[];

		expect( third.map( ( group ) => group.id ) ).toEqual( [ 'group:price', 'group:inventory', 'group:shipping' ] );
		expect( third[ 1 ]!.children ).toEqual( [ 'sku', 'stock_quantity', 'manage_stock' ] );
		expect( columnOf( field( 'shipping_class', { edit: { group: 'shipping', bulk: 'default' } } ) ) ).toBe( 2 );
		expect( columnOf( field( 'mystery', { edit: { group: 'notes', bulk: 'default' } } ) ) ).toBe( 2 );
	} );

	it( 'drops empty columns, and splits a language tab into short and long controls', () => {
		const se = { id: 'i18n:se', label: 'Svenska' };
		const fields = [
			...coreFields().filter( ( entry ) => entry.id.startsWith( 'i18n:se' ) ),
			field( 'i18n:se.description', { Edit: { control: 'textarea', rows: 4 } as ProductField[ 'Edit' ], edit: { group: 'i18n:se', bulk: false } } ),
		];
		const columns = columnsOfTab( fields, se );

		expect( columns ).toHaveLength( 2 );
		expect( ids( columns[ 0 ]! ) ).toEqual( [ 'i18n:se.name', 'i18n:se.sale_price', 'i18n:se.regular_price' ] );
		expect( ids( columns[ 1 ]! ) ).toEqual( [ 'i18n:se.description' ] );
		expect( columnsOfTab( [ field( 'name' ) ], general ) ).toHaveLength( 1 );
	} );
} );

describe( 'buildInlineForm', () => {
	it( 'nests the columns in a row layout, each column a regular group of labelled groups', () => {
		const fields = coreFields().filter( ( entry ) => [ 'name', 'status', 'categories', 'regular_price', 'stock_quantity' ].includes( entry.id ) );
		const form: Form = buildInlineForm( fields, general, [ simple( 1 ) ], settings );
		const [ row ] = form.fields as FormField[];

		expect( form.layout ).toEqual( { type: 'regular', labelPosition: 'top' } );
		expect( row ).toMatchObject( { id: 'columns', layout: { type: 'row', alignment: 'start' } } );

		const columns = row!.children as FormField[];

		expect( columns.map( ( column ) => column.id ) ).toEqual( [ 'column:1', 'column:2', 'column:3' ] );
		expect( ( row!.layout as { styles: Record< string, unknown > } ).styles ).toEqual( { 'column:1': { flex: '1 1 0' }, 'column:2': { flex: '1 1 0' }, 'column:3': { flex: '1 1 0' } } );
		expect( columns[ 0 ]!.children ).toEqual( [ { id: 'group:general', label: 'General', layout: { type: 'regular', labelPosition: 'top' }, children: [ 'name', 'status' ] } ] );
		expect( ( columns[ 2 ]!.children as FormField[] ).map( ( group ) => group.id ) ).toEqual( [ 'group:price', 'group:inventory' ] );
	} );

	it( 'uses a single column without the row wrapper, and no header for a one-group language tab', () => {
		const se = { id: 'i18n:se', label: 'Svenska' };
		const form = buildInlineForm( coreFields().filter( ( entry ) => entry.id === 'i18n:se.name' ), se, [ simple( 1 ) ], settings );

		expect( form.fields ).toEqual( [ { id: 'group:i18n:se', layout: { type: 'regular', labelPosition: 'top' }, children: [ 'i18n:se.name' ] } ] );
	} );
} );
