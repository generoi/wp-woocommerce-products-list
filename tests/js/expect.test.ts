/**
 * `_wcpl_expect` (docs/contracts.md §3.6): which loaded values a write
 * carries, per field family, in the form the server compares
 * (`Concurrency::conflicts()` against `Recorder::read()`).
 */
import { describe, expect, it } from 'vitest';
import { expectedValues, writeItem } from '../../resources/edit/expect';
import { TranslationStore, translationWriteItem } from '../../resources/edit/translation-grid';
import type { ProductField, ProductListItem } from '../../resources/types';
import { editSettings, simple, variation } from './edit-fixtures';

const row = ( props: Record< string, unknown > ) => simple( 1, props ) as ProductListItem;

describe( 'expectedValues: core flags and texts', () => {
	it( 'sends the loaded manage_stock, virtual, downloadable, sold_individually and reviews_allowed', () => {
		const item = row( { manage_stock: false, virtual: true, downloadable: false, sold_individually: false, reviews_allowed: true } );

		expect( expectedValues( item, { manage_stock: true, virtual: false, downloadable: true, sold_individually: true, reviews_allowed: false } ) ).toEqual( {
			manage_stock: false,
			virtual: true,
			downloadable: false,
			sold_individually: false,
			reviews_allowed: true,
		} );
	} );

	it( 'sends the loaded external_url, button_text and slug', () => {
		const item = row( { type: 'external', external_url: 'https://a.example', button_text: 'Buy', slug: 'old-slug' } );

		expect( expectedValues( item, { external_url: 'https://b.example', button_text: 'Shop', slug: 'new-slug' } ) ).toEqual( {
			external_url: 'https://a.example',
			button_text: 'Buy',
			slug: 'old-slug',
		} );
	} );

	it( 'sends a variation\'s manage_stock as loaded, `parent` included', () => {
		expect( expectedValues( variation( 41, 4, { manage_stock: 'parent' } ) as ProductListItem, { manage_stock: true } ) ).toEqual( { manage_stock: 'parent' } );
	} );

	it( 'sends nothing for a field the row did not load', () => {
		expect( expectedValues( row( {} ), { button_text: 'Shop' } ) ).toBeNull();
	} );
} );

describe( 'expectedValues: meta_data', () => {
	it( 'sends a single loaded value, null for a key the loaded list lacks (shown empty), nothing when the row has no list', () => {
		const payload = { meta_data: [ { key: '_a', value: 'x' }, { key: '_b', value: 'y' }, { key: '_c', value: 'z' } ] };
		const item = row( { meta_data: [ { key: '_a', value: 'a0' }, { key: '_c', value: 'c1' }, { key: '_c', value: 'c2' } ] } );

		// _c holds two values: no single stored form to compare.
		expect( expectedValues( item, payload ) ).toEqual( { 'meta_data._a': 'a0', 'meta_data._b': null } );
		expect( expectedValues( row( {} ), payload ) ).toBeNull();
	} );
} );

describe( 'expectedValues: names', () => {
	it( 'sends a product\'s loaded name', () => {
		expect( expectedValues( row( { name: 'Pelsi' } ), { name: 'Pelsi 2' } ) ).toEqual( { name: 'Pelsi' } );
	} );

	it( 'sends a variation\'s name as loaded (the wc/v3 attribute summary, which the server also accepts)', () => {
		const item = variation( 2512, 2500, { name: 'Juli, 31' } ) as ProductListItem;

		expect( expectedValues( item, { name: 'Juli, 31 X' } ) ).toEqual( { name: 'Juli, 31' } );
		expect( writeItem( item, { name: 'Juli, 31 X', regular_price: '60' } ) ).toEqual( { id: 2512, name: 'Juli, 31 X', regular_price: '60', _wcpl_expect: { name: 'Juli, 31', regular_price: '50' } } );
	} );
} );

describe( 'expectedValues: dimensions', () => {
	it( 'sends all three axes as strings in the stored order, whichever the write changes', () => {
		const item = row( { dimensions: { height: '', width: 4, length: '10' } } );

		expect( JSON.stringify( expectedValues( item, { dimensions: { length: '12' } } ) ) ).toBe( '{"dimensions":{"length":"10","width":"4","height":""}}' );
	} );

	it( 'sends nothing for dimensions the row did not load in their wc/v3 shape', () => {
		expect( expectedValues( row( { dimensions: '10 × 4' } ), { dimensions: { length: '12' } } ) ).toBeNull();
		expect( expectedValues( row( { dimensions: { length: { x: 1 }, width: '', height: '' } } ), { dimensions: { length: '12' } } ) ).toBeNull();
	} );
} );

