import { afterEach, describe, expect, it } from 'vitest';
import { displayText, inlineKindOf, parseText, rowEditableIds, validateRow, withInlineEditing } from '../../resources/list/inline-edit/cells';
import { clearDrafts, draftCount, flagDrafts, getDraft, resetDrafts, rowDrafts, setDraft } from '../../resources/list/inline-edit/drafts';
import type { InlineEditValue } from '../../resources/list/inline-edit/mode';
import { fieldList } from '../../resources/list/inline-edit/save-row';
import { createCoreFields } from '../../resources/fields/registry';
import type { ProductField } from '../../resources/types';
import { editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = createCoreFields( settings );
const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
const context: InlineEditValue = { fields, byId, settings };
const get = ( id: string ) => byId.get( id ) as ProductField;

afterEach( () => resetDrafts() );

describe( 'which cells are inputs', () => {
	it( 'edits plain values in their cells, not HTML, terms, dates or images', () => {
		expect( inlineKindOf( get( 'name' ) ) ).toBe( 'text' );
		expect( inlineKindOf( get( 'sku' ) ) ).toBe( 'text' );
		expect( inlineKindOf( get( 'regular_price' ) ) ).toBe( 'money' );
		expect( inlineKindOf( get( 'stock_quantity' ) ) ).toBe( 'integer' );
		expect( inlineKindOf( get( 'status' ) ) ).toBe( 'select' );
		expect( inlineKindOf( get( 'description' ) ) ).toBeNull();
		expect( inlineKindOf( get( 'categories' ) ) ).toBeNull();
		expect( inlineKindOf( get( 'date_on_sale_from' ) ) ).toBeNull();
		expect( inlineKindOf( get( 'images' ) ) ).toBeNull();
		expect( inlineKindOf( get( 'price' ) ) ).toBeNull();
	} );

	it( 'offers a row what quick edit would: no price on a variable product, no name on a variation, stock only when managed', () => {
		const product = rowEditableIds( simple( 1 ), context );
		const parent = rowEditableIds( variable( 2 ), context );
		const child = rowEditableIds( variation( 3, 2 ), context );
		const unmanaged = rowEditableIds( simple( 4, { manage_stock: false, stock_quantity: null } ), context );

		expect( product.has( 'regular_price' ) && product.has( 'name' ) && product.has( 'stock_quantity' ) ).toBe( true );
		expect( parent.has( 'regular_price' ) ).toBe( false );
		expect( parent.has( 'name' ) ).toBe( true );
		expect( child.has( 'regular_price' ) ).toBe( true );
		expect( child.has( 'name' ) ).toBe( false );
		expect( unmanaged.has( 'stock_quantity' ) ).toBe( false );
	} );

	it( 'offers nothing on a row the user may not edit, a trashed row or a placeholder', () => {
		expect( rowEditableIds( simple( 1, { wc_products_list: { can_edit: false } } ), context ).size ).toBe( 0 );
		expect( rowEditableIds( simple( 1, { status: 'trash' } ), context ).size ).toBe( 0 );
		expect( rowEditableIds( { ...simple( 1 ), _placeholder: 'loading' } as never, context ).size ).toBe( 0 );
		expect( rowEditableIds( simple( 1 ), { ...context, settings: editSettings( { caps: { ...settings.caps, edit: false } } ) } ).size ).toBe( 0 );
	} );

	it( 'changes only the cells of the fields it edits, and nothing when off', () => {
		expect( withInlineEditing( fields, false ) ).toBe( fields );

		const inline = withInlineEditing( fields, true );

		expect( inline.find( ( field ) => field.id === 'sku' )?.render ).not.toBe( get( 'sku' ).render );
		expect( inline.find( ( field ) => field.id === 'price' )?.render ).not.toBe( get( 'price' ).render );
		expect( inline.find( ( field ) => field.id === 'categories' )?.render ).toBe( get( 'categories' ).render );
		expect( inline.map( ( field ) => field.id ) ).toEqual( fields.map( ( field ) => field.id ) );
	} );
} );

describe( 'typing into a cell', () => {
	it( 'shows a price in the shop’s notation and reads it back stored', () => {
		const row = simple( 1, { regular_price: '15.5' } );

		expect( displayText( get( 'regular_price' ), row, 'money', settings ) ).toBe( '15,50' );
		expect( parseText( get( 'regular_price' ), 'money', '16,90', settings, row ) ).toEqual( { value: '16.9' } );
		expect( parseText( get( 'regular_price' ), 'money', '', settings, row ) ).toEqual( { value: '' } );
		expect( parseText( get( 'regular_price' ), 'money', 'abc', settings, row ).error ).toBeTruthy();
	} );

	it( 'takes whole numbers for a quantity and refuses an empty name', () => {
		const row = simple( 1 );

		expect( parseText( get( 'stock_quantity' ), 'integer', '12', settings, row ) ).toEqual( { value: 12 } );
		expect( parseText( get( 'stock_quantity' ), 'integer', '1.5', settings, row ).error ).toBeTruthy();
		expect( parseText( get( 'name' ), 'text', '  ', settings, row ).error ).toBeTruthy();
	} );

	it( 'keeps a stored "&amp;" when the shown "&" is typed back', () => {
		const row = simple( 1, { name: 'Salt &amp; pepper' } );

		expect( displayText( get( 'name' ), row, 'text', settings ) ).toBe( 'Salt & pepper' );
		expect( parseText( get( 'name' ), 'text', 'Salt & pepper', settings, row ).value ).toBe( 'Salt &amp; pepper' );
	} );

	it( 'checks a row’s changes together: a sale price must stay below the regular price', () => {
		const row = simple( 1, { regular_price: '20' } );
		const drafts = new Map( [ [ 'sale_price', { text: '25', value: '25' } ] ] );

		expect( validateRow( row, drafts, context ).map( ( entry ) => entry.field ) ).toEqual( [ 'sale_price' ] );

		const both = new Map( [
			[ 'regular_price', { text: '30', value: '30' } ],
			[ 'sale_price', { text: '25', value: '25' } ],
		] );

		expect( validateRow( row, both, context ) ).toEqual( [] );
	} );

	it( 'reports a cell’s own parse error before the cross-field checks', () => {
		const drafts = new Map( [ [ 'regular_price', { text: 'x', value: 'x', error: 'Enter a valid price.' } ] ] );

		expect( validateRow( simple( 1 ), drafts, context ) ).toEqual( [ { field: 'regular_price', message: 'Enter a valid price.' } ] );
	} );
} );

describe( 'drafts', () => {
	it( 'keeps a row’s unsaved cells until they are cleared, and counts them for the leave-page guard', () => {
		setDraft( 1, 'sku', { text: 'A', value: 'A' } );
		setDraft( 1, 'name', { text: 'B', value: 'B' } );
		setDraft( 2, 'sku', { text: 'C', value: 'C' } );

		expect( draftCount() ).toBe( 3 );
		expect( Array.from( rowDrafts( 1 ).keys() ) ).toEqual( [ 'sku', 'name' ] );

		flagDrafts( 1, 'Taken', [ 'sku' ] );
		expect( getDraft( 1, 'sku' )?.error ).toBe( 'Taken' );
		expect( getDraft( 1, 'name' )?.error ).toBeUndefined();

		clearDrafts( 1, [ 'sku' ] );
		expect( draftCount() ).toBe( 2 );

		setDraft( 2, 'sku', undefined );
		expect( rowDrafts( 2 ).size ).toBe( 0 );
	} );
} );

describe( 'the saved notice', () => {
	it( 'names the fields', () => {
		expect( fieldList( [ 'Price' ] ) ).toBe( 'Price' );
		expect( fieldList( [ 'Regular price', 'Sale price' ] ) ).toBe( 'Regular price and Sale price' );
		expect( fieldList( [ 'Name', 'SKU', 'Price' ] ) ).toBe( 'Name, SKU and Price' );
	} );
} );
