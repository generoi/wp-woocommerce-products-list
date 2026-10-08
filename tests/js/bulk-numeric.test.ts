import { describe, expect, it } from 'vitest';
import {
	applyNumericOp,
	formatNumeric,
	isNumericOp,
	numericKindOf,
	parseNumeric,
	projectEdits,
	roundTo,
	validateBulkNumericEdits,
	validateNumericOp,
	validateNumericOps,
} from '../../resources/edit/bulk-numeric';
import type { NumericOp } from '../../resources/edit/bulk-numeric';
import { coreFields, editSettings, field, simple, variation } from './edit-fixtures';

const settings = editSettings();
const settings0 = editSettings( { currency: { ...settings.currency, decimals: 0 } } );
const fields = coreFields();

const op = ( operation: NumericOp[ 'operation' ], value: string, percent = false ): NumericOp => ( { operation, value, percent } );

describe( 'parseNumeric', () => {
	it( 'parses numbers, strings with dot or the store decimal separator', () => {
		expect( parseNumeric( 12 ) ).toBe( 12 );
		expect( parseNumeric( '12.5' ) ).toBe( 12.5 );
		expect( parseNumeric( '12,5', settings ) ).toBe( 12.5 );
		expect( parseNumeric( ' 1 200,50 ', settings ) ).toBe( 1200.5 );
		expect( parseNumeric( '-3' ) ).toBe( -3 );
		expect( parseNumeric( '0' ) ).toBe( 0 );
	} );

	it( 'rejects empty and garbage', () => {
		expect( parseNumeric( '' ) ).toBeUndefined();
		expect( parseNumeric( null ) ).toBeUndefined();
		expect( parseNumeric( undefined ) ).toBeUndefined();
		expect( parseNumeric( 'abc' ) ).toBeUndefined();
		expect( parseNumeric( '1e3' ) ).toBeUndefined();
		expect( parseNumeric( NaN ) ).toBeUndefined();
		expect( parseNumeric( {} ) ).toBeUndefined();
	} );
} );

describe( 'rounding', () => {
	it( 'rounds to the currency precision and formats', () => {
		expect( roundTo( 1.005, 2 ) ).toBe( '1.01' );
		expect( roundTo( 2.675, 2 ) ).toBe( '2.68' );
		expect( roundTo( 10, 2 ) ).toBe( '10.00' );
		expect( roundTo( 10.5, 0 ) ).toBe( '11' );
		expect( formatNumeric( 12.345, 'money', settings ) ).toBe( '12.35' );
		expect( formatNumeric( 12.345, 'money', settings0 ) ).toBe( '12' );
		expect( formatNumeric( -4, 'money', settings ) ).toBe( '0.00' );
	} );

	it( 'rounds stock to an integer and clamps at zero', () => {
		expect( formatNumeric( 7.4, 'integer', settings ) ).toBe( '7' );
		expect( formatNumeric( 7.5, 'integer', settings ) ).toBe( '8' );
		expect( formatNumeric( -2, 'integer', settings ) ).toBe( '0' );
	} );
} );

