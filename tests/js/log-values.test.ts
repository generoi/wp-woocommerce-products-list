import { afterEach, describe, expect, it } from 'vitest';
import { formatLogValue } from '../../resources/history/log-fields';
import { setSettings } from '../../resources/settings';
import { sampleSettings } from './settings.test';

describe( 'formatLogValue', () => {
	afterEach( () => setSettings( undefined ) );

	it( 'shows a logged sale date as the site’s wall-clock time, whatever zone the browser runs in', () => {
		const settings = sampleSettings( { timezone: '+00:00', dateFormat: 'j.n.Y', timeFormat: 'H:i' } );
		setSettings( settings );

		expect( formatLogValue( 'date_on_sale_to', '2026-11-30T23:59:00', settings ) ).toBe( '30.11.2026 23:59' );
	} );

	it( 'formats prices in the shop currency, and language prices in the language’s own currency', () => {
		const settings = sampleSettings( { languages: { default: 'fi', others: [ 'se' ], labels: {}, currencies: { se: 'SEK' } } } );
		setSettings( settings );

		expect( formatLogValue( 'regular_price', '5.76', settings ) ).toBe( '5,76 €' );
		expect( formatLogValue( 'i18n.se.regular_price', '350', settings ).replace( /\s+/gu, ' ' ) ).toMatch( /350,00 (kr|SEK)/ );
		expect( formatLogValue( 'name', '', settings ) ).toBe( '(empty)' );
	} );
} );
