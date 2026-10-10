/**
 * The expected value a save sends is the one the form showed when the user
 * started editing the field, never a value loaded afterwards.
 */
import { describe, expect, it } from 'vitest';
import { writeItem } from '../../resources/edit/expect';
import { changedSinceShown, pathsOfEdit, rowCarries, ShownValues } from '../../resources/edit/shown-values';
import type { ProductField, ProductListItem } from '../../resources/types';
import { createSalePriceField } from '../../resources/fields/sale-price';
import { createStockQuantityField } from '../../resources/fields/stock-quantity';
import { createStockStatusField } from '../../resources/fields/stock-status';
import { coreFields, editSettings, field, simple } from './edit-fixtures';

const i18nName = field( 'i18n:se.name', { rest: { fields: [ 'i18n.se.name' ], applies: { product: true, variation: false } } } );
const fields: ProductField[] = [ ...coreFields(), i18nName ];
const byId = new Map( fields.map( ( entry ) => [ entry.id, entry ] ) );

function row( id: number, extra: Record< string, unknown > ): ProductListItem {
	return simple( id, extra as Partial< ProductListItem > );
}

describe( 'pathsOfEdit', () => {
	it( 'maps form ids to the row paths they read', () => {
		expect( pathsOfEdit( 'regular_price', byId ) ).toEqual( [ 'regular_price' ] );
		expect( pathsOfEdit( 'i18n:se.name', byId ) ).toEqual( [ 'i18n.se.name' ] );
		expect( pathsOfEdit( 'schedule_sale', byId ) ).toEqual( [ 'date_on_sale_from', 'date_on_sale_to' ] );
		expect( pathsOfEdit( 'categories__op', new Map() ) ).toEqual( [ 'categories' ] );
	} );

	it( 'tells a loaded path from one the list did not carry', () => {
		const item = row( 1, { regular_price: '14', i18n: { se: { name: { value: 'Namn' } } } } );

		expect( rowCarries( item, [ 'regular_price', 'i18n.se.name' ] ) ).toBe( true );
		expect( rowCarries( item, [ 'i18n.de.name' ] ) ).toBe( false );
		expect( rowCarries( item, [ 'weight' ] ) ).toBe( false );
	} );
} );

describe( 'ShownValues', () => {
	it( 'sends the price the box showed, not the one loaded after the first keystroke', () => {
		const shown = new ShownValues();
		const listed = row( 7, { regular_price: '14', sku: 'A' } );

		// The user types into the price box while it shows the list's 14.
		shown.record( [ 'regular_price' ], [ listed ] );

		// The editor's load lands: someone else saved 16 meanwhile.
		const fresh = row( 7, { regular_price: '16', sku: 'B' } );
		const base = shown.baseRow( fresh, byId );

		expect( writeItem( base, { regular_price: '15' } )._wcpl_expect ).toEqual( { regular_price: '14' } );
		// A field the user had not touched yet takes the fresh row (the form showed it when they started on it).
		shown.record( [ 'sku' ], [ fresh ] );
		expect( writeItem( shown.baseRow( fresh, byId ), { regular_price: '15', sku: 'C' } )._wcpl_expect ).toEqual( { regular_price: '14', sku: 'B' } );
		// A first change keeps its rows: a later change of the same field does not move them.
		shown.record( [ 'regular_price' ], [ fresh ] );
		expect( shown.rowOf( 'regular_price', 7 ) ).toBe( listed );
	} );

	it( 'reads nested translation paths from the snapshot and leaves other languages alone', () => {
		const shown = new ShownValues();

		shown.record( [ 'i18n:se.name' ], [ row( 3, { i18n: { se: { name: { value: 'Gammal' } }, de: { name: { value: 'Alt' } } } } ) ] );
		const fresh = row( 3, { i18n: { se: { name: { value: 'Ny' } }, de: { name: { value: 'Neu' } } } } );
		const base = shown.baseRow( fresh, byId ) as unknown as { i18n: { se: { name: { value: string } }; de: { name: { value: string } } } };

		expect( base.i18n.se.name.value ).toBe( 'Gammal' );
		expect( base.i18n.de.name.value ).toBe( 'Neu' );
	} );

	it( 'takes a row loaded after the edit started as it is, and rebases only on request', () => {
		const shown = new ShownValues();
		const fresh = row( 9, { regular_price: '20' } );

		shown.record( [ 'regular_price' ], [ row( 8, { regular_price: '1' } ) ] );
		expect( shown.baseRow( fresh, byId ) ).toBe( fresh );

		shown.record( [ 'sale_price' ], [ row( 9, { sale_price: '5' } ) ] );
		shown.rebase( [ row( 9, { sale_price: '6' } ) ] );
		expect( writeItem( shown.baseRow( row( 9, { sale_price: '7' } ), byId ), { sale_price: '4' } )._wcpl_expect ).toEqual( { sale_price: '6' } );

		shown.forget();
		expect( shown.has( 'sale_price' ) ).toBe( false );
	} );
} );

