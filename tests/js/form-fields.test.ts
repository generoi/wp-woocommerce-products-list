import { describe, expect, it } from 'vitest';
import { referenceText, toFormFields, VARIATION_STATUS_ELEMENTS } from '../../resources/edit/form-fields';
import { mergeItems, MIXED_VALUE } from '../../resources/edit/merge';
import type { ProductField, ProductListItem } from '../../resources/types';
import { coreFields, editSettings, field, simple, variation } from './edit-fixtures';

const settings = editSettings();

function formFor( fields: ProductField[], items: ProductListItem[], bulk = items.length > 1 ) {
	const merged = mergeItems( items, fields );
	const formFields = toFormFields( fields, { bulk, items, base: merged.data, mixed: merged.mixed, settings } );

	return { data: merged.data, formFields, get: ( id: string ) => formFields.find( ( f ) => f.id === id )! };
}

const categories = field( 'categories', {
	type: 'array',
	getElements: async () => [ { value: 15 as unknown as string, label: 'Uncategorized' }, { value: 83 as unknown as string, label: 'Boots' } ],
	getValue: ( { item } ) => ( ( item as { categories?: Array< { id: number } > } ).categories ?? [] ).map( ( term ) => term.id ) as unknown as string[],
	rest: { fields: [ 'categories' ], write: ( value ) => ( { categories: ( value as unknown[] ).map( ( id ) => ( { id: Number( id ) } ) ) } ), applies: { product: true, variation: false } },
	edit: { group: 'organization', bulk: 'default' },
} );

describe( 'array (term) fields', () => {
	it( 'shows string tokens (what DataViews validates and labels) and writes the row’s numeric ids back', async () => {
		const item = simple( 1, { categories: [ { id: 15, name: 'Uncategorized' }, { id: 83, name: 'Boots' } ] } );
		const { data, get } = formFor( [ categories ], [ item ] );
		const form = get( 'categories' );

		expect( data.categories ).toEqual( [ 15, 83 ] );
		expect( form.getValue!( { item: data } ) ).toEqual( [ '15', '83' ] );
		expect( form.setValue!( { item: data, value: [ '15', '94' ] } ) ).toEqual( { categories: [ 15, 94 ] } );
		expect( await form.getElements!() ).toEqual( [ { value: '15', label: 'Uncategorized' }, { value: '83', label: 'Boots' } ] );
	} );

	it( 'keeps string ids as strings when the rows carry none to learn the type from', () => {
		const { data, get } = formFor( [ categories ], [ simple( 1, { categories: [] } ) ] );

		expect( get( 'categories' ).setValue!( { item: data, value: [ '15' ] } ) ).toEqual( { categories: [ '15' ] } );
	} );
} );

describe( 'mixed selects', () => {
	const stock = field( 'stock_status', { elements: [ { value: 'instock', label: 'In stock' }, { value: 'outofstock', label: 'Out of stock' } ] } );

	it( 'adds a leading "Mixed (no change)" option selected by the sentinel in bulk mode', () => {
		const { data, get } = formFor( [ stock ], [ simple( 1, { stock_status: 'instock' } ), simple( 2, { stock_status: 'outofstock' } ) ] );
		const form = get( 'stock_status' );

		expect( data.stock_status ).toBe( MIXED_VALUE );
		expect( form.elements?.[ 0 ] ).toMatchObject( { value: MIXED_VALUE } );
		expect( form.elements ).toHaveLength( 3 );
		expect( form.setValue!( { item: data, value: MIXED_VALUE } ) ).toEqual( { stock_status: MIXED_VALUE } );
	} );

	it( 'leaves agreeing selects and quick edit alone', () => {
		expect( formFor( [ stock ], [ simple( 1, { stock_status: 'instock' } ), simple( 2, { stock_status: 'instock' } ) ] ).get( 'stock_status' ).elements ).toHaveLength( 2 );
		expect( formFor( [ stock ], [ simple( 1, { stock_status: 'instock' } ) ] ).get( 'stock_status' ).elements ).toHaveLength( 2 );
	} );
} );

