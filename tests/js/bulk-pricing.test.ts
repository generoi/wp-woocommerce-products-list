/**
 * Campaign pricing: charm rounding after a relative op, language prices in
 * their own currency, relative ops on a language price nobody set by hand,
 * and a summary that counts each row once.
 */
import { describe, expect, it } from 'vitest';
import { applyNumericOp, projectEdits, roundToEnding } from '../../resources/edit/bulk-numeric';
import { describeEdits, describeOp } from '../../resources/edit/change-summary';
import { roundingChoices } from '../../resources/edit/bulk-numeric-control';
import { planSave } from '../../resources/edit/save-runner';
import { visibleEditFields } from '../../resources/edit/visibility';
import type { ProductField } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

describe( 'price rounding', () => {
	it( 'moves a result to the nearest price with the chosen ending (a tie goes down)', () => {
		expect( roundToEnding( 6997, 2, '95' ) ).toBe( 6995 );
		expect( roundToEnding( 9730, 2, '95' ) ).toBe( 9695 );
		expect( roundToEnding( 9730, 2, '90' ) ).toBe( 9690 );
		expect( roundToEnding( 9750, 2, '00' ) ).toBe( 9700 );
		expect( roundToEnding( 9751, 2, '00' ) ).toBe( 9800 );
		expect( roundToEnding( 30, 2, '95' ) ).toBe( 95 );
		expect( roundToEnding( 1234, 0, '95' ) ).toBe( 1234 );
	} );

	it( 'applies after the percent, as the summary says', () => {
		expect( applyNumericOp( '99.95', { operation: 'regular_minus', value: '30', percent: true }, 'money', settings, { regular: '99.95' } ) ).toBe( '69.97' );
		expect( applyNumericOp( '99.95', { operation: 'regular_minus', value: '30', percent: true, round: '95' }, 'money', settings, { regular: '99.95' } ) ).toBe( '69.95' );
		expect( applyNumericOp( '139', { operation: 'decrease', value: '30', percent: true, round: '90' }, 'money', settings ) ).toBe( '96.90' );
		// "Change to" is never rounded.
		expect( applyNumericOp( '1', { operation: 'set', value: '12.34', round: '95' }, 'money', settings ) ).toBe( '12.34' );
		expect( describeOp( { operation: 'increase', value: '5', percent: true, round: '95' }, 'money', settings ) ).toBe( '+ 5 % (rounded to ,95)' );
		expect( roundingChoices( settings, 2 ).map( ( choice ) => choice.value ) ).toEqual( [ '', '00', '90', '95', '99' ] );
		expect( roundingChoices( settings, 0 ) ).toEqual( [] );
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
