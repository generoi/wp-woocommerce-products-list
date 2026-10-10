/**
 * The inline form's layout (edit/form-layouts.ts): one card per section in
 * the order a store manager works, the rarely used sections collapsed, a
 * main and a side column when the form is wide and one column in task
 * order when it is narrow; a language tab split into Translation, Prices
 * and SEO; the apply-to-variations control leading Pricing.
 */
import { describe, expect, it } from 'vitest';
import { APPLY_TO_VARIATIONS_FIELD_ID, buildInlineForm, formLabelOf, GENERAL_TAB_ID, layoutGroupOf, sectionNoteFieldId, sectionsOfTab } from '../../resources/edit/form-layouts';
import { applyControlField } from '../../resources/edit/apply-control';
import type { Form, FormField } from '../../resources/dataviews';
import type { ProductField } from '../../resources/types';
import { editSettings, field, simple } from './edit-fixtures';

const settings = editSettings();
const general = { id: GENERAL_TAB_ID, label: 'General' };
const se = { id: 'i18n:se', label: 'SE' };

function edit( id: string, group: string, order: number, extra: Partial< ProductField > = {} ): ProductField {
	return field( id, { ...extra, edit: { group, bulk: 'default', order } } );
}

/** The registry's groups and orders, as the edit form sees them. */
function registryFields(): ProductField[] {
	return [
		edit( 'name', 'general', 0 ),
		edit( 'slug', 'general', 5 ),
		edit( 'regular_price', 'pricing', 20 ),
		edit( 'sale_price', 'pricing', 21 ),
		edit( 'date_on_sale_from', 'pricing', 22 ),
		edit( 'date_on_sale_to', 'pricing', 23 ),
		edit( 'sku', 'inventory', 29 ),
		edit( 'manage_stock', 'inventory', 31 ),
		edit( 'stock_quantity', 'inventory', 31.5 ),
		edit( 'stock_status', 'inventory', 32 ),
		edit( 'backorders', 'inventory', 33 ),
		edit( 'low_stock_amount', 'inventory', 34 ),
		edit( 'sold_individually', 'inventory', 35 ),
		edit( 'status', 'visibility', 49 ),
		edit( 'catalog_visibility', 'visibility', 51 ),
		edit( 'featured', 'visibility', 52 ),
		edit( 'categories', 'organization', 40 ),
		edit( 'virtual', 'shipping', 59 ),
		edit( 'weight', 'shipping', 60 ),
		edit( 'shipping_class', 'shipping', 61 ),
		edit( 'tax_status', 'tax', 70 ),
		edit( 'downloadable', 'advanced', 94 ),
		edit( 'menu_order', 'advanced', 96 ),
		edit( 'short_description', 'content', 100 ),
		edit( 'description', 'content', 101 ),
		edit( 'notes', 'notes', 10 ),
	];
}

function cards( fields: FormField[] ): FormField[] {
	return fields.flatMap( ( entry ) => ( entry.id === 'columns' ? ( entry.children as FormField[] ).flatMap( ( column ) => column.children as FormField[] ) : [ entry ] ) );
}

function ids( children: Array< string | FormField > ): string[] {
	return children.flatMap( ( child ) => ( typeof child === 'string' ? [ child ] : ids( child.children as Array< string | FormField > ) ) );
}

