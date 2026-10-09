/**
 * Campaign pricing: charm rounding after a relative op, language prices in
 * their own currency, relative ops on a language price nobody set by hand,
 * and a summary that counts each row once.
 */
import { describe, expect, it } from 'vitest';
import { applyNumericOp, projectEdits, roundToEnding, roundToPricePoint } from '../../resources/edit/bulk-numeric';
import { describeEdits, describeOp } from '../../resources/edit/change-summary';
import { roundingChoices } from '../../resources/edit/bulk-numeric-control';
import { planSave } from '../../resources/edit/save-runner';
import { visibleEditFields } from '../../resources/edit/visibility';
import type { ProductField } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

describe( 'price rounding', () => {
	it( 'moves a result to the nearest price with the chosen ending (a tie goes up, half-up like PHP round())', () => {
		expect( roundToEnding( 6997, 2, '95' ) ).toBe( 6995 );
		expect( roundToEnding( 9730, 2, '95' ) ).toBe( 9695 );
		expect( roundToEnding( 9730, 2, '90' ) ).toBe( 9690 );
		expect( roundToEnding( 9750, 2, '00' ) ).toBe( 9800 );
		// 2 139,50 kr to whole units is 2 140 kr, not 2 139.
		expect( roundToEnding( 213950, 2, '00' ) ).toBe( 214000 );
		expect( roundToEnding( 9751, 2, '00' ) ).toBe( 9800 );
		expect( roundToEnding( 30, 2, '95' ) ).toBe( 95 );
		expect( roundToEnding( 1234, 0, '95' ) ).toBe( 1234 );
	} );

	it( 'rounds to whole-unit price points (kronor), up, down or to the nearest', () => {
		// 2 139,50 kr: …9 is 2 139 or 2 149.
		expect( roundToPricePoint( 213950, 2, 'w9' ) ).toBe( 213900 );
		expect( roundToPricePoint( 213950, 2, 'w9', 'up' ) ).toBe( 214900 );
		expect( roundToPricePoint( 214400, 2, 'w9' ) ).toBe( 214900 );
		// …49 or …99: 2 149 and 2 199 are the points around 2 160.
		expect( roundToPricePoint( 216000, 2, 'w49' ) ).toBe( 214900 );
		expect( roundToPricePoint( 216000, 2, 'w49', 'up' ) ).toBe( 219900 );
		expect( roundToPricePoint( 218000, 2, 'w49' ) ).toBe( 219900 );
		expect( roundToPricePoint( 216000, 2, 'w99' ) ).toBe( 219900 );
		expect( roundToPricePoint( 216000, 2, 'w99', 'down' ) ).toBe( 209900 );
		// The nearest 10 (a tie goes up); a price already on a point stays.
		expect( roundToPricePoint( 214500, 2, 'w0' ) ).toBe( 215000 );
		expect( roundToPricePoint( 214900, 2, 'w9', 'up' ) ).toBe( 214900 );
		// Zero-decimal currencies work in whole units too.
		expect( roundToPricePoint( 2144, 0, 'w9' ) ).toBe( 2149 );
		// Down never goes below zero; nearest takes the first point instead.
		expect( roundToPricePoint( 500, 2, 'w9', 'down' ) ).toBe( 500 );
		expect( roundToPricePoint( 500, 2, 'w9' ) ).toBe( 900 );
		// Cent endings, up and down.
		expect( roundToPricePoint( 6997, 2, '95', 'up' ) ).toBe( 7095 );
		expect( roundToPricePoint( 6997, 2, '95', 'down' ) ).toBe( 6995 );
	} );

	it( 'offers whole-unit price points for kronor and cent endings for euros, and says which way it rounds', () => {
		expect( roundingChoices( settings, 2, 'SEK' ).map( ( choice ) => choice.value ) ).toEqual( [ '', '00', 'w9', 'w49', 'w99', 'w0' ] );
		expect( roundingChoices( settings, 2, 'EUR' ).map( ( choice ) => choice.value ) ).toEqual( [ '', '00', '90', '95', '99', 'w9', 'w49', 'w99', 'w0' ] );
		expect( roundingChoices( settings, 0, 'JPY' ).map( ( choice ) => choice.value ) ).toEqual( [ '', 'w9', 'w49', 'w99', 'w0' ] );
		expect( applyNumericOp( '1945', { operation: 'increase', value: '10', percent: true, round: 'w9' }, 'money', settings ) ).toBe( '2139.00' );
		expect( applyNumericOp( '1945', { operation: 'increase', value: '10', percent: true, round: 'w9', roundMode: 'up' }, 'money', settings ) ).toBe( '2149.00' );
		expect( describeOp( { operation: 'increase', value: '10', percent: true, round: 'w9', roundMode: 'up' }, 'money', settings ) ).toBe( '+ 10 % (rounded up to …9)' );
		expect( describeOp( { operation: 'increase', value: '10', percent: true, round: '00' }, 'money', settings ) ).toBe( '+ 10 % (rounded to whole units)' );
	} );

	it( 'applies after the percent, as the summary says', () => {
		expect( applyNumericOp( '99.95', { operation: 'regular_minus', value: '30', percent: true }, 'money', settings, { regular: '99.95' } ) ).toBe( '69.97' );
		expect( applyNumericOp( '99.95', { operation: 'regular_minus', value: '30', percent: true, round: '95' }, 'money', settings, { regular: '99.95' } ) ).toBe( '69.95' );
		expect( applyNumericOp( '139', { operation: 'decrease', value: '30', percent: true, round: '90' }, 'money', settings ) ).toBe( '96.90' );
		// "Change to" is never rounded.
		expect( applyNumericOp( '1', { operation: 'set', value: '12.34', round: '95' }, 'money', settings ) ).toBe( '12.34' );
		expect( describeOp( { operation: 'increase', value: '5', percent: true, round: '95' }, 'money', settings ) ).toBe( '+ 5 % (rounded to ,95)' );
		expect( roundingChoices( settings, 3 ) ).toEqual( [] );
	} );
} );

