/**
 * The expected value a save sends is the one the form showed when the user
 * started editing the field, never a value loaded afterwards.
 */
import { describe, expect, it } from 'vitest';
import { writeItem } from '../../resources/edit/expect';
import { changedSinceShown, pathsOfEdit, rowCarries, ShownValues } from '../../resources/edit/shown-values';
import type { ProductField, ProductListItem } from '../../resources/types';
import { coreFields, field, simple } from './edit-fixtures';

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