describe( 'expectedValues: translations and market prices (i18n)', () => {
	const translated = ( props: Record< string, unknown > = {} ) =>
		row( {
			i18n: {
				se: { name: { value: 'Ullsockor', source: 'Villasukat' }, regular_price: { value: '1300', source: '129.00', currency: 'SEK' } },
				no: { name: { value: '', source: 'Villasukat', effective: 'Ullsockor', effectiveLang: 'se' } },
			},
			...props,
		} );

	it( 'flattens each written pair to i18n.{lang}.{field} with the stored value the row loaded', () => {
		expect( expectedValues( translated(), { i18n: { se: { name: 'Yllesockor', regular_price: '1400' }, no: { name: 'Ullsokker' } } } ) ).toEqual( {
			'i18n.se.name': 'Ullsockor',
			'i18n.se.regular_price': '1300',
			// An empty stored value is the expectation, not the fallback the shop shows.
			'i18n.no.name': '',
		} );
	} );

	it( 'skips pairs the row did not load (another tab\'s fields) and malformed entries', () => {
		expect( expectedValues( translated(), { i18n: { se: { short_description: '<p>Ny</p>' }, fi: { name: 'X' } } } ) ).toBeNull();
		expect( expectedValues( row( {} ), { i18n: { se: { name: 'X' } } } ) ).toBeNull();
		expect( expectedValues( row( { i18n: { se: { name: 'flat' } } } ), { i18n: { se: { name: 'X' } } } ) ).toBeNull();
	} );

	it( 'carries a quick edit of a variation\'s market price (the variations batch item)', () => {
		const item = variation( 3236, 3228, { i18n: { se: { regular_price: { value: '1200', source: '' } } } } ) as ProductListItem;

		expect( writeItem( item, { i18n: { se: { regular_price: '1300' } } } ) ).toEqual( {
			id: 3236,
			i18n: { se: { regular_price: '1300' } },
			_wcpl_expect: { 'i18n.se.regular_price': '1200' },
		} );
	} );
} );

describe( 'expectedValues: fields whose list form is not the stored one', () => {
	it( 'sends descriptions, images and cost of goods as loaded (the server accepts the rendered form)', () => {
		const item = row( {
			description: '<p>Text</p>\n',
			short_description: '<p>Short</p>\n',
			images: [ { id: 5, src: 'https://example.test/5.jpg' } ],
			cost_of_goods_sold: { values: [ { defined_value: 3, effective_value: 3 } ], total_value: 3 },
		} );

		expect(
			expectedValues( item, {
				description: 'Text 2',
				short_description: 'Short 2',
				images: [ { id: 6 } ],
				cost_of_goods_sold: { values: [ { defined_value: 4 } ] },
			} )
		).toEqual( {
			description: '<p>Text</p>\n',
			short_description: '<p>Short</p>\n',
			images: [ { id: 5 } ],
			cost_of_goods_sold: { values: [ { defined_value: 3, effective_value: 3 } ], total_value: 3 },
		} );
	} );

	it( 'sends [] for a row without an image, and nothing for an image list it cannot read', () => {
		expect( expectedValues( row( { images: [] } ), { images: [ { id: 6 } ] } ) ).toEqual( { images: [] } );
		expect( expectedValues( row( { images: [ { src: 'x' } ] } ), { images: [ { id: 6 } ] } ) ).toBeNull();
	} );

	it( 'sends a bare cost of goods number as loaded', () => {
		expect( expectedValues( row( { cost_of_goods_sold: 2.5 } ), { cost_of_goods_sold: { values: [ { defined_value: 4 } ] } } ) ).toEqual( { cost_of_goods_sold: 2.5 } );
	} );

	it( 'sends nothing for extension fields without rest.expect (last write wins)', () => {
		const item = row( { acme_extra: 'x' } );

		expect( expectedValues( item, { acme_extra: 'y' } ) ).toBeNull();
	} );

	it( 'sends the loaded attribute lists as loaded (the server accepts the wc/v3 form)', () => {
		const attributes = [ { id: 1, name: 'Colour', options: [ 'Red' ], visible: true, variation: true, position: 0 } ];
		const defaults = [ { id: 1, name: 'Colour', option: 'Red' } ];
		const item = row( { attributes, default_attributes: defaults } );

		expect( expectedValues( item, { attributes: [ { id: 1, options: [ 'Blue' ] } ], default_attributes: [] } ) ).toEqual( { attributes, default_attributes: defaults } );
		// Not loaded, or not a list of objects: nothing is known.
		expect( expectedValues( row( {} ), { attributes: [] } ) ).toBeNull();
		expect( expectedValues( row( { attributes: 'x' } ), { attributes: [] } ) ).toBeNull();
	} );
} );