describe( 'applyNumericOp', () => {
	it( 'does nothing for dont_change or unparsable input', () => {
		expect( applyNumericOp( '10', op( 'dont_change', '5' ), 'money', settings ) ).toBeNull();
		expect( applyNumericOp( '10', op( 'set', '' ), 'money', settings ) ).toBeNull();
		expect( applyNumericOp( '10', op( 'increase', 'x' ), 'money', settings ) ).toBeNull();
	} );

	it( 'sets', () => {
		expect( applyNumericOp( '10', op( 'set', '19.999' ), 'money', settings ) ).toBe( '20.00' );
		expect( applyNumericOp( '', op( 'set', '19,5' ), 'money', settings ) ).toBe( '19.50' );
		expect( applyNumericOp( null, op( 'set', '3' ), 'integer', settings ) ).toBe( '3' );
		expect( applyNumericOp( 5, op( 'set', '2.6' ), 'integer', settings ) ).toBe( '3' );
		expect( applyNumericOp( '10', op( 'set', '19.4' ), 'money', settings0 ) ).toBe( '19' );
	} );

	it( 'increases and decreases by amount', () => {
		expect( applyNumericOp( '100', op( 'increase', '10' ), 'money', settings ) ).toBe( '110.00' );
		expect( applyNumericOp( '100', op( 'decrease', '10' ), 'money', settings ) ).toBe( '90.00' );
		expect( applyNumericOp( 5, op( 'increase', '3' ), 'integer', settings ) ).toBe( '8' );
		expect( applyNumericOp( 5, op( 'decrease', '8' ), 'integer', settings ) ).toBe( '0' );
		expect( applyNumericOp( '10', op( 'decrease', '15' ), 'money', settings ) ).toBe( '0.00' );
	} );

	it( 'increases and decreases by percent', () => {
		expect( applyNumericOp( '100', op( 'increase', '10', true ), 'money', settings ) ).toBe( '110.00' );
		expect( applyNumericOp( '189', op( 'decrease', '20', true ), 'money', settings ) ).toBe( '151.20' );
		expect( applyNumericOp( '189', op( 'decrease', '20', true ), 'money', settings0 ) ).toBe( '151' );
		expect( applyNumericOp( '19.99', op( 'decrease', '33', true ), 'money', settings ) ).toBe( '13.39' );
		expect( applyNumericOp( '200', op( 'decrease', '150', true ), 'money', settings ) ).toBe( '0.00' );
	} );

	it( 'skips relative ops on an empty current value', () => {
		expect( applyNumericOp( '', op( 'increase', '10' ), 'money', settings ) ).toBeNull();
		expect( applyNumericOp( null, op( 'decrease', '10', true ), 'money', settings ) ).toBeNull();
		expect( applyNumericOp( undefined, op( 'increase', '1' ), 'integer', settings ) ).toBeNull();
	} );
} );

describe( 'validateNumericOp', () => {
	it( 'passes idle ops and valid input', () => {
		expect( validateNumericOp( undefined, 'money', settings ) ).toBeNull();
		expect( validateNumericOp( op( 'dont_change', 'x' ), 'money', settings ) ).toBeNull();
		expect( validateNumericOp( op( 'set', '12,5' ), 'money', settings ) ).toBeNull();
		expect( validateNumericOp( op( 'set', '12' ), 'integer', settings ) ).toBeNull();
	} );

	it( 'rejects empty, negative and fractional stock', () => {
		expect( validateNumericOp( op( 'set', '' ), 'money', settings ) ).toMatch( /number/ );
		expect( validateNumericOp( op( 'increase', '-1' ), 'money', settings ) ).toMatch( /negative/ );
		expect( validateNumericOp( op( 'set', '1.5' ), 'integer', settings ) ).toMatch( /whole/ );
	} );
} );

describe( 'numericKindOf', () => {
	it( 'reads edit.bulk and falls back to the known ids', () => {
		expect( numericKindOf( fields.find( ( f ) => f.id === 'regular_price' )! ) ).toBe( 'money' );
		expect( numericKindOf( fields.find( ( f ) => f.id === 'stock_quantity' )! ) ).toBe( 'integer' );
		expect( numericKindOf( fields.find( ( f ) => f.id === 'name' )! ) ).toBeNull();
		expect( numericKindOf( field( 'cost_of_goods_sold', { edit: { group: 'price', bulk: 'default' } } ) ) ).toBe( 'money' );
		expect( numericKindOf( field( 'i18n:se.stock_quantity', { edit: { group: 'x', bulk: 'default' } } ) ) ).toBe( 'integer' );
		expect( numericKindOf( field( 'regular_price', { edit: { group: 'price', bulk: false } } ) ) ).toBeNull();
		expect( numericKindOf( field( 'regular_price', { edit: false } ) ) ).toBeNull();
	} );
} );

