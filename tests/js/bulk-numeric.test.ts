import { describe, expect, it } from 'vitest';
import {
	applyNumericOp,
	computeNumericOp,
	formatNumeric,
	projectWarnings,
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
import { coreFields, editSettings, field, simple, variable, variation } from './edit-fixtures';

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

	it( 'rounds exact half-cent ties up like PHP round(), in integer cents', () => {
		// Binary floating point puts 4.35 × 1.1 at 4.784999…; WooCommerce's classic bulk edit writes 4.79.
		expect( applyNumericOp( '4.35', op( 'increase', '10', true ), 'money', settings ) ).toBe( '4.79' );
		expect( applyNumericOp( '3.65', op( 'increase', '10', true ), 'money', settings ) ).toBe( '4.02' );
		expect( applyNumericOp( '4.77', op( 'increase', '50', true ), 'money', settings ) ).toBe( '7.16' );
		expect( applyNumericOp( '4.35', op( 'decrease', '50', true ), 'money', settings ) ).toBe( '2.18' );
		expect( applyNumericOp( '1.005', op( 'increase', '0' , true ), 'money', settings ) ).toBe( '1.01' );
		expect( applyNumericOp( '10', op( 'set', '4.785' ), 'money', settings ) ).toBe( '4.79' );
		expect( applyNumericOp( '100', op( 'increase', '12.5', true ), 'money', settings ) ).toBe( '112.50' );
		expect( applyNumericOp( '7', op( 'decrease', '2.5', true ), 'money', settings0 ) ).toBe( '7' );
	} );

	it( 'matches integer-cent half-up arithmetic across a sweep of prices and percents', () => {
		const percents = [ 5, 10, 12.5, 15, 20, 25, 30, 33, 50 ];
		let checked = 0;

		for ( let cents = 1; cents <= 100000; cents += 7 ) {
			const base = `${ Math.floor( cents / 100 ) }.${ String( cents % 100 ).padStart( 2, '0' ) }`;

			for ( const percent of percents ) {
				for ( const direction of [ 'increase', 'decrease' ] as const ) {
					// Exact: cents × (100 ± percent) / 100 with the percent in tenths to keep 12.5 integral.
					const numerator = cents * ( 1000 + ( direction === 'increase' ? percent * 10 : -percent * 10 ) );
					const expected = Math.floor( numerator / 1000 ) + ( ( numerator % 1000 ) * 2 >= 1000 ? 1 : 0 );
					const actual = applyNumericOp( base, op( direction, String( percent ), true ), 'money', settings );

					expect( actual, `${ base } ${ direction } ${ percent }%` ).toBe( `${ Math.floor( expected / 100 ) }.${ String( expected % 100 ).padStart( 2, '0' ) }` );
					checked += 1;
				}
			}
		}

		expect( checked ).toBeGreaterThan( 100000 );
		// ~257k checks: a few seconds alone, more while the whole suite (and a build) share the CPU.
	}, 90000 );

	it( 'projects a sale price from the regular price with regular_minus', () => {
		expect( applyNumericOp( '', op( 'regular_minus', '20', true ), 'money', settings, { regular: '189' } ) ).toBe( '151.20' );
		expect( applyNumericOp( '99', op( 'regular_minus', '10' ), 'money', settings, { regular: '180' } ) ).toBe( '170.00' );
		expect( applyNumericOp( '', op( 'regular_minus', '20', true ), 'money', settings, {} ) ).toBeNull();
		expect( applyNumericOp( '', op( 'regular_minus', '20', true ), 'money', settings, { regular: '' } ) ).toBeNull();
		expect( computeNumericOp( '5', op( 'decrease', '8' ), 'integer', settings ) ).toBe( -3 );
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

	it( 'takes "Change to" a negative menu order (WordPress sorts -1 first) and writes it as typed', () => {
		const menuOrder = field( 'menu_order', { type: 'integer', edit: { group: 'advanced', bulk: 'integer' }, rest: { fields: [ 'menu_order' ], applies: { product: true, variation: true } } } );

		expect( validateNumericOp( op( 'set', '-2' ), 'integer', settings, true ) ).toBeNull();
		// The amount of an increase or decrease is still a size, never negative.
		expect( validateNumericOp( op( 'decrease', '-2' ), 'integer', settings, true ) ).toMatch( /negative/ );
		expect( validateNumericOps( { menu_order: op( 'set', '-2' ) }, [ menuOrder ], settings ) ).toEqual( [] );
		expect( projectEdits( simple( 1, { menu_order: 0 } ), { menu_order: op( 'set', '-2' ) }, [ menuOrder ], settings ).menu_order ).toBe( '-2' );
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

describe( 'projectWarnings', () => {
	it( 'lists rows a decrease pushes below zero, naming the clamp', () => {
		const items = [ simple( 1, { stock_quantity: 9 } ), simple( 2, { stock_quantity: 124 } ), simple( 3, { stock_quantity: 2 } ), variable( 4, { stock_quantity: 1, manage_stock: true } ) ];
		const warnings = projectWarnings( items, { stock_quantity: op( 'decrease', '10' ) }, fields, settings );

		expect( warnings.map( ( warning ) => [ warning.id, warning.value ] ) ).toEqual( [ [ 1, -1 ], [ 3, -8 ], [ 4, -9 ] ] );
		expect( warnings[ 0 ]?.message ).toMatch( /9 to -1.*Out of stock/ );
		expect( projectWarnings( items, { stock_quantity: op( 'decrease', '1' ) }, fields, settings ) ).toEqual( [] );
		expect( projectWarnings( items, { stock_quantity: op( 'set', '0' ), status: 'draft' }, fields, settings ) ).toEqual( [] );
	} );

	it( 'does not warn (or clamp) on backordered stock: the arithmetic is kept below zero', () => {
		const items = [ simple( 1, { stock_quantity: -3, manage_stock: true } ), simple( 2, { stock_quantity: 1, manage_stock: true, backorders: 'notify' } ) ];

		expect( projectWarnings( items, { stock_quantity: op( 'increase', '2' ) }, fields, settings ) ).toEqual( [] );
		expect( projectWarnings( items, { stock_quantity: op( 'decrease', '2' ) }, fields, settings ) ).toEqual( [] );
		expect( projectEdits( items[ 0 ]!, { stock_quantity: op( 'decrease', '2' ) }, fields, settings ) ).toEqual( { stock_quantity: '-5' } );
		expect( projectEdits( items[ 0 ]!, { stock_quantity: op( 'increase', '2' ) }, fields, settings ) ).toEqual( { stock_quantity: '-1' } );
		expect( projectEdits( items[ 1 ]!, { stock_quantity: op( 'decrease', '3' ) }, fields, settings ) ).toEqual( { stock_quantity: '-2' } );
		expect( validateBulkNumericEdits( items, { stock_quantity: op( 'decrease', '2' ) }, fields, settings ) ).toEqual( [] );
		// A row without backorders and stock above zero still clamps, and says so.
		expect( projectWarnings( [ simple( 3, { stock_quantity: 1, manage_stock: true, backorders: 'no' } ) ], { stock_quantity: op( 'decrease', '3' ) }, fields, settings ) ).toHaveLength( 1 );
	} );

	it( 'covers money too, formatted', () => {
		const warnings = projectWarnings( [ simple( 1, { regular_price: '10' } ) ], { regular_price: op( 'decrease', '15' ) }, fields, settings );

		expect( warnings ).toHaveLength( 1 );
		expect( warnings[ 0 ]?.message ).toMatch( /10 to -5\.00/ );
	} );
} );

describe( 'projectEdits', () => {
	it( 'resolves regular_minus against each row’s regular price, the edited one when it changes too', () => {
		const item = simple( 1, { regular_price: '100', sale_price: '' } );

		expect( projectEdits( item, { sale_price: op( 'regular_minus', '20', true ) }, fields, settings ) ).toEqual( { sale_price: '80.00' } );
		expect( projectEdits( item, { regular_price: '200', sale_price: op( 'regular_minus', '25', true ) }, fields, settings ) ).toEqual( { regular_price: '200', sale_price: '150.00' } );
		expect( projectEdits( item, { regular_price: op( 'increase', '10', true ), sale_price: op( 'regular_minus', '10' ) }, fields, settings ) ).toEqual( { regular_price: '110.00', sale_price: '100.00' } );
		expect( projectEdits( simple( 2, { regular_price: '' } ), { sale_price: op( 'regular_minus', '20', true ) }, fields, settings ) ).toEqual( {} );
	} );

	it( 'projects a language sale price from the reference regular price when none is stored', () => {
		const item = variation( 11, 1, { i18n: { se: { regular_price: { value: '', source: '2000' }, sale_price: { value: '', source: '' } } } } );

		expect( projectEdits( item, { 'i18n:se.sale_price': op( 'regular_minus', '25', true ) }, fields, settings ) ).toEqual( { 'i18n:se.sale_price': '1500.00' } );
	} );

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
	it( 'never validates sellable edits against a variable parent (they go to its variations)', () => {
		const items = [ variable( 1, { regular_price: '' } ), simple( 2, { regular_price: '100' } ), variation( 11, 1, { regular_price: '50' } ), variation( 12, 1, { regular_price: '40' } ) ];

		expect( validateBulkNumericEdits( items, { sale_price: op( 'set', '30' ) }, fields, settings ) ).toEqual( [] );

		const tooHigh = validateBulkNumericEdits( items, { sale_price: op( 'set', '45' ) }, fields, settings );

		expect( tooHigh.map( ( error ) => error.id ) ).toEqual( [ 12 ] );
		// A parent-owned edit is still checked on the parent.
		expect( validateBulkNumericEdits( [ variable( 1, { stock_quantity: 3, manage_stock: true } ) ], { stock_quantity: '1.5' }, fields, settings ) ).toHaveLength( 1 );
	} );

	it( 'refuses a schedule that would run without a sale price', () => {
		const noSale = [ variation( 11, 1, { regular_price: '100', sale_price: '' } ), variation( 12, 1, { regular_price: '100', sale_price: '20' } ) ];
		const dates = { date_on_sale_from: '2026-10-12T00:00:00', date_on_sale_to: '2026-10-18T23:59:00' };

		// "Decrease by 20 %" of an empty sale price starts from the regular price: every row gets a sale.
		expect( validateBulkNumericEdits( noSale, { ...dates, sale_price: op( 'decrease', '20', true ) }, fields, settings ) ).toHaveLength( 0 );

		// "Increase by 5" of an empty sale price stays empty: dates and no sale.
		const errors = validateBulkNumericEdits( noSale, { ...dates, sale_price: op( 'increase', '5' ) }, fields, settings );

		expect( errors ).toHaveLength( 1 );
		expect( errors[ 0 ] ).toMatchObject( { id: 11, field: 'sale_price' } );
		expect( errors[ 0 ]?.message ).toMatch( /no sale price/ );

		// Dates alone, the toggle alone, or one date: same rule.
		expect( validateBulkNumericEdits( noSale, dates, fields, settings ) ).toHaveLength( 1 );
		expect( validateBulkNumericEdits( noSale, { date_on_sale_to: '2026-10-18T23:59:00' }, fields, settings ) ).toHaveLength( 1 );
		expect( validateBulkNumericEdits( [ simple( 1, { regular_price: '100', sale_price: '', date_on_sale_from: '2026-10-12T00:00:00' } ) ], { schedule_sale: true }, fields, settings ) ).toHaveLength( 1 );

		// Regular price minus 20 % gives every row a sale price.
		expect( validateBulkNumericEdits( noSale, { ...dates, sale_price: op( 'regular_minus', '20', true ) }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( noSale, { ...dates, sale_price: '50' }, fields, settings ) ).toEqual( [] );
		// Turning the schedule off clears the dates: nothing to run.
		expect( validateBulkNumericEdits( noSale, { schedule_sale: false, date_on_sale_from: '' }, fields, settings ) ).toEqual( [] );
		// A sale price edit without touching the dates is not a schedule change.
		expect( validateBulkNumericEdits( noSale, { sale_price: op( 'decrease', '20', true ) }, fields, settings ) ).toEqual( [] );
	} );

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

	it( 'checks a language sale price against the reference regular price when none is stored', () => {
		// gds-woo-i18n sells an untranslated regular price at its converted default (`source`); the row shows it as "Default: 2045".
		const item = variation( 11, 1, { i18n: { se: { regular_price: { value: '', source: '2045' }, sale_price: { value: '', source: '' } } } } );

		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '1590' ) }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': '1590' }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '2045' ) }, fields, settings ) ).toMatchObject( [ { id: 11, field: 'i18n:se.sale_price' } ] );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '2100' ) }, fields, settings ) ).toMatchObject( [ { id: 11, field: 'i18n:se.sale_price' } ] );
	} );

	it( 'a stored or edited language regular price wins over the reference', () => {
		const item = variation( 11, 1, { i18n: { se: { regular_price: { value: '1500', source: '1500' }, sale_price: { value: '', source: '' } } } } );

		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '1590' ) }, fields, settings ) ).toHaveLength( 1 );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.regular_price': '1800', 'i18n:se.sale_price': '1590' }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.regular_price': op( 'decrease', '10', true ), 'i18n:se.sale_price': '1300' }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.regular_price': op( 'decrease', '10', true ), 'i18n:se.sale_price': '1400' }, fields, settings ) ).toHaveLength( 1 );
	} );

	it( 'a language sale price with neither a stored nor a reference regular price is still an error', () => {
		const item = variation( 11, 1, { i18n: { se: { regular_price: { value: '', source: '' }, sale_price: { value: '', source: '' } } } } );

		expect( validateBulkNumericEdits( [ item ], { 'i18n:se.sale_price': op( 'set', '10' ) }, fields, settings ) ).toHaveLength( 1 );
		expect( validateBulkNumericEdits( [ simple( 1, { regular_price: '' } ) ], { sale_price: '10' }, fields, settings ) ).toHaveLength( 1 );
	} );

	it( 'validateNumericOps reports the invalid inputs by field', () => {
		expect( validateNumericOps( { regular_price: op( 'set', '' ), stock_quantity: op( 'increase', '2' ), name: 'x' }, fields, settings ) ).toEqual( [
			{ field: 'regular_price', message: expect.stringMatching( /number/ ) },
		] );
	} );
} );