describe( 'variation status', () => {
	const status = field( 'status', { elements: [ { value: 'publish', label: 'Published' }, { value: 'draft', label: 'Draft' }, { value: 'private', label: 'Private' } ], rest: { fields: [ 'status' ], applies: { product: true, variation: true } } } );

	it( 'is Active/Inactive when only variations are edited, the product statuses otherwise', () => {
		expect( formFor( [ status ], [ variation( 11, 1 ) ] ).get( 'status' ).elements ).toEqual( VARIATION_STATUS_ELEMENTS );
		expect( formFor( [ status ], [ variation( 11, 1 ), variation( 12, 1 ) ] ).get( 'status' ).elements ).toEqual( VARIATION_STATUS_ELEMENTS );
		expect( formFor( [ status ], [ simple( 1 ) ] ).get( 'status' ).elements ).toHaveLength( 3 );
		expect( formFor( [ status ], [ simple( 1 ), variation( 11, 1 ) ] ).get( 'status' ).elements ).toHaveLength( 3 );
	} );
} );

describe( 'quick edit validation', () => {
	const fields = coreFields();

	it( 'requires a name and whole, non-negative quantities, and says so per field', () => {
		const { data, get } = formFor( fields, [ simple( 1 ) ] );

		expect( get( 'name' ).isValid?.required ).toBe( true );

		const quantity = get( 'stock_quantity' );
		const custom = quantity.isValid?.custom as ( item: Record< string, unknown > ) => string | null;

		expect( custom( { ...data, stock_quantity: -5 } ) ).toMatch( /negative/ );
		expect( custom( { ...data, stock_quantity: '7.5' } ) ).toMatch( /whole number/ );
		expect( custom( { ...data, stock_quantity: 7 } ) ).toBeNull();
		expect( custom( { ...data, stock_quantity: '' } ) ).toBeNull();
	} );

	it( 'does not require anything in bulk (empty means no change)', () => {
		const { get } = formFor( fields, [ simple( 1 ), simple( 2 ) ] );

		expect( get( 'status' ).isValid?.required ).toBeFalsy();
	} );
} );

describe( 'datetime fields', () => {
	it( 'turn the control’s undefined (cleared) into an empty string so the clear is an edit', () => {
		const from = coreFields().find( ( f ) => f.id === 'date_on_sale_from' )!;
		const { data, get } = formFor( [ from ], [ simple( 1, { date_on_sale_from: '2026-11-01T00:00:00' } ) ] );

		expect( get( 'date_on_sale_from' ).setValue!( { item: data, value: undefined } ) ).toEqual( { date_on_sale_from: '' } );
		expect( get( 'date_on_sale_from' ).setValue!( { item: data, value: '2026-10-31T22:00:00.000Z' } ) ).toEqual( { date_on_sale_from: '2026-10-31T22:00:00.000Z' } );
	} );
} );

describe( 'reference help text', () => {
	it( 'formats money, strips HTML and truncates long text', () => {
		const price = coreFields().find( ( f ) => f.id === 'i18n:se.regular_price' )!;
		const text = field( 'i18n:se.description', { edit: { group: 'i18n:se', bulk: false } } );

		expect( referenceText( price, '2095', settings ) ).toBe( '2 095,00 €' );
		expect( referenceText( text, '<ul><li>Materiaali: nahka</li></ul>', settings ) ).toBe( 'Materiaali: nahka' );
		expect( referenceText( text, 'x'.repeat( 500 ), settings ) ).toHaveLength( 201 );
		expect( referenceText( text, 'short', settings ) ).toBe( 'short' );
	} );

	it( 'reaches the form field description as "Default: …"', () => {
		const fields = coreFields();
		const item = simple( 1, { i18n: { se: { name: { value: '', source: '<b>Saga</b>' } } } } );

		expect( formFor( fields, [ item ] ).get( 'i18n:se.name' ).description ).toBe( 'Default: Saga' );
	} );
} );
