import { describe, expect, it } from 'vitest';
import { isPlainTextField, referenceText, toFormFields, VARIATION_STATUS_ELEMENTS, variationShippingClassElements, variationTaxClassElements } from '../../resources/edit/form-fields';
import { describeConflictValues } from '../../resources/edit/errors';
import { mergeItems, MIXED_VALUE } from '../../resources/edit/merge';
import { validateFormData } from '../../resources/edit/validity';
import { effectiveEdits } from '../../resources/edit/use-edit-state';
import type { ProductField, ProductListItem } from '../../resources/types';
import { coreFields, editSettings, field, simple, variable, variation } from './edit-fixtures';

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

	it( 'formats a market price that takes no bulk op in its own currency', () => {
		// gds-woo-i18n's market prices: `bulk: false` (they change in bulk through "Adjust market prices"), in SEK.
		const market = { ...field( 'i18n:se.regular_price', { edit: { group: 'i18n:se', bulk: false } } ), currency: { code: 'SEK', symbol: 'kr', decimals: 2 } };

		expect( referenceText( market, '159', settings ) ).toBe( '159,00 kr' );
	} );

	it( 'reaches the form field description as "Default: …"', () => {
		const fields = coreFields();
		const item = simple( 1, { i18n: { se: { name: { value: '', source: '<b>Saga</b>' } } } } );

		expect( formFor( fields, [ item ] ).get( 'i18n:se.name' ).description ).toBe( 'Default: Saga' );
	} );

	it( 'names the fallback text the shop shows now before the default', () => {
		// As fieldFromDeclarative builds it from the value's container (`effective` + `shownLabel`).
		const fields = coreFields().map( ( f ) =>
			f.id === 'i18n:se.name'
				? {
						...f,
						shownReference: ( row: ProductListItem ) => {
							const entry = ( row as unknown as { i18n?: { se?: { name?: { effective?: string; shownLabel?: string } } } } ).i18n?.se?.name;

							return entry?.effective && entry.shownLabel ? { label: entry.shownLabel, text: entry.effective } : null;
						},
				  }
				: f
		);
		const item = simple( 1, { i18n: { se: { name: { value: '', source: 'Saga FI', effective: 'Saga EN', effectiveLang: 'en', shownLabel: 'Shown now (English fallback)' } } } } );

		expect( formFor( fields, [ item ] ).get( 'i18n:se.name' ).description ).toBe( 'Shown now (English fallback): Saga EN · Default: Saga FI' );
		// Bulk over several rows keeps the plain default line.
		expect( formFor( fields, [ item, simple( 2, { i18n: { se: { name: { value: '', source: 'Saga FI' } } } } ) ] ).get( 'i18n:se.name' ).description ).toBe( 'Default: Saga FI' );
	} );
} );

describe( 'variation shipping class', () => {
	const shipping = field( 'shipping_class', { elements: [ { value: '', label: 'No shipping class' }, { value: 'bulky', label: 'Bulky' } ], rest: { fields: [ 'shipping_class' ], applies: { product: true, variation: true } } } );
	const withClasses = editSettings( { shippingClasses: [ { id: 7, value: 'bulky', label: 'Bulky' } ] } );

	it( 'offers "Same as parent" plus the store classes for variations, the product list otherwise', () => {
		const merged = mergeItems( [ variation( 11, 1 ) ], [ shipping ] );
		const forVariation = toFormFields( [ shipping ], { bulk: false, items: [ variation( 11, 1 ) ], base: merged.data, mixed: merged.mixed, settings: withClasses } )[ 0 ]!;

		expect( forVariation.elements ).toEqual( [ { value: '', label: 'Same as parent' }, { value: 'bulky', label: 'Bulky' } ] );
		expect( variationShippingClassElements( withClasses ) ).toHaveLength( 2 );
		expect( formFor( [ shipping ], [ simple( 1 ) ] ).get( 'shipping_class' ).elements?.[ 0 ] ).toEqual( { value: '', label: 'No shipping class' } );
	} );
} );