describe( 'parseNumeric with every separator pairing', () => {
	it( 'accepts the store notation for dot-thousands/comma-decimal and comma-thousands/dot-decimal', () => {
		const de = editSettings( { currency: { ...settings.currency, thousandSeparator: '.', decimalSeparator: ',' } } );
		const us = editSettings( { currency: { ...settings.currency, thousandSeparator: ',', decimalSeparator: '.' } } );

		expect( parseNumeric( '1.234,50', de ) ).toBe( 1234.5 );
		expect( parseNumeric( '12,5', de ) ).toBe( 12.5 );
		expect( parseNumeric( '1.234', de ) ).toBe( 1234 );
		expect( parseNumeric( '12.5', de ) ).toBe( 12.5 );
		expect( parseNumeric( '1,234.50', us ) ).toBe( 1234.5 );
		expect( parseNumeric( '12.5', us ) ).toBe( 12.5 );
		expect( parseNumeric( '12,5', us ) ).toBe( 12.5 );
		expect( parseNumeric( '1 234,50', settings ) ).toBe( 1234.5 );
		expect( parseNumeric( '1,0049', settings ) ).toBe( 1.0049 );
		expect( parseNumeric( 'abc', de ) ).toBeUndefined();
	} );
} );

describe( 'a whole-number field', () => {
	it( 'asks for a whole number without calling every integer field a stock quantity (menu order)', () => {
		expect( validateNumericOp( { operation: 'set', value: '1.5' }, 'integer', undefined, true ) ).toBe( 'Enter a whole number.' );
	} );
} );