describe( 'projectEdits', () => {
	it( 'resolves ops per item and passes plain values through', () => {
		const item = simple( 1, { regular_price: '100', sale_price: '', stock_quantity: 4 } );
		const projected = projectEdits( item, { regular_price: op( 'decrease', '10', true ), sale_price: op( 'increase', '5' ), stock_quantity: op( 'set', '9' ), status: 'draft' }, fields, settings );

		expect( projected ).toEqual( { regular_price: '90.00', stock_quantity: '9', status: 'draft' } );
	} );

	it( 'ignores ops for unknown or non-numeric fields and undefined values', () => {
		expect( projectEdits( simple( 1 ), { name: op( 'set', '1' ), nope: op( 'set', '1' ), status: undefined }, fields, settings ) ).toEqual( {} );
	} );

	it( 'recognises op objects', () => {
		expect( isNumericOp( op( 'set', '1' ) ) ).toBe( true );
		expect( isNumericOp( { operation: 'multiply', value: '1' } ) ).toBe( false );
		expect( isNumericOp( '1' ) ).toBe( false );
		expect( isNumericOp( null ) ).toBe( false );
	} );
} );

describe( 'validateBulkNumericEdits', () => {
	it( 'is empty when projected prices are consistent', () => {
		const items = [ simple( 1, { regular_price: '100', sale_price: '' } ), simple( 2, { regular_price: '50', sale_price: '40' } ) ];

		expect( validateBulkNumericEdits( items, { sale_price: op( 'set', '30' ) }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( items, { regular_price: op( 'increase', '10', true ) }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( items, {}, fields, settings ) ).toEqual( [] );
	} );

	it( 'reports every item whose sale price would reach its regular price', () => {
		const items = [ simple( 1, { regular_price: '100', sale_price: '' } ), simple( 2, { regular_price: '50', sale_price: '40' } ) ];
		const errors = validateBulkNumericEdits( items, { sale_price: op( 'set', '60' ) }, fields, settings );

		expect( errors ).toHaveLength( 1 );
		expect( errors[ 0 ] ).toMatchObject( { id: 2, field: 'sale_price' } );
		expect( errors[ 0 ]?.message ).toMatch( /lower than the regular price/ );
	} );

	it( 'checks sale against a regular price that is being changed at the same time', () => {
		const items = [ simple( 1, { regular_price: '100', sale_price: '90' } ) ];

		expect( validateBulkNumericEdits( items, { regular_price: op( 'decrease', '20', true ) }, fields, settings ) ).toHaveLength( 1 );
		expect( validateBulkNumericEdits( items, { regular_price: op( 'decrease', '20', true ), sale_price: op( 'decrease', '20', true ) }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( items, { regular_price: '80', sale_price: '80' }, fields, settings ) ).toHaveLength( 1 );
	} );

	it( 'a sale price without a regular price is an error, an empty sale price is fine', () => {
		expect( validateBulkNumericEdits( [ simple( 1, { regular_price: '' } ) ], { sale_price: '10' }, fields, settings ) ).toHaveLength( 1 );
		expect( validateBulkNumericEdits( [ simple( 1, { regular_price: '', sale_price: '5' } ) ], { sale_price: '' }, fields, settings ) ).toEqual( [] );
	} );

	it( 'validates plain values too: not a number, negative, fractional stock', () => {
		const item = simple( 1 );

		expect( validateBulkNumericEdits( [ item ], { regular_price: 'abc' }, fields, settings )[ 0 ]?.message ).toMatch( /not a number/ );
		expect( validateBulkNumericEdits( [ item ], { regular_price: '-1' }, fields, settings )[ 0 ]?.message ).toMatch( /negative/ );
		expect( validateBulkNumericEdits( [ item ], { stock_quantity: '1.5' }, fields, settings )[ 0 ]?.message ).toMatch( /whole/ );
	} );

	it( 'pairs extension prices by leaf, per language', () => {
		const item = variation( 11, 1, { i18n: { se: { regular_price: { value: '100' }, sale_price: { value: '' } } } } );

		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '120' ) }, fields, settings ) ).toMatchObject( [ { id: 11, field: 'i18n:se.sale_price' } ] );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '80' ) }, fields, settings ) ).toEqual( [] );
	} );

	it( 'validateNumericOps reports the invalid inputs by field', () => {
		expect( validateNumericOps( { regular_price: op( 'set', '' ), stock_quantity: op( 'increase', '2' ), name: 'x' }, fields, settings ) ).toEqual( [
			{ field: 'regular_price', message: expect.stringMatching( /number/ ) },
		] );
	} );
} );
