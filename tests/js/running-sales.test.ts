/**
 * A sale scheduled for later replaces the running one on Update (a product
 * has one sale window): the editor says how many rows are on sale now, the
 * lowest price they sell at, and that they go back to the regular price
 * until the new sale starts.
 */
import { describe, expect, it, vi } from 'vitest';
import { editSettings, variation } from './edit-fixtures';

vi.mock( '../../resources/settings', () => ( { getSettings: () => editSettings() } ) );

const { describeRunningSales } = await import( '../../resources/edit/inline-editor' );

const settings = editSettings();
const now = Date.parse( '2026-10-09T12:00:00Z' );
const running = variation( 11, 1, { regular_price: '159', sale_price: '70', on_sale: true } );
const other = variation( 12, 1, { regular_price: '89', sale_price: '71.20', on_sale: true } );
const later = variation( 13, 1, { regular_price: '100', sale_price: '80', on_sale: false } );

describe( 'describeRunningSales', () => {
	it( 'counts the sales running now and warns that a later start ends them now', () => {
		const result = describeRunningSales( [ running, other, later ], { date_on_sale_from: '2026-11-01T00:00:00' }, settings, now );

		expect( result.count ).toBe( 2 );
		expect( result.message ).toMatch( /^2 of them are on sale right now \(lowest 70,00 €\)\. / );
		expect( result.message ).toContain( 'sell at their regular price until the new sale starts on 1.11.2026' );
	} );

	it( 'a sale starting now changes the price at once', () => {
		expect( describeRunningSales( [ running ], { sale_price: '60' }, settings, now ).message ).toBe( '1 of them is on sale right now (at 70,00 €). Replacing changes the price customers pay as soon as you update.' );
	} );

	it( 'nothing running: nothing to choose', () => {
		expect( describeRunningSales( [ later ], { date_on_sale_from: '2026-11-01T00:00:00' }, settings, now ) ).toEqual( { count: 0, message: '' } );
	} );
} );