describe( 'language prices', () => {
	const sek = { code: 'SEK', symbol: 'kr', decimals: 2 };
	const seFields = fields.map( ( field ) => ( field.id.startsWith( 'i18n:se.' ) && field.id.endsWith( 'price' ) ? ( { ...field, currency: sek } as ProductField ) : field ) );

	it( 'are labelled and summarised in their own currency', () => {
		const lines = describeEdits( { 'i18n:se.regular_price': '79' }, seFields, [ variation( 221, 219 ) ], settings );

		expect( lines[ 0 ]?.change ).toBe( '→ 79,00 kr' );
		expect( describeOp( { operation: 'increase', value: '10' }, 'money', settings, sek ) ).toBe( '+ 10,00 kr' );
	} );

	it( 'raise from the price the shop sells at when none was set by hand', () => {
		const row = variation( 221, 219, { i18n: { se: { regular_price: { value: '', source: '100' } } } } );
		const projected = projectEdits( row, { 'i18n:se.regular_price': { operation: 'increase', value: '10', percent: true } }, seFields, settings );

		expect( projected[ 'i18n:se.regular_price' ] ).toBe( '110.00' );
	} );
} );

describe( 'parents and their variations selected together', () => {
	it( 'shows the prices for the variations and counts each row once', () => {
		const parent = variable( 4 );
		const children = [ variation( 41, 4, { regular_price: '100' } ), variation( 42, 4, { regular_price: '200' } ) ];
		const items = [ parent, ...children ];
		const shown = visibleEditFields( fields, items, { mode: 'bulk', applyToVariations: false } ).map( ( field ) => field.id );

		expect( shown ).toContain( 'sale_price' );

		const edits = { sale_price: { operation: 'regular_minus', value: '30', percent: true } };
		// The variations reached through the parent are the same rows as the ones ticked.
		const targets = [ ...items, ...children ];
		const lines = describeEdits( edits, fields, targets, settings, true );

		expect( lines[ 0 ]?.count ).toBe( 2 );
		expect( lines[ 0 ]?.rowIds ).toEqual( [ 41, 42 ] );

		const plan = planSave( items, edits, fields, settings, { applyToVariations: true, variationsByParent: new Map( [ [ 4, children ] ] ) } );

		expect( plan.variations ).toBe( 2 );
		expect( plan.products ).toBe( 0 );
	} );

	it( 'skips the variable parent for a price without "apply to variations"', () => {
		const plan = planSave( [ variable( 4 ), simple( 1 ) ], { regular_price: '9' }, fields, settings, { applyToVariations: false } );

		expect( plan.writes.map( ( write ) => write.target.item.id ) ).toEqual( [ 1 ] );
	} );
} );
