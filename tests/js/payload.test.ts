import { getSettings as getDateSettings, setSettings as setDateSettings } from '@wordpress/date';
import { addFilter, removeFilter } from '@wordpress/hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildPayload, hasPayload, toSiteDateTime } from '../../resources/edit/payload';
import { FILTERS } from '../../resources/extensions/hooks';
import { coreFields, editSettings, simple, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

describe( 'buildPayload', () => {
	const dateSettings = getDateSettings();

	// A +02:00 site (Europe/Helsinki in winter), as wp.date carries it on the admin page.
	beforeAll( () => setDateSettings( { ...dateSettings, timezone: { offset: 2, offsetFormatted: '2', string: 'Europe/Helsinki', abbr: 'EET' } } ) );
	afterAll( () => setDateSettings( dateSettings ) );
	afterEach( () => removeFilter( FILTERS.savePayload, 'test/payload' ) );

	it( 'sends scheduled sale dates as site-local wall-clock time, not the UTC instant the control emits', () => {
		const item = simple( 1, { date_on_sale_from: null, date_on_sale_to: null } );
		// DataForm's datetime control: "2026-11-01T00:00" typed on a Helsinki site → getDate(...).toISOString().
		const payload = buildPayload( item, { date_on_sale_from: '2026-10-31T22:00:00.000Z', date_on_sale_to: '2026-11-30T21:59:00.000Z' }, fields, settings );

		expect( payload ).toEqual( { date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T23:59:00' } );
		expect( toSiteDateTime( '2026-10-31T22:00:00Z' ) ).toBe( '2026-11-01T00:00:00' );
		expect( toSiteDateTime( '2026-10-31T23:00:00+01:00' ) ).toBe( '2026-11-01T00:00:00' );
		// Summer time: +03:00.
		expect( toSiteDateTime( '2026-06-30T21:00:00.000Z' ) ).toBe( '2026-07-01T00:00:00' );
		expect( toSiteDateTime( '2026-06-30T21:00:00.000Z', 'date' ) ).toBe( '2026-07-01' );
	} );

	it( 'leaves site-local dates alone, clears with null and skips an unchanged date', () => {
		const item = simple( 1, { date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: null } );

		expect( buildPayload( item, { date_on_sale_from: '2026-10-31T22:00:00.000Z' }, fields, settings ) ).toEqual( {} );
		expect( buildPayload( item, { date_on_sale_from: '2026-11-02T00:00:00' }, fields, settings ) ).toEqual( { date_on_sale_from: '2026-11-02T00:00:00' } );
		expect( buildPayload( item, { date_on_sale_from: '' }, fields, settings ) ).toEqual( { date_on_sale_from: null } );
		expect( toSiteDateTime( null ) ).toBeNull();
		expect( toSiteDateTime( 'not a date' ) ).toBe( 'not a date' );
	} );

	it( 'writes plain values under the wc/v3 key and skips unchanged ones', () => {
		const item = simple( 1, { status: 'publish', regular_price: '100' } );

		expect( buildPayload( item, { status: 'draft', regular_price: '100', name: 'Simple 1' }, fields, settings ) ).toEqual( { status: 'draft' } );
		expect( hasPayload( {} ) ).toBe( false );
		expect( hasPayload( { status: 'draft' } ) ).toBe( true );
	} );

	it( 'resolves numeric ops against the row and sends integers as numbers', () => {
		const item = simple( 1, { regular_price: '100', sale_price: '', stock_quantity: 4 } );
		const payload = buildPayload(
			item,
			{
				regular_price: { operation: 'decrease', value: '20', percent: true },
				sale_price: { operation: 'increase', value: '5' },
				stock_quantity: { operation: 'increase', value: '6' },
			},
			fields,
			settings
		);

		// The stock op goes as WooCommerce's inventory_delta: the server adds it to the stock at write time (an order placed meanwhile is kept).
		expect( payload ).toEqual( { regular_price: '80.00', inventory_delta: 6 } );
	} );

	it( 'sends a relative stock op as inventory_delta, and a decrease clamped at zero as the absolute 0', () => {
		expect( buildPayload( simple( 1, { manage_stock: true, stock_quantity: 62 } ), { stock_quantity: { operation: 'increase', value: '1' } }, fields, settings ) ).toEqual( {
			inventory_delta: 1,
		} );
		expect( buildPayload( simple( 1, { manage_stock: true, stock_quantity: 9 } ), { stock_quantity: { operation: 'decrease', value: '3' } }, fields, settings ) ).toEqual( {
			inventory_delta: -3,
		} );
		// Clamped at zero by the projection: absolute, so the write never leaves negative stock.
		expect( buildPayload( simple( 1, { manage_stock: true, stock_quantity: 9 } ), { stock_quantity: { operation: 'decrease', value: '20' } }, fields, settings ) ).toEqual( {
			stock_quantity: 0,
		} );
		// "Change to" stays absolute; a row without a stock number has no delta to add to.
		expect( buildPayload( simple( 1, { manage_stock: true, stock_quantity: 9 } ), { stock_quantity: { operation: 'set', value: '20' } }, fields, settings ) ).toEqual( { stock_quantity: 20 } );
	} );

	it( 'sends a plain stock value as a number and an empty one as null', () => {
		expect( buildPayload( simple( 1, { stock_quantity: 4 } ), { stock_quantity: '7' }, fields, settings ) ).toEqual( { stock_quantity: 7 } );
		expect( buildPayload( simple( 1, { stock_quantity: 4 } ), { stock_quantity: '' }, fields, settings ) ).toEqual( { stock_quantity: null } );
		expect( buildPayload( simple( 1, { stock_quantity: 4 } ), { stock_quantity: '4' }, fields, settings ) ).toEqual( {} );
	} );

	it( 'routes extension fields through rest.write and deep-merges the fragments', () => {
		const item = simple( 1, { i18n: { se: { name: { value: 'Old' }, sale_price: { value: '' } } } } );
		const payload = buildPayload( item, { 'i18n:se.name': 'Saga', 'i18n:se.sale_price': { operation: 'set', value: '12,5' }, status: 'draft' }, fields, settings );

		expect( payload ).toEqual( { i18n: { se: { name: 'Saga', sale_price: '12.50' } }, status: 'draft' } );
	} );

	it( 'turning the sale schedule off clears both dates; on sends only the dates given', () => {
		const item = simple( 1, { date_on_sale_from: '2026-10-01T00:00:00', date_on_sale_to: '2026-10-31T00:00:00' } );

		expect( buildPayload( item, { schedule_sale: false }, fields, settings ) ).toEqual( { date_on_sale_from: null, date_on_sale_to: null } );
		expect( buildPayload( item, { schedule_sale: true }, fields, settings ) ).toEqual( {} );
		expect( buildPayload( item, { schedule_sale: true, date_on_sale_to: '2026-11-30T00:00:00' }, fields, settings ) ).toEqual( { date_on_sale_to: '2026-11-30T00:00:00' } );
	} );

	it( 'ignores fields it does not know and undefined values', () => {
		expect( buildPayload( simple( 1 ), { nope: 'x', status: undefined }, fields, settings ) ).toEqual( {} );
	} );

	it( 'passes the result through wcProductsList.savePayload', () => {
		addFilter( FILTERS.savePayload, 'test/payload', ( payload: Record< string, unknown >, item: { id: number } ) => ( { ...payload, meta_data: [ { key: 'touched', value: item.id } ] } ) );

		expect( buildPayload( variation( 11, 1 ), { status: 'private' }, fields, settings ) ).toEqual( { status: 'private', meta_data: [ { key: 'touched', value: 11 } ] } );
	} );
} );