describe( 'variation tax class', () => {
	const taxSettings = editSettings( { taxClasses: [ { value: '', label: 'Standard' }, { value: 'reduced-rate', label: 'Reduced rate' } ] } );
	const tax = field( 'tax_class', { elements: taxSettings.taxClasses, rest: { fields: [ 'tax_class' ], applies: { product: true, variation: true } }, edit: { group: 'tax', bulk: 'default' } } );

	it( 'offers "Same as parent" (stored as parent) for variations, so a variation loaded with it validates', () => {
		const items = [ variation( 11, 1, { tax_class: 'parent' } ) ];
		const merged = mergeItems( items, [ tax ] );
		const formField = toFormFields( [ tax ], { bulk: false, items, base: merged.data, mixed: merged.mixed, settings: taxSettings } )[ 0 ]!;

		expect( merged.data.tax_class ).toBe( 'parent' );
		expect( formField.elements ).toEqual( [ { value: 'parent', label: 'Same as parent' }, { value: '', label: 'Standard' }, { value: 'reduced-rate', label: 'Reduced rate' } ] );
		expect( validateFormData( merged.data, [ { ...formField, isValid: { elements: true } } as never ] ) ).toEqual( [] );
		expect( variationTaxClassElements( taxSettings ) ).toHaveLength( 3 );
		// A product never takes `parent`.
		expect( formFor( [ tax ], [ simple( 1 ) ] ).get( 'tax_class' ).elements?.map( ( e ) => e.value ) ).toEqual( [ '', 'reduced-rate' ] );
	} );

	it( 'names parent "Same as parent" in the conflict text', () => {
		expect( describeConflictValues( { fields: [ 'tax_class' ], current: { tax_class: 'reduced-rate' }, expected: { tax_class: 'parent' } } ) ).toBe( 'tax_class reduced-rate (was Same as parent when loaded)' );
	} );
} );

describe( 'market price reference of a variable product', () => {
	// gds-woo-i18n's SEK prices: a variable product has none of its own, its variations carry the converted default.
	const sek = { code: 'SEK', symbol: 'kr', decimals: 2 };
	const fields = coreFields().map( ( f ) => ( f.id === 'i18n:se.regular_price' || f.id === 'i18n:se.sale_price' ? { ...f, currency: sek } : f ) );
	const sekPrice = ( source: string ) => ( { i18n: { se: { regular_price: { value: '', source }, sale_price: { value: '', source: '' } } } } );
	const parent = variable( 10, sekPrice( '' ) );
	const variations = [ variation( 11, 10, sekPrice( '2045' ) ), variation( 12, 10, sekPrice( '2045' ) ) ];

	function quickEdit( variationRows?: ProductListItem[] ) {
		const merged = mergeItems( [ parent ], fields, { applyToVariations: true } );

		return toFormFields( fields, { bulk: false, items: [ parent ], base: merged.data, mixed: merged.mixed, settings, sellableOps: true, variationRows } ).find( ( f ) => f.id === 'i18n:se.regular_price' )!;
	}

	it( '"Set the price of all its variations" shows the variations\' default price', () => {
		expect( quickEdit( variations ).Edit ).toBeTypeOf( 'function' );
		// The bulk numeric control takes the reference as its help; the description is the plain field's.
		expect( quickEdit( variations ).description ).toBe( 'Default: 2 045,00 kr' );
		expect( quickEdit().description ).toBeUndefined();
	} );

	it( 'says Mixed when the variations convert to different prices', () => {
		expect( quickEdit( [ variations[ 0 ]!, variation( 13, 10, sekPrice( '1395' ) ) ] ).description ).toBe( 'Default: Mixed' );
	} );
} );

describe( 'reference entities', () => {
	it( 'decodes HTML entities and non-breaking spaces in the Default: help text', () => {
		const text = field( 'i18n:se.short_description', { edit: { group: 'i18n:se', bulk: false } } );

		expect( referenceText( text, '<b>Knitido Cotton &amp; Merino Tabi</b>&nbsp;on suosittu varvassukka', settings ) ).toBe( 'Knitido Cotton & Merino Tabi on suosittu varvassukka' );
		expect( referenceText( text, 'Tom &amp; Jerry', settings ) ).toBe( 'Tom & Jerry' );
	} );
} );

describe( 'mixed text fields in bulk', () => {
	const fields = coreFields();

	it( 'get the Mixed text control with a "Clear on all rows" choice; agreeing rows and quick edit keep the plain control', () => {
		const mixed = formFor( fields, [ simple( 1, { dimensions: 'a' } ), simple( 2, { dimensions: 'b' } ) ] );
		const same = formFor( fields, [ simple( 1, { dimensions: 'a' } ), simple( 2, { dimensions: 'a' } ) ] );
		const quick = formFor( fields, [ simple( 1, { dimensions: 'a' } ) ] );

		expect( typeof mixed.get( 'dimensions' ).Edit ).toBe( 'function' );
		expect( mixed.get( 'dimensions' ).type ).toBeUndefined();
		expect( same.get( 'dimensions' ).Edit ).toBeUndefined();
		expect( quick.get( 'dimensions' ).Edit ).toBeUndefined();
		// Numeric ops and selects have their own controls.
		expect( isPlainTextField( fields.find( ( field ) => field.id === 'regular_price' )! ) ).toBe( false );
		expect( isPlainTextField( fields.find( ( field ) => field.id === 'featured' )! ) ).toBe( false );
	} );
} );

