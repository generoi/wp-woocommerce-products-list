import { afterEach, describe, expect, it } from 'vitest';
import { logFieldLabel, logFieldOptions, logKeysForField, logPaths } from '../../resources/fields/log-labels';
import { createProductFields, getField } from '../../resources/fields/registry';
import { setSettings } from '../../resources/settings';
import type { DeclarativeField, ProductField } from '../../resources/types';
import { sampleSettings } from './settings.test';

const metaTitle: DeclarativeField = {
	id: 'i18n:de.meta_title',
	label: 'Deutsch: SEO title',
	type: 'text',
	description: '',
	path: 'i18n.de.meta_title.value',
	reference: 'i18n.de.meta_title.source',
	writeKey: 'i18n',
	writePath: 'i18n.de.meta_title',
	editable: true,
	bulk: 'default',
	readonly: false,
	applies: { product: true, variation: false },
	options: [],
	group: 'i18n:de',
	tab: 'i18n:de',
	visible: false,
	order: 10,
	enableSorting: false,
	sortParam: null,
	restFields: [ 'i18n.de.meta_title' ],
	filter: null,
	width: null,
	source: 'gds-woo-i18n',
};

describe( 'logPaths', () => {
	it( 'names request leaves the way Log\\Recorder::paths() does', () => {
		expect(
			logPaths( {
				id: 5,
				_fields: 'id',
				regular_price: '10',
				dimensions: { length: '1' },
				categories: [ { id: 3 } ],
				i18n: { de: { meta_title: 'x', name: 'y' } },
				meta_data: [ { key: '_foo', value: 1 }, { key: '' } ],
			} )
		).toEqual( [ 'regular_price', 'dimensions', 'categories', 'i18n.de.meta_title', 'i18n.de.name', 'meta_data._foo' ] );
	} );
} );

describe( 'logFieldOptions', () => {
	afterEach( () => setSettings( undefined ) );

	it( 'labels core and translation log keys from the registry', () => {
		const settings = { ...sampleSettings(), fields: [ metaTitle ] };
		setSettings( settings );
		const fields = createProductFields( settings );
		const options = logFieldOptions( fields );
		const label = ( key: string ) => logFieldLabel( key, options );

		expect( label( 'regular_price' ) ).toBe( getField( fields, 'regular_price' )?.label );
		expect( label( 'stock_quantity' ) ).toBe( getField( fields, 'stock_quantity' )?.label );
		expect( label( 'menu_order' ) ).toBe( getField( fields, 'menu_order' )?.label );
		expect( label( 'i18n.de.meta_title' ) ).toBe( 'Deutsch: SEO title' );
		expect( label( 'categories' ) ).toBe( getField( fields, 'categories' )?.label );

		// Read-only and filter-only fields write nothing.
		const values = options.map( ( option ) => option.value );
		expect( values ).not.toContain( 'price' );
		expect( values ).not.toContain( 'variation_stock' );
		expect( new Set( values ).size ).toBe( values.length );

		// Keys no field writes show as is; empty stays empty.
		expect( label( 'meta_data._custom' ) ).toBe( 'meta_data._custom' );
		expect( logFieldLabel( '', options ) ).toBe( '' );
		expect( logFieldLabel( null, options ) ).toBe( '' );
	} );

	it( 'falls back to the id when a write cannot be probed, and suffixes keys of a multi-key field', () => {
		const throwing = { id: 'odd', label: 'Odd', rest: { fields: [], write: () => { throw new Error( 'no' ); }, applies: { product: true, variation: false } }, productTypes: 'all', edit: { group: 'general', bulk: 'default' } } as unknown as ProductField;
		expect( logKeysForField( throwing ) ).toEqual( [ 'odd' ] );

		const pair = { id: 'pair', label: 'Pair', rest: { fields: [], write: () => ( { extra: { a: 1, b: 2 } } ), applies: { product: true, variation: false } }, productTypes: 'all', edit: { group: 'general', bulk: 'default' } } as unknown as ProductField;
		expect( logFieldOptions( [ pair ] ) ).toEqual( [
			{ value: 'extra.a', label: 'Pair (a)' },
			{ value: 'extra.b', label: 'Pair (b)' },
		] );
	} );
} );
