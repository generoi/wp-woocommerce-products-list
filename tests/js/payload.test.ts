import { addFilter, removeFilter } from '@wordpress/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPayload, hasPayload } from '../../resources/edit/payload';
import { FILTERS } from '../../resources/extensions/hooks';
import { coreFields, editSettings, simple, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

describe( 'buildPayload', () => {
	afterEach( () => removeFilter( FILTERS.savePayload, 'test/payload' ) );

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

		expect( payload ).toEqual( { regular_price: '80.00', stock_quantity: 10 } );
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