describe( 'clearing a number in a quick edit', () => {
	it( 'an emptied weight or low stock threshold is an edit that clears it', async () => {
		const { createWeightField } = await import( '../../resources/fields/shipping' );
		const { createLowStockAmountField } = await import( '../../resources/fields/low-stock-amount' );
		const { buildPayload } = await import( '../../resources/edit/payload' );
		const { effectiveEdits } = await import( '../../resources/edit/use-edit-state' );
		const fields = [ createWeightField( settings ), createLowStockAmountField( settings ) ];
		const item = simple( 1, { weight: '0.25', low_stock_amount: 2, manage_stock: true, stock_quantity: 3 } );
		const merged = mergeItems( [ item ], fields );
		const { get } = formFor( fields, [ item ], false );

		// DataViews' number controls report an emptied input as undefined.
		const edits = { ...get( 'weight' ).setValue!( { item: merged.data, value: undefined } ), ...get( 'low_stock_amount' ).setValue!( { item: merged.data, value: undefined } ) };
		const effective = effectiveEdits( edits, merged.data, merged.mixed );

		expect( effective ).toEqual( { weight: '', low_stock_amount: '' } );
		// wc/v3 clears the weight with '' and the low stock threshold with null ('' would be stored as 0).
		expect( buildPayload( item, effective, fields, settings ) ).toEqual( { weight: '', low_stock_amount: null } );
		expect( buildPayload( item, { low_stock_amount: 5 }, fields, settings ) ).toEqual( { low_stock_amount: 5 } );
	} );
} );

describe( 'a negative menu order', () => {
	it( 'is a valid menu order in a quick edit (WooCommerce sorts -1 first), while a negative quantity is not', async () => {
		const { validateBulkNumericEdits } = await import( '../../resources/edit/bulk-numeric' );
		const menuOrder = field( 'menu_order', { type: 'integer', rest: { fields: [ 'menu_order' ], applies: { product: true, variation: true } }, edit: { group: 'advanced', bulk: 'integer' } } );
		const stock = field( 'stock_quantity', { type: 'integer', rest: { fields: [ 'stock_quantity' ], applies: { product: true, variation: true } }, edit: { group: 'inventory', bulk: 'integer' } } );
		const item = simple( 1, { menu_order: 0, manage_stock: true, stock_quantity: 3 } );
		const { formFields } = formFor( [ menuOrder, stock ], [ item ], false );
		const messages = validateFormData( { menu_order: '-2', stock_quantity: '-2' }, formFields as never ).map( ( entry ) => `${ entry.field }: ${ entry.message }` );

		expect( messages ).toEqual( [ 'stock_quantity: The quantity cannot be negative.' ] );
		expect( validateBulkNumericEdits( [ item ], { menu_order: -2 }, [ menuOrder, stock ], settings ) ).toEqual( [] );
	} );
} );

describe( 'quick edit Name with entities', () => {
	it( 'shows a title stored with "&amp;" (saved by a shop manager) as "&", and keeps the stored value as the form value', () => {
		const name = coreFields().find( ( f ) => f.id === 'name' )!;
		const item = simple( 1, { name: 'Socks &amp; laces' } );
		const { data, get } = formFor( [ name ], [ item ], false );
		const form = get( 'name' );

		expect( form.getValue!( { item: data } as never ) ).toBe( 'Socks & laces' );
		expect( ( data as Record< string, unknown > ).name ).toBe( 'Socks &amp; laces' );
	} );

	it( 'counts the shown text typed back (a character typed, then deleted) as no change, and any other text as an edit', () => {
		const name = coreFields().find( ( f ) => f.id === 'name' )!;
		const item = simple( 1, { name: 'Socks &amp; laces' } );
		const merged = mergeItems( [ item ], [ name ] );
		const form = toFormFields( [ name ], { bulk: false, items: [ item ], base: merged.data, mixed: merged.mixed, settings } ).find( ( f ) => f.id === 'name' )!;
		const typed = ( value: string ) => form.setValue!( { item: { ...merged.data, name: value }, value } as never ) as Record< string, unknown >;

		// Back to the shown text: the stored value again, so the edit drops out (no dirty form, no "1 item updated").
		expect( typed( 'Socks & laces' ) ).toEqual( { name: 'Socks &amp; laces' } );
		expect( effectiveEdits( typed( 'Socks & laces' ), merged.data, merged.mixed ) ).toEqual( {} );
		// A real change is kept as typed.
		expect( typed( 'Socks & laces 2' ) ).toEqual( { name: 'Socks & laces 2' } );
		expect( effectiveEdits( typed( 'Socks & laces 2' ), merged.data, merged.mixed ) ).toEqual( { name: 'Socks & laces 2' } );
	} );
} );