describe( 'buildInlineForm', () => {
	it( 'puts one card per section in task order when the form is narrow, status and categories before the stock', () => {
		const form: Form = buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings );

		expect( form.layout ).toEqual( { type: 'regular', labelPosition: 'top' } );
		expect( ( form.fields as FormField[] ).map( ( card ) => card.id ) ).toEqual( [
			'group:general',
			'group:pricing',
			'group:visibility',
			'group:organization',
			'group:inventory',
			'group:content',
			'group:notes',
			'group:shipping',
			'group:tax',
			'group:advanced',
		] );
	} );

	it( 'splits a wide form into a main column of the work and a side column of the settings', () => {
		const form = buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings, { columns: 2 } );
		const [ row ] = form.fields as FormField[];

		expect( row ).toMatchObject( { id: 'columns', layout: { type: 'row', alignment: 'start', styles: { 'column:main': { flex: '1.7 1 0' }, 'column:side': { flex: '1 1 0' } } } } );

		const [ main, side ] = row!.children as FormField[];

		expect( ( main!.children as FormField[] ).map( ( card ) => card.id ) ).toEqual( [ 'group:general', 'group:pricing', 'group:inventory', 'group:content', 'group:notes' ] );
		expect( ( side!.children as FormField[] ).map( ( card ) => card.id ) ).toEqual( [ 'group:visibility', 'group:organization', 'group:shipping', 'group:tax', 'group:advanced' ] );
	} );

	it( 'puts SKU under Inventory and every shipping field in one Shipping card, with the pairs side by side', () => {
		const all = cards( buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings ).fields as FormField[] );
		const byId = Object.fromEntries( all.map( ( card ) => [ card.id, card ] ) );

		expect( all.filter( ( card ) => card.label === 'Shipping' ) ).toHaveLength( 1 );
		expect( ids( byId[ 'group:shipping' ]!.children as FormField[] ) ).toEqual( [ 'virtual', 'weight', 'shipping_class' ] );
		expect( byId[ 'group:inventory' ]!.children ).toEqual( [
			'sku',
			'manage_stock',
			{ id: 'pair:stock_quantity', layout: { type: 'row', alignment: 'start' }, children: [ 'stock_quantity', 'stock_status' ] },
			{ id: 'pair:backorders', layout: { type: 'row', alignment: 'start' }, children: [ 'backorders', 'low_stock_amount' ] },
			'sold_individually',
		] );
		expect( byId[ 'group:pricing' ]!.children ).toEqual( [
			{ id: 'pair:regular_price', layout: { type: 'row', alignment: 'start' }, children: [ 'regular_price', 'sale_price' ] },
			{ id: 'pair:date_on_sale_from', layout: { type: 'row', alignment: 'start' }, children: [ 'date_on_sale_from', 'date_on_sale_to' ] },
		] );
		expect( ids( byId[ 'group:visibility' ]!.children as FormField[] ) ).toEqual( [ 'status', 'catalog_visibility', 'featured' ] );
		// An extension's GTIN sits beside the SKU.
		expect( layoutGroupOf( edit( 'global_unique_id', 'general', 30 ) ) ).toBe( 'inventory' );
	} );

	it( 'collapses the rarely used sections, with a value summary in quick edit only, and opens one for a field', () => {
		const quick = Object.fromEntries( cards( buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings ).fields as FormField[] ).map( ( card ) => [ card.id, card ] ) );

		expect( quick[ 'group:pricing' ]!.layout ).toEqual( { type: 'card', isCollapsible: false } );
		expect( quick[ 'group:shipping' ]!.layout ).toEqual( { type: 'card', isCollapsible: true, isOpened: false, summary: [ 'shipping_class' ] } );
		expect( quick[ 'group:tax' ]!.layout ).toEqual( { type: 'card', isCollapsible: true, isOpened: false, summary: [ 'tax_status' ] } );
		expect( quick[ 'group:advanced' ]!.layout ).toEqual( { type: 'card', isCollapsible: true, isOpened: false, summary: [] } );

		const bulk = Object.fromEntries(
			cards( buildInlineForm( registryFields(), general, [ simple( 1 ), simple( 2 ) ], settings, { bulk: true, open: new Set( [ 'weight' ] ), pending: new Set( [ 'weight' ] ) } ).fields as FormField[] ).map( ( card ) => [ card.id, card ] )
		);

		expect( bulk[ 'group:shipping' ] ).toMatchObject( { label: 'Shipping •', layout: { type: 'card', isCollapsible: true, isOpened: true, summary: [] } } );
		expect( bulk[ 'group:tax' ] ).toMatchObject( { label: 'Tax', layout: { isOpened: false, summary: [] } } );
	} );

	it( 'puts the short description under the name in a quick edit, and with the description in a bulk edit', () => {
		const quick = Object.fromEntries( cards( buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings ).fields as FormField[] ).map( ( card ) => [ card.id, ids( card.children as FormField[] ) ] ) );

		expect( quick[ 'group:general' ] ).toEqual( [ 'name', 'slug', 'short_description' ] );
		expect( quick[ 'group:content' ] ).toEqual( [ 'description' ] );

		const bulk = Object.fromEntries( cards( buildInlineForm( registryFields(), general, [ simple( 1 ), simple( 2 ) ], settings, { bulk: true } ).fields as FormField[] ).map( ( card ) => [ card.id, ids( card.children as FormField[] ) ] ) );

		expect( bulk[ 'group:content' ] ).toEqual( [ 'short_description', 'description' ] );
	} );

	it( 'marks every card holding a pending edit, open or collapsed', () => {
		const all = Object.fromEntries( cards( buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings, { pending: new Set( [ 'sale_price', 'tax_status' ] ) } ).fields as FormField[] ).map( ( card ) => [ card.id, card.label ] ) );

		expect( all[ 'group:pricing' ] ).toBe( 'Pricing •' );
		expect( all[ 'group:tax' ] ).toBe( 'Tax •' );
		expect( all[ 'group:inventory' ] ).toBe( 'Inventory' );
	} );

	it( 'keeps Shipping, Tax and Advanced in the side column in a bulk edit too, however long Organization gets', () => {
		const bulkFields = [
			...registryFields().filter( ( entry ) => ! [ 'name', 'slug', 'sku', 'short_description', 'description', 'notes' ].includes( entry.id ) ),
			edit( 'tags', 'organization', 41, { type: 'array' } ),
			edit( 'brands', 'organization', 42, { type: 'array' } ),
			edit( 'categories_op', 'organization', 39.5 ),
			edit( 'tags_op', 'organization', 40.5 ),
			edit( 'brands_op', 'organization', 41.5 ),
		].map( ( entry ) => ( entry.id === 'categories' ? { ...entry, type: 'array' as const } : entry ) );
		const [ row ] = buildInlineForm( bulkFields.filter( ( entry ) => ! entry.id.startsWith( 'stock_' ) && ! [ 'backorders', 'low_stock_amount', 'sold_individually', 'date_on_sale_from', 'date_on_sale_to' ].includes( entry.id ) ), general, [ simple( 1 ), simple( 2 ) ], settings, { columns: 2, bulk: true } ).fields as FormField[];
		const [ main, side ] = row!.children as FormField[];

		expect( ( main!.children as FormField[] ).map( ( card ) => card.id ) ).toEqual( [ 'group:pricing', 'group:inventory' ] );
		expect( ( side!.children as FormField[] ).map( ( card ) => card.id ) ).toEqual( [ 'group:visibility', 'group:organization', 'group:shipping', 'group:tax', 'group:advanced' ] );
	} );

	it( 'keeps Pricing with only the apply-to-variations control, first in the card', () => {
		const leads = { pricing: [ APPLY_TO_VARIATIONS_FIELD_ID ] };
		const withoutPrices = registryFields().filter( ( entry ) => ! [ 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to' ].includes( entry.id ) );
		const only = cards( buildInlineForm( withoutPrices, general, [ simple( 1 ) ], settings, { leads } ).fields as FormField[] );

		expect( only[ 1 ] ).toMatchObject( { id: 'group:pricing', label: 'Pricing', children: [ APPLY_TO_VARIATIONS_FIELD_ID ] } );

		const full = cards( buildInlineForm( registryFields(), general, [ simple( 1 ) ], settings, { leads } ).fields as FormField[] );

		expect( ids( full[ 1 ]!.children as FormField[] ) ).toEqual( [ APPLY_TO_VARIATIONS_FIELD_ID, 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to' ] );
	} );

	it( 'splits a language tab into Translation, Prices and SEO', () => {
		const fields = [
			edit( 'i18n:se.name', 'i18n:se', 1 ),
			edit( 'i18n:se.meta_title', 'i18n:se', 2 ),
			edit( 'i18n:se.regular_price', 'i18n:se', 3 ),
			edit( 'i18n:se.sale_price', 'i18n:se', 4 ),
			edit( 'i18n:se.description', 'i18n:se', 5 ),
		];

		expect( sectionsOfTab( fields, se ) ).toEqual( [
			{ group: 'translation', fields: [ 'i18n:se.name', 'i18n:se.description' ] },
			{ group: 'prices', fields: [ 'i18n:se.regular_price', 'i18n:se.sale_price' ] },
			{ group: 'seo', fields: [ 'i18n:se.meta_title' ] },
		] );

		const [ row ] = buildInlineForm( fields, se, [ simple( 1 ) ], settings, { columns: 2, leads: { prices: [ APPLY_TO_VARIATIONS_FIELD_ID ] } } ).fields as FormField[];
		const [ main, side ] = row!.children as FormField[];

		expect( ( main!.children as FormField[] ).map( ( card ) => card.label ) ).toEqual( [ 'Translation' ] );
		expect( ( side!.children as FormField[] ).map( ( card ) => card.label ) ).toEqual( [ 'Prices', 'SEO' ] );
		expect( ids( ( side!.children as FormField[] )[ 0 ]!.children as FormField[] ) ).toEqual( [ APPLY_TO_VARIATIONS_FIELD_ID, 'i18n:se.regular_price', 'i18n:se.sale_price' ] );
	} );

	it( 'names the source language on the General tab of a translated shop, and the currency of a language\'s prices', () => {
		const translated = { ...settings, languages: { default: 'fi', others: [ 'se' ], labels: { fi: 'Suomi', se: 'Svenska' }, currencies: { se: 'SEK' } } };
		const labels = cards( buildInlineForm( registryFields(), general, [ simple( 1 ) ], translated ).fields as FormField[] ).map( ( card ) => card.label );

		expect( labels ).toContain( 'Product · Suomi' );
		expect( labels ).toContain( 'Description · Suomi' );
		expect( ( buildInlineForm( [ edit( 'i18n:se.regular_price', 'i18n:se', 1 ) ], se, [ simple( 1 ) ], translated ).fields as FormField[] )[ 0 ]!.label ).toBe( 'Prices (SEK)' );
	} );
} );

describe( 'formLabelOf', () => {
	const translated = { ...settings, languages: { default: 'fi', others: [ 'se' ], labels: { fi: 'Suomi', se: 'Svenska' } } };

	it( 'drops the tab name from a language field and uses the edit label where one is set', () => {
		expect( formLabelOf( field( 'i18n:se.name', { label: 'Svenska: Name', edit: { group: 'i18n:se', bulk: false } } ), translated ) ).toBe( 'Name' );
		expect( formLabelOf( field( 'i18n:se.name', { label: 'Name (Svenska)', edit: { group: 'i18n:se', bulk: false } } ), translated ) ).toBe( 'Name' );
		expect( formLabelOf( field( 'i18n:se.name', { label: 'i18n:se.name', edit: { group: 'i18n:se', bulk: false } } ), translated ) ).toBe( 'i18n:se.name' );
		expect( formLabelOf( field( 'stock_status', { label: 'Stock', edit: { group: 'inventory', bulk: 'default', label: 'Stock status' } } ), translated ) ).toBe( 'Stock status' );
		expect( formLabelOf( field( 'name', { label: 'Name' } ), translated ) ).toBe( 'Name' );
	} );
} );

describe( 'the apply-to-variations control field', () => {
	it( 'is form-only: it reads nothing and writes nothing to the form data', () => {
		const control = applyControlField( 'Set the price of all its variations' );

		expect( control.id ).toBe( APPLY_TO_VARIATIONS_FIELD_ID );
		expect( control.getValue?.( { item: { regular_price: '10' } } as never ) ).toBeUndefined();
		expect( control.setValue?.( { item: {}, value: true } as never ) ).toEqual( {} );
	} );
} );

describe( 'section notes', () => {
	it( 'end the section they belong to and never make a card of their own', () => {
		const sections = sectionsOfTab( registryFields(), general, {}, false, { inventory: [ sectionNoteFieldId( 'inventory' ) ], external: [ sectionNoteFieldId( 'external' ) ] } );
		const inventory = sections.find( ( section ) => section.group === 'inventory' );

		expect( inventory?.fields[ inventory.fields.length - 1 ] ).toBe( sectionNoteFieldId( 'inventory' ) );
		expect( sections.some( ( section ) => section.group === 'external' ) ).toBe( false );
	} );
} );