describe( 'ShownValues with fields that share paths', () => {
	const settings = editSettings();
	const real = [ createSalePriceField( settings ), createStockStatusField( settings ), createStockQuantityField( settings ), ...coreFields().filter( ( entry ) => ! [ 'sale_price', 'stock_status', 'stock_quantity' ].includes( entry.id ) ) ];
	const realById = new Map( real.map( ( entry ) => [ entry.id, entry ] ) );

	it( 'keeps the regular price the box showed when the sale price is changed after a load brought another', () => {
		const shown = new ShownValues();
		const listed = row( 7, { regular_price: '14', sale_price: '' } );

		// Typed 15 into the regular price while the list's 14 showed.
		shown.record( [ 'regular_price' ], [ listed ] );
		// The load brings 16 (someone else's save); the user then changes the sale price.
		const hydrated = row( 7, { regular_price: '16', sale_price: '' } );
		shown.record( [ 'sale_price' ], [ hydrated ] );

		// Another tab merged in a new row object: no identity shortcut.
		const current = { ...hydrated } as ProductListItem;
		const sent = writeItem( shown.baseRow( current, realById ), { regular_price: '15', sale_price: '12' } )._wcpl_expect;

		expect( sent ).toEqual( { regular_price: '14', sale_price: '' } );
		// The same row object as the snapshot gives the same answer.
		expect( writeItem( shown.baseRow( hydrated, realById ), { regular_price: '15', sale_price: '12' } )._wcpl_expect ).toEqual( sent );
	} );

	it( 'settles the stock quantity from the field changed first, and from a later one only when the first did not carry it', () => {
		const shown = new ShownValues();

		shown.record( [ 'stock_quantity' ], [ row( 4, { stock_status: 'instock', stock_quantity: 5, manage_stock: true } ) ] );
		shown.record( [ 'stock_status' ], [ row( 4, { stock_status: 'instock', stock_quantity: 9, manage_stock: true } ) ] );
		const current = row( 4, { stock_status: 'instock', stock_quantity: 9, manage_stock: true } );

		expect( writeItem( shown.baseRow( current, realById ), { stock_quantity: 6, stock_status: 'outofstock' } )._wcpl_expect ).toEqual( { stock_quantity: 5, stock_status: 'instock' } );

		// A first snapshot without the quantity (the list did not carry it): the field that showed it settles it.
		const later = new ShownValues();
		const listed = simple( 5, { stock_status: 'instock' } ) as unknown as Record< string, unknown >;
		delete listed.stock_quantity;
		later.record( [ 'stock_status' ], [ listed as unknown as ProductListItem ] );
		later.record( [ 'stock_quantity' ], [ row( 5, { stock_status: 'instock', stock_quantity: 3, manage_stock: true } ) ] );

		expect( writeItem( later.baseRow( row( 5, { stock_status: 'instock', stock_quantity: 8, manage_stock: true } ), realById ), { stock_quantity: 4 } )._wcpl_expect ).toEqual( { stock_quantity: 3 } );
	} );

	it( 'settles each meta key from the first snapshot that carries it, and expects nothing for a key none showed', () => {
		const metaField = ( id: string ) => field( id, { rest: { fields: [ 'meta_data' ], applies: { product: true, variation: true } } } );
		const metaById = new Map( [ metaField( 'note_a' ), metaField( 'note_b' ) ].map( ( entry ) => [ entry.id, entry ] ) );
		const shown = new ShownValues();

		shown.record( [ 'note_a' ], [ row( 2, { meta_data: [ { key: '_a', value: 'mine' } ] } ) ] );
		shown.record( [ 'note_b' ], [ row( 2, { meta_data: [ { key: '_a', value: 'theirs' }, { key: '_b', value: 'b1' } ] } ) ] );
		const current = row( 2, { meta_data: [ { key: '_a', value: 'theirs' }, { key: '_b', value: 'b2' }, { key: '_c', value: 'c-new' } ] } );
		const payload = { meta_data: [ { key: '_a', value: 'x' }, { key: '_b', value: 'y' }, { key: '_c', value: 'z' } ] };

		expect( writeItem( shown.baseRow( current, metaById ), payload )._wcpl_expect ).toEqual( { 'meta_data._a': 'mine', 'meta_data._b': 'b1' } );
	} );
} );

describe( 'changedSinceShown', () => {
	const price = byId.get( 'regular_price' )!;

	it( 'flags an untouched field whose value changed after it was first shown', () => {
		const first = new Map< string, string >();
		const shown = new ShownValues();
		const loaded = () => true;

		expect( changedSinceShown( [ price ], [ row( 1, { regular_price: '14' } ) ], first, shown, new Map(), loaded ) ).toEqual( [] );
		expect( changedSinceShown( [ price ], [ row( 1, { regular_price: '16' } ) ], first, shown, new Map(), loaded ) ).toEqual( [ { id: 'regular_price', now: '16', edited: false } ] );
	} );

	it( 'flags an edited field only when it changed since the edit started, and not when it holds the typed value', () => {
		const first = new Map< string, string >();
		const shown = new ShownValues();
		const loaded = () => true;
		const listed = row( 1, { regular_price: '14' } );

		changedSinceShown( [ price ], [ listed ], first, shown, new Map(), loaded );
		shown.record( [ 'regular_price' ], [ listed ] );

		expect( changedSinceShown( [ price ], [ row( 1, { regular_price: '16' } ) ], first, shown, new Map( [ [ 'regular_price', '15' ] ] ), loaded ) ).toEqual( [ { id: 'regular_price', now: '16', edited: true } ] );
		expect( changedSinceShown( [ price ], [ row( 1, { regular_price: '15' } ) ], first, shown, new Map( [ [ 'regular_price', '15' ] ] ), loaded ) ).toEqual( [] );
	} );

	it( 'says nothing about a field before its value loaded', () => {
		const first = new Map< string, string >();

		expect( changedSinceShown( [ price ], [ row( 1, {} ) ], first, new ShownValues(), new Map(), () => false ) ).toEqual( [] );
		expect( first.size ).toBe( 0 );
	} );
} );
