import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PriceCell, scheduledSale } from '../../resources/fields/components/price-cell';
import { setSettings } from '../../resources/settings';
import type { ProductListItem } from '../../resources/types';
import { sampleSettings } from './settings.test';

function row( extra: Partial< ProductListItem > ): ProductListItem {
	return { id: 1, type: 'simple', _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0, ...extra } as ProductListItem;
}

describe( 'scheduledSale', () => {
	const now = Date.parse( '2026-10-08T10:00:00Z' );

	it( 'is the future window of a sale that is not on yet', () => {
		const item = row( { price: '180', regular_price: '180', sale_price: '99', on_sale: false, date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_from_gmt: '2026-10-31T22:00:00', date_on_sale_to: '2026-11-30T23:59:59' } );

		expect( scheduledSale( item, now ) ).toEqual( { from: '2026-11-01T00:00:00', to: '2026-11-30T23:59:59', fromGmt: '2026-10-31T22:00:00', toGmt: undefined } );
	} );

	it( 'is null while on sale, without a sale price, without a start, or when the start has passed', () => {
		expect( scheduledSale( row( { sale_price: '99', on_sale: true, date_on_sale_from: '2026-11-01T00:00:00' } ), now ) ).toBeNull();
		expect( scheduledSale( row( { sale_price: '', on_sale: false, date_on_sale_from: '2026-11-01T00:00:00' } ), now ) ).toBeNull();
		expect( scheduledSale( row( { sale_price: '99', on_sale: false, date_on_sale_from: null } ), now ) ).toBeNull();
		expect( scheduledSale( row( { sale_price: '99', on_sale: false, date_on_sale_from: '2026-09-01T00:00:00', date_on_sale_from_gmt: '2026-08-31T21:00:00' } ), now ) ).toBeNull();
	} );
} );

describe( 'PriceCell', () => {
	beforeEach( () => setSettings( sampleSettings() ) );
	afterEach( () => setSettings( undefined ) );

	it( 'shows the sale dates in the site zone, whatever zone the browser runs in', () => {
		// A UTC site (wp_timezone_string() '+00:00'): 1 November 00:00 is 1 November, not the browser's 31 October.
		setSettings( sampleSettings( { timezone: '+00:00' } ) );
		render( <PriceCell item={ row( { price: '105', regular_price: '105', sale_price: '84', on_sale: false, date_on_sale_from: '2036-11-01T00:00:00', date_on_sale_from_gmt: '2036-11-01T00:00:00', date_on_sale_to: '2036-11-30T23:59:00', date_on_sale_to_gmt: '2036-11-30T23:59:00' } ) } /> );

		expect( screen.getByText( 'Scheduled' ).parentElement ).toHaveTextContent( 'Scheduled 84,00 € 1.11.2036 – 30.11.2036' );
		expect( screen.getByTitle( /^Scheduled sale/ ) ).toHaveAttribute( 'title', 'Scheduled sale: 84,00 €, 1.11.2036 – 30.11.2036' );
		// The current price stays the price; the scheduled one is never struck through or shown as in force.
		expect( screen.getByText( /^105,00 €/ ) ).toHaveClass( 'wc-products-list__price--scheduled' );
		expect( document.querySelector( 'del, ins' ) ).toBeNull();
	} );

	it( 'reads a site-local string without its gmt twin in the site zone', () => {
		setSettings( sampleSettings( { timezone: '+00:00' } ) );
		render( <PriceCell item={ row( { price: '105', regular_price: '105', sale_price: '84', on_sale: false, date_on_sale_from: '2036-11-01T00:00:00' } ) } /> );

		expect( screen.getByText( 'Scheduled' ).parentElement ).toHaveTextContent( 'Scheduled 84,00 € from 1.11.2036' );
	} );

	it( 'shows the current price with the scheduled sale beneath it', () => {
		const future = new Date( Date.now() + 30 * 24 * 3600 * 1000 ).toISOString().slice( 0, 19 );
		render( <PriceCell item={ row( { price: '180', regular_price: '180', sale_price: '99', on_sale: false, date_on_sale_from: future, date_on_sale_from_gmt: future } ) } /> );

		expect( screen.getByText( /180,00 €/ ) ).toHaveClass( 'wc-products-list__price--scheduled' );
		expect( screen.getByText( 'Scheduled' ).parentElement ).toHaveClass( 'wc-products-list__price-scheduled' );
		expect( screen.getByText( 'Scheduled' ).parentElement ).toHaveTextContent( /99,00 € from/ );
	} );

	it( 'strikes the regular price through while on sale', () => {
		const { container } = render( <PriceCell item={ row( { price: '99', regular_price: '180', sale_price: '99', on_sale: true } ) } /> );

		expect( container.querySelector( 'del' ) ).toHaveTextContent( '180,00 €' );
		expect( container.querySelector( 'ins' ) ).toHaveTextContent( '99,00 €' );
	} );
} );
