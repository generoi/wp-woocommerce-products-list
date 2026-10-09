import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultColumnStyle } from '../../resources/extensions/declarative';
import { createProductFields } from '../../resources/fields/registry';
import { columnStyles, createDefaultView, DEFAULT_LAYOUTS, DEFAULT_TABLE_FIELDS } from '../../resources/list/default-view';
import { setSettings } from '../../resources/settings';
import { mergeTableLayout, sanitizePersisted } from '../../resources/store/view';
import type { DeclarativeField, ProductField, Settings } from '../../resources/types';
import { sampleSettings } from './settings.test';

function declarative( overrides: Partial< DeclarativeField > ): DeclarativeField {
	return {
		id: 'i18n:se.name',
		label: 'Svenska: name',
		type: 'text',
		description: '',
		path: 'i18n.se.name.value',
		reference: null,
		writeKey: 'i18n',
		writePath: null,
		editable: true,
		bulk: 'default',
		readonly: false,
		applies: { product: true, variation: false },
		options: [],
		group: 'i18n:se',
		tab: null,
		visible: true,
		order: 10,
		enableSorting: false,
		sortParam: null,
		restFields: [ 'i18n' ],
		filter: null,
		width: null,
		source: 'gds-woo-i18n',
		...overrides,
	};
}

describe( 'default table', () => {
	it( 'does not show the type column by default and keeps the date narrow, so a translation column fits a laptop', () => {
		expect( DEFAULT_TABLE_FIELDS ).not.toContain( 'type' );
		expect( DEFAULT_TABLE_FIELDS ).toEqual( [ 'sku', 'price', 'stock_status', 'status', 'categories', 'date_created' ] );
		expect( columnStyles( [] ).date_created ).toEqual( { width: 110 } );
		expect( columnStyles( [] ).name ).toEqual( { minWidth: 280 } );
	} );
} );

describe( 'defaultColumnStyle', () => {
	it( 'gives a translated name the width of a name, other text room to read, prices a number column, and honours an explicit width', () => {
		expect( defaultColumnStyle( declarative( {} ) ) ).toEqual( { minWidth: 240 } );
		expect( defaultColumnStyle( declarative( { id: 'i18n:se.description', path: 'i18n.se.description.value', type: 'html' } ) ) ).toEqual( { minWidth: 180 } );
		expect( defaultColumnStyle( declarative( { id: 'i18n:se.regular_price', path: 'i18n.se.regular_price.value', type: 'price' } ) ) ).toEqual( { width: 120, align: 'end' } );
		expect( defaultColumnStyle( declarative( { width: 90 } ) ) ).toEqual( { width: 90 } );
		expect( defaultColumnStyle( declarative( { type: 'boolean' } ) ) ).toBeUndefined();
	} );
} );

describe( 'column styles in the view', () => {
	let settings: Settings;
	let fields: ProductField[];

	beforeEach( () => {
		settings = sampleSettings( { fields: [ declarative( {} ), declarative( { id: 'i18n:se.sale_price', path: 'i18n.se.sale_price.value', type: 'price' } ) ] } );
		setSettings( settings );
		fields = createProductFields( settings );
	} );

	afterEach( () => setSettings( undefined ) );

	it( 'carries every extension column width into the default view', () => {
		const view = createDefaultView( settings, fields );
		const styles = ( view as { layout?: { styles?: Record< string, unknown > } } ).layout?.styles ?? {};

		expect( styles[ 'i18n:se.name' ] ).toEqual( { minWidth: 240 } );
		expect( styles[ 'i18n:se.sale_price' ] ).toEqual( { width: 120, align: 'end' } );
		expect( styles.sku ).toEqual( { width: 120 } );
	} );

	it( 'keeps a saved layout and adds the defaults of columns it has no width for', () => {
		const defaults = createDefaultView( settings, fields );
		const saved = { type: 'table' as const, layout: { density: 'compact', styles: { sku: { width: 200 } } } };
		const persisted = sanitizePersisted( saved as never, defaults, fields );
		const layout = ( persisted as { layout?: { density?: string; styles?: Record< string, unknown > } } ).layout;

		expect( layout?.density ).toBe( 'compact' );
		expect( layout?.styles?.sku ).toEqual( { width: 200 } );
		expect( layout?.styles?.[ 'i18n:se.name' ] ).toEqual( { minWidth: 240 } );
		expect( layout?.styles?.name ).toEqual( { minWidth: 280 } );

		expect( mergeTableLayout( undefined, undefined ) ).toEqual( { styles: {} } );
		expect( mergeTableLayout( { styles: { a: 1 } }, { styles: { b: 2 } } ) ).toEqual( { styles: { a: 1, b: 2 } } );
	} );

	it( 'never puts the SKU on a second line under the name: it is its own column', () => {
		const defaults = createDefaultView( settings, fields );
		const saved = { type: 'table' as const, titleField: 'name', descriptionField: 'sku', showDescription: true, fields: [ 'sku' ] };
		const persisted = sanitizePersisted( saved as never, defaults, fields );

		expect( persisted.descriptionField ).toBeUndefined();
		expect( ( persisted as { showDescription?: boolean } ).showDescription ).toBeUndefined();
		expect( persisted.fields ).toEqual( [ 'sku' ] );

		for ( const layout of Object.values( DEFAULT_LAYOUTS ) ) {
			expect( layout === true ? undefined : layout?.descriptionField ).toBeUndefined();
		}
	} );
} );