describe( 'translationWriteItem: the translation grid', () => {
	function i18nField( lang: string, name: string ): ProductField {
		return {
			id: `i18n:${ lang }.${ name }`,
			label: `${ lang }: ${ name }`,
			type: 'text',
			setValue: ( { value }: { value: unknown } ) => ( { i18n: { [ lang ]: { [ name ]: { value } } } } ),
			rest: {
				fields: [ 'i18n' ],
				applies: { product: true, variation: false },
				read: ( item: unknown ) => ( item as { i18n?: Record< string, Record< string, { value?: string } > > } ).i18n?.[ lang ]?.[ name ]?.value,
				write: ( value: unknown ) => ( { i18n: { [ lang ]: { [ name ]: value } } } ),
			},
		} as unknown as ProductField;
	}

	it( 'expects the stored values the grid loaded, even when the editor\'s own row never loaded the language', () => {
		const fields = [ i18nField( 'se', 'name' ), i18nField( 'se', 'short_description' ) ];
		const store = new TranslationStore();

		store.set( 7, 'i18n:se.name', 'Yllesockor', 'Ullsockor' );
		store.set( 7, 'i18n:se.short_description', '<p>Varma</p>', '' );

		// The editor's row: what the list loaded (no Swedish texts); the grid loaded its own copy.
		const editorRow = simple( 7, { name: 'Villasukat' } ) as ProductListItem;
		const [ [ id, edits ] ] = store.entries() as [ [ number, Record< string, string > ] ];

		expect( translationWriteItem( editorRow, edits, store.originalsOf( id ), fields, editSettings() ) ).toEqual( {
			id: 7,
			i18n: { se: { name: 'Yllesockor', short_description: '<p>Varma</p>' } },
			_wcpl_expect: { 'i18n.se.name': 'Ullsockor', 'i18n.se.short_description': '' },
		} );
	} );

	it( 'forgets the original of an edit typed back to it, and of a saved product', () => {
		const store = new TranslationStore();

		store.set( 7, 'i18n:se.name', 'Yllesockor', 'Ullsockor' );
		store.set( 7, 'i18n:se.name', 'Ullsockor', 'Ullsockor' );
		expect( store.originalsOf( 7 ) ).toEqual( {} );

		store.set( 8, 'i18n:se.name', 'A', 'B' );
		store.clear( [ 8 ] );
		expect( store.originalsOf( 8 ) ).toEqual( {} );
	} );
} );

describe( 'translation grid base after typing back to the original', () => {
	it( 'keeps the shown value as the expected one when a reload brought a newer stored value meanwhile', async () => {
		const { TranslationStore } = await import( '../../resources/edit/translation-grid' );
		const store = new TranslationStore();

		// Shown 'A'; the user types 'AB', then back to 'A' (no edit), then a reload brings 'B' from another user.
		store.set( 1, 'i18n.se.name', 'AB', 'A' );
		store.set( 1, 'i18n.se.name', 'A', 'A' );
		expect( store.count() ).toBe( 0 );
		expect( store.originalsOf( 1 ) ).toEqual( {} );

		// The input still shows the user's text over 'A': the next keystroke must expect 'A', not 'B'.
		store.set( 1, 'i18n.se.name', 'AC', 'B' );
		expect( store.get( 1, 'i18n.se.name' ) ).toBe( 'AC' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n.se.name': 'A' } );

		store.clear( [ 1 ] );
		store.set( 1, 'i18n.se.name', 'BC', 'B' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n.se.name': 'B' } );
	} );
} );
