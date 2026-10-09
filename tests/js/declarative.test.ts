import { createElement } from '@wordpress/element';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addAction, removeAction } from '@wordpress/hooks';
import { describe, expect, it, vi } from 'vitest';
import { ACTIONS } from '../../resources/extensions/hooks';
import {
	actionFromDeclarative,
	actionsFromSettings,
	currencyForField,
	defaultArgs,
	fieldFromDeclarative,
	fieldsFromSettings,
	filterFromDeclarative,
	formatMoney,
	getPath,
	parseDecimal,
	setPath,
} from '../../resources/extensions/declarative';
import type { ActionResponse, DeclarativeFieldInput, NormalizedField } from '../../resources/extensions/declarative';
import type { DeclarativeAction, DeclarativeField, DeclarativeFilter, ProductListItem, Settings } from '../../resources/types';

function makeSettings( overrides: Partial< Settings > = {} ): Settings {
	return {
		version: '0.1.0',
		locale: 'fi',
		currency: { code: 'EUR', symbol: '€', position: 'right_space', decimals: 2, decimalSeparator: ',', thousandSeparator: ' ' },
		units: { weight: 'kg', dimension: 'cm' },
		dateFormat: 'j.n.Y',
		timeFormat: 'H:i',
		timezone: 'Europe/Helsinki',
		user: { id: 1, name: 'admin' },
		caps: { edit: true, editOthers: true, publish: true, delete: true, deleteOthers: true, manageWoocommerce: true, manageTerms: true },
		statuses: [],
		productTypes: [],
		stockStatuses: [],
		catalogVisibility: [],
		backorders: [],
		taxStatuses: [],
		taxClasses: [],
		shippingClasses: [],
		taxonomies: [],
		features: { cogs: false, brands: false, reviews: true, hardDelete: false },
		limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 50, actionBatchSize: 100 },
		links: { admin: '', rest: '', page: '', history: '', legacyList: '', newProduct: '', editProduct: '', assets: '' },
		fields: [],
		filters: [],
		actions: [],
		languages: { default: 'fi', others: [ 'se', 'en' ], labels: { fi: 'Suomi', se: 'Svenska', en: 'English' }, currencies: { se: 'SEK' } },
		...overrides,
	};
}

function makeField( overrides: Partial< DeclarativeFieldInput > = {} ): DeclarativeField {
	return {
		id: 'i18n:se.name',
		label: 'Name (Svenska)',
		type: 'text',
		description: '',
		path: 'i18n.se.name.value',
		reference: 'i18n.se.name.source',
		writeKey: 'i18n',
		writePath: 'i18n.se.name',
		editable: true,
		bulk: 'default',
		readonly: false,
		applies: { product: true, variation: false },
		options: [],
		group: 'i18n:se',
		tab: null,
		visible: true,
		order: 100,
		enableSorting: false,
		sortParam: null,
		restFields: [ 'i18n' ],
		filter: null,
		width: null,
		source: 'gds-woo-i18n',
		...overrides,
	} as DeclarativeField;
}

function makeFilter( overrides: Partial< DeclarativeFilter > = {} ): DeclarativeFilter {
	return {
		id: 'translation',
		label: 'Translation',
		type: 'select',
		param: null,
		options: [
			{ value: 'missing:se', label: 'Missing in Svenska', params: { 'gds_i18n[lang]': 'se', 'gds_i18n[status]': 'missing' } },
			{ value: 'translated:se', label: 'Translated to Svenska', params: { 'gds_i18n[lang]': 'se', 'gds_i18n[status]': 'translated' } },
		],
		operators: [ 'is' ],
		isPrimary: true,
		multiple: false,
		variations: true,
		order: 100,
		source: 'gds-woo-i18n',
		...overrides,
	};
}

function makeAction( overrides: Partial< DeclarativeAction > = {} ): DeclarativeAction {
	return {
		id: 'i18n_copy',
		label: 'Copy default language',
		description: '',
		icon: null,
		scope: 'both',
		supportsBulk: true,
		isPrimary: false,
		destructive: false,
		confirm: null,
		capability: null,
		group: null,
		order: 100,
		args: [],
		source: 'gds-woo-i18n',
		...overrides,
	};
}

function product( extra: Record< string, unknown > = {} ): ProductListItem {
	return { id: 10, type: 'simple', _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0, ...extra } as ProductListItem;
}

function variation( extra: Record< string, unknown > = {} ): ProductListItem {
	return { id: 11, _kind: 'variation', _level: 1, _parentId: 10, _hasChildren: false, _childCount: 0, ...extra } as ProductListItem;
}

/** Enough of a NormalizedField for `render` and `isValid.custom`. */
function normalized( field: { getValue?: ( args: { item: ProductListItem } ) => unknown; id: string } ): NormalizedField< ProductListItem > {
	return { ...field, getValue: field.getValue ?? ( ( { item } ) => ( item as Record< string, unknown > )[ field.id ] ) } as NormalizedField< ProductListItem >;
}

describe( 'paths', () => {
	it( 'reads and nests dotted paths', () => {
		expect( getPath( { i18n: { se: { name: { value: 'Saga' } } } }, 'i18n.se.name.value' ) ).toBe( 'Saga' );
		expect( getPath( { i18n: null }, 'i18n.se.name' ) ).toBeUndefined();
		expect( getPath( 'x', 'a' ) ).toBeUndefined();
		expect( setPath( 'i18n.se.name', 'Saga' ) ).toEqual( { i18n: { se: { name: 'Saga' } } } );
		expect( setPath( 'sku', 'A' ) ).toEqual( { sku: 'A' } );
	} );
} );

describe( 'money', () => {
	const settings = makeSettings();

	it( 'parses the site locale into wc/v3 decimal strings', () => {
		expect( parseDecimal( '12,50', settings ) ).toBe( '12.50' );
		expect( parseDecimal( '1 250,5', settings ) ).toBe( '1250.5' );
		expect( parseDecimal( '12.50', settings ) ).toBe( '12.50' );
		expect( parseDecimal( ' 189 ', settings ) ).toBe( '189' );
		expect( parseDecimal( '', settings ) ).toBe( '' );
		expect( parseDecimal( null, settings ) ).toBe( '' );
		expect( parseDecimal( 12.5, settings ) ).toBe( '12.5' );
		expect( parseDecimal( 'abc', settings ) ).toBeNull();
		expect( parseDecimal( '12,50,1', settings ) ).toBeNull();
	} );

	it( 'formats with the field currency and the site number format', () => {
		expect( formatMoney( '1250', { code: 'EUR', symbol: '€', decimals: 2 }, settings ) ).toBe( '1 250,00 €' );
		expect( formatMoney( '-5.5', { code: 'SEK', symbol: 'kr', decimals: 2 }, settings ) ).toBe( '-5,50 kr' );
		expect( formatMoney( '12', { code: 'USD', symbol: '$', decimals: 0 }, makeSettings( { currency: { ...settings.currency, position: 'left' } } ) ) ).toBe( '$12' );
		expect( formatMoney( 'n/a', { code: 'EUR', symbol: '€', decimals: 2 }, settings ) ).toBe( 'n/a' );
	} );

	it( 'resolves the currency from the field, the language, or the site', () => {
		expect( currencyForField( makeField( { currency: 'NOK' } as Partial< DeclarativeFieldInput > ), settings ) ).toEqual( { code: 'NOK', symbol: 'kr', decimals: 2 } );
		expect( currencyForField( makeField( { group: 'i18n:se' } ), settings ) ).toEqual( { code: 'SEK', symbol: 'kr', decimals: 2 } );
		expect( currencyForField( makeField( { group: 'i18n:en', precision: 0 } as Partial< DeclarativeFieldInput > ), settings ) ).toEqual( { code: 'EUR', symbol: '€', decimals: 0 } );
		expect( currencyForField( makeField( { group: null, currency: 'XYZ' } as Partial< DeclarativeFieldInput > ), settings ).symbol ).toBe( 'XYZ' );
	} );
} );

describe( 'fieldFromDeclarative', () => {
	const settings = makeSettings();

	it( 'reads by path, writes by writePath and nests edits like the row', () => {
		const field = fieldFromDeclarative( makeField(), settings );
		const item = product( { i18n: { se: { name: { value: 'Saga (sv)', source: 'Saga' } } } } );

		expect( field.id ).toBe( 'i18n:se.name' );
		expect( field.label ).toBe( 'Name (Svenska)' );
		expect( field.type ).toBe( 'text' );
		expect( field.getValue?.( { item } ) ).toBe( 'Saga (sv)' );
		expect( field.rest.read?.( item ) ).toBe( 'Saga (sv)' );
		expect( field.setValue?.( { item, value: 'Ny' } ) ).toEqual( { i18n: { se: { name: { value: 'Ny' } } } } );
		expect( field.rest.write?.( 'Ny', item ) ).toEqual( { i18n: { se: { name: 'Ny' } } } );
		expect( field.rest.fields ).toEqual( [ 'i18n' ] );
		expect( field.rest.applies ).toEqual( { product: true, variation: false } );
		expect( field.productTypes ).toBe( 'all' );
		expect( field.edit ).toEqual( { group: 'i18n:se', tab: 'i18n:se', bulk: 'default', order: 100 } );
		expect( field.reference?.( item ) ).toBe( 'Saga' );
		expect( field.readOnly ).toBe( false );
		expect( field.filterBy ).toBe( false );
		expect( field.rest.param ).toBeUndefined();
		expect( field.source ).toBe( 'gds-woo-i18n' );
		expect( field.enableGlobalSearch ).toBe( false );
	} );

	it( 'defaults writePath to path, restFields to the first path segment, and the label to the id', () => {
		const field = fieldFromDeclarative( makeField( { id: 'acme:note', label: '', path: 'acme.note', writePath: null, restFields: [], group: null, tab: null } ), settings );

		expect( field.label ).toBe( 'acme:note' );
		expect( field.rest.fields ).toEqual( [ 'acme' ] );
		expect( field.rest.write?.( 'x', product() ) ).toEqual( { acme: { note: 'x' } } );
		expect( field.edit ).toEqual( { group: 'general', bulk: 'default', order: 100 } );
	} );

	it( 'maps applies to productTypes and rest.applies', () => {
		const field = fieldFromDeclarative( makeField( { applies: { product: [ 'simple', 'external' ], variation: true } } ), settings );

		expect( field.productTypes ).toEqual( [ 'simple', 'external' ] );
		expect( field.rest.applies ).toEqual( { product: true, variation: true } );

		const variationOnly = fieldFromDeclarative( makeField( { applies: { product: [], variation: true } } ), settings );

		expect( variationOnly.productTypes ).toEqual( [] );
		expect( variationOnly.rest.applies ).toEqual( { product: false, variation: true } );
	} );

	it( 'makes readonly and non-editable fields read-only with edit false', () => {
		expect( fieldFromDeclarative( makeField( { readonly: true, editable: false, bulk: false } ), settings ).edit ).toBe( false );
		expect( fieldFromDeclarative( makeField( { readonly: true, editable: false, bulk: false } ), settings ).readOnly ).toBe( true );
		expect( fieldFromDeclarative( makeField( { editable: false } ), settings ).edit ).toBe( false );
	} );

	it( 'carries sorting and the filter mapping', () => {
		const field = fieldFromDeclarative(
			makeField( {
				enableSorting: true,
				sortParam: 'i18n_name_se',
				filter: { param: 'i18n_name_se', operators: [ 'contains', 'is', 'bogus' ] },
			} as Partial< DeclarativeFieldInput > ),
			settings
		);

		expect( field.enableSorting ).toBe( true );
		expect( field.rest.sortParam ).toBe( 'i18n_name_se' );
		expect( field.rest.param ).toBe( 'i18n_name_se' );
		expect( field.filterBy ).toEqual( { operators: [ 'contains', 'is', 'bogus' ], isPrimary: false } );
		expect( field.rest.toParams?.( 'Saga', 'is' ) ).toEqual( { i18n_name_se: 'Saga' } );
		expect( field.rest.toParams?.( [ 'a', 'b' ], 'isAny' ) ).toEqual( { i18n_name_se: [ 'a', 'b' ] } );
		expect( field.rest.toParams?.( 'Saga', 'isNot' ) ).toEqual( { exclude_i18n_name_se: 'Saga' } );
		expect( field.rest.toParams?.( '', 'is' ) ).toEqual( {} );
	} );

	it( 'uses filter.toParams per option value when given', () => {
		const field = fieldFromDeclarative(
			makeField( {
				filter: { param: 'stock', operators: [ 'is' ], toParams: { low: { max_stock_quantity: 5 }, none: { stock_status: 'outofstock' } } },
			} as Partial< DeclarativeFieldInput > ),
			settings
		);

		expect( field.rest.toParams?.( 'low', 'is' ) ).toEqual( { max_stock_quantity: 5 } );
		expect( field.rest.toParams?.( [ 'low', 'none' ], 'isAny' ) ).toEqual( { max_stock_quantity: 5, stock_status: 'outofstock' } );
		expect( field.rest.toParams?.( 'other', 'is' ) ).toEqual( { stock: 'other' } );
	} );

	it( 'reads what the shop shows now (effective + shownLabel) from the value container', () => {
		const field = fieldFromDeclarative( makeField(), settings );

		expect( field.shownReference?.( product( { i18n: { se: { name: { value: '', source: 'Saga', effective: 'Saga EN', shownLabel: 'Shown now (English fallback)' } } } } ) ) ).toEqual( { label: 'Shown now (English fallback)', text: 'Saga EN' } );
		expect( field.shownReference?.( product( { i18n: { se: { name: { value: '', source: 'Saga' } } } } ) ) ).toBeNull();
	} );

	it( 'renders the value, or the muted reference when empty', () => {
		const field = fieldFromDeclarative( makeField( { referenceLabel: 'Suomi' } as Partial< DeclarativeFieldInput > ), settings );
		const Render = field.render as ( props: { item: ProductListItem; field: NormalizedField< ProductListItem > } ) => JSX.Element;
		const nf = normalized( field );

		const { container, rerender } = render(
			createElement( Render, { item: product( { i18n: { se: { name: { value: 'Saga (sv)', source: 'Saga' } } } } ), field: nf } )
		);

		expect( container.textContent ).toBe( 'Saga (sv)' );
		expect( container.querySelector( '.wc-products-list-field--reference' ) ).toBeNull();

		rerender( createElement( Render, { item: product( { i18n: { se: { name: { value: '', source: 'Saga' } } } } ), field: nf } ) );

		const reference = container.querySelector( '.wc-products-list-field--reference' );
		expect( reference?.textContent ).toBe( 'Saga' );
		expect( reference?.getAttribute( 'title' ) ).toBe( 'Suomi' );

		rerender( createElement( Render, { item: product( { i18n: { se: { name: { value: '', source: '' } } } } ), field: nf } ) );
		expect( container.textContent ).toBe( '' );
	} );

	it( 'marks a variation name built from an untranslated attribute value, linking to the term, with the row\'s own label', () => {
		const field = fieldFromDeclarative( makeField( { referenceLabel: 'Suomi' } as Partial< DeclarativeFieldInput > ), settings );
		const Render = field.render as ( props: { item: ProductListItem; field: NormalizedField< ProductListItem > } ) => JSX.Element;
		const name = {
			value: 'Omaking, Black with wool',
			source: 'Omaking, Musta villalla',
			referenceLabel: 'Black with wool has no Svenska translation; translate the attribute term.',
			untranslated: [ { id: 77, taxonomy: 'pa_color', name: 'Musta villalla', edit_link: 'https://example.test/term.php?tag_ID=77' } ],
		};
		const { container } = render( createElement( Render, { item: product( { i18n: { se: { name } } } ), field: normalized( field ) } ) );
		const marker = container.querySelector( 'a.wc-products-list-field__untranslated' );

		expect( marker?.getAttribute( 'href' ) ).toBe( 'https://example.test/term.php?tag_ID=77' );
		expect( marker?.getAttribute( 'title' ) ).toBe( name.referenceLabel );
		expect( container.textContent ).toBe( 'Omaking, Black with wool untranslated term' );
	} );

	it( 'marks a stored value equal to the default (copied, not translated) with a muted "copied" tag', () => {
		const field = fieldFromDeclarative( makeField( { referenceLabel: 'Suomi' } as Partial< DeclarativeFieldInput > ), settings );
		const Render = field.render as ( props: { item: ProductListItem; field: NormalizedField< ProductListItem > } ) => JSX.Element;
		const name = { value: 'Villasukat', source: 'Villasukat', same: true, referenceLabel: 'Same as the Suomi value: copied, not translated to Svenska yet' };
		const { container } = render( createElement( Render, { item: product( { i18n: { se: { name } } } ), field: normalized( field ) } ) );
		const cell = container.querySelector( '.wc-products-list-field--same' );

		expect( cell?.getAttribute( 'title' ) ).toBe( name.referenceLabel );
		expect( container.textContent ).toBe( 'Villasukat copied' );
	} );

	it( 'renders booleans, select labels and html as text', () => {
		const settingsWithOptions = settings;
		const bool = fieldFromDeclarative( makeField( { id: 'acme:flag', type: 'boolean', path: 'acme.flag', reference: null } ), settingsWithOptions );
		const select = fieldFromDeclarative(
			makeField( { id: 'acme:kind', type: 'select', path: 'acme.kind', reference: null, options: [ { value: 'a', label: 'Alpha' } ] } ),
			settingsWithOptions
		);
		const html = fieldFromDeclarative( makeField( { id: 'acme:html', type: 'html', path: 'acme.html', reference: null } ), settingsWithOptions );

		const text = ( field: typeof bool, item: ProductListItem ) =>
			render( createElement( field.render as never, { item, field: normalized( field ) } ) ).container.textContent;

		expect( text( bool, product( { acme: { flag: false } } ) ) ).toBe( 'No' );
		expect( text( bool, product( { acme: { flag: true } } ) ) ).toBe( 'Yes' );
		expect( text( select, product( { acme: { kind: 'a' } } ) ) ).toBe( 'Alpha' );
		expect( text( select, product( { acme: { kind: 'zz' } } ) ) ).toBe( 'zz' );
		expect( text( html, product( { acme: { html: '<p>Hello &amp; <strong>bye</strong></p>' } } ) ) ).toBe( 'Hello & bye' );
		expect( select.elements ).toEqual( [ { value: 'a', label: 'Alpha' } ] );
		expect( html.Edit ).toEqual( { control: 'textarea', rows: 4 } );
		expect( bool.type ).toBe( 'boolean' );
	} );

	it( 'carries the field currency so the edit form can format a reference in it', () => {
		const settings = makeSettings( { languages: { default: 'fi', others: [ 'se' ], labels: { se: 'Svenska' }, currencies: { se: 'SEK' } } } );
		const field = fieldFromDeclarative( makeField( { id: 'i18n_se_regular_price', type: 'price', group: 'i18n:se', path: 'i18n.se.regular_price.value' } ), settings );

		expect( field.currency ).toEqual( { code: 'SEK', symbol: 'kr', decimals: settings.currency.decimals } );
		expect( fieldFromDeclarative( makeField( { id: 'name_se', type: 'text' } ), settings ).currency ).toBeUndefined();
	} );

	it( 'gives price fields a currency-suffixed text control, locale parsing on write and validation', () => {
		const field = fieldFromDeclarative(
			makeField( { id: 'i18n:se.regular_price', type: 'price', path: 'i18n.se.regular_price.value', reference: 'i18n.se.regular_price.source', writePath: 'i18n.se.regular_price', bulk: 'money' } ),
			settings
		);
		const edit = field.Edit as { control: string; suffix: () => JSX.Element };

		expect( edit.control ).toBe( 'text' );
		expect( render( createElement( edit.suffix ) ).container.textContent ).toBe( 'kr' );
		expect( field.edit ).toMatchObject( { bulk: 'money', tab: 'i18n:se' } );

		expect( field.rest.write?.( '12,50', product() ) ).toEqual( { i18n: { se: { regular_price: '12.50' } } } );
		expect( field.rest.write?.( '', product() ) ).toEqual( { i18n: { se: { regular_price: '' } } } );
		expect( field.rest.write?.( 'abc', product() ) ).toEqual( { i18n: { se: { regular_price: 'abc' } } } );

		const custom = field.isValid?.custom as ( item: ProductListItem, field: NormalizedField< ProductListItem > ) => string | null;
		const nf = normalized( field );
		const withPrice = ( value: unknown ) => product( { i18n: { se: { regular_price: { value, source: '189' } } } } );

		expect( custom( withPrice( '12,50' ), nf ) ).toBeNull();
		expect( custom( withPrice( '' ), nf ) ).toBeNull();
		expect( custom( withPrice( 'abc' ), nf ) ).toMatch( /12,50/ );
		expect( custom( withPrice( '-1' ), nf ) ).toMatch( /negative/ );

		const Render = field.render as never;
		expect( render( createElement( Render, { item: withPrice( '1250' ), field: nf } ) ).container.textContent ).toBe( '1 250,00 kr' );
		expect( render( createElement( Render, { item: withPrice( '' ), field: nf } ) ).container.textContent ).toBe( '189,00 kr' );
	} );

	it( 'writes integers as numbers', () => {
		const field = fieldFromDeclarative( makeField( { id: 'acme:qty', type: 'integer', path: 'acme.qty', writePath: 'acme.qty', reference: null, bulk: 'integer' } ), settings );

		expect( field.type ).toBe( 'integer' );
		expect( field.rest.write?.( '12', product() ) ).toEqual( { acme: { qty: 12 } } );
		expect( field.rest.write?.( '', product() ) ).toEqual( { acme: { qty: '' } } );
	} );
} );

describe( 'filterFromDeclarative', () => {
	it( 'is a filter-only field sending each option\'s params', () => {
		const field = filterFromDeclarative( makeFilter() );

		expect( field.filterOnly ).toBe( true );
		expect( field.type ).toBeUndefined();
		expect( field.elements ).toEqual( [
			{ value: 'missing:se', label: 'Missing in Svenska' },
			{ value: 'translated:se', label: 'Translated to Svenska' },
		] );
		expect( field.filterBy ).toEqual( { operators: [ 'is' ], isPrimary: true } );
		expect( field.getValue?.( { item: product() } ) ).toBeUndefined();
		expect( field.edit ).toBe( false );
		expect( field.readOnly ).toBe( true );
		expect( field.rest.fields ).toEqual( [] );
		expect( field.rest.applies ).toEqual( { product: true, variation: true } );
		expect( field.rest.param ).toBeUndefined();
		expect( field.rest.toParams?.( 'missing:se', 'is' ) ).toEqual( { 'gds_i18n[lang]': 'se', 'gds_i18n[status]': 'missing' } );
		expect( field.rest.toParams?.( 'unknown', 'is' ) ).toEqual( {} );
		expect( render( createElement( field.render as never, { item: product(), field: normalized( field ) } ) ).container.textContent ).toBe( '' );
	} );

	it( 'falls back to { [param]: value } and types other than select', () => {
		const field = filterFromDeclarative( makeFilter( { id: 'featured', type: 'boolean', param: 'featured', options: [], operators: [], isPrimary: false, variations: false } ) );

		expect( field.type ).toBe( 'boolean' );
		expect( field.filterBy ).toEqual( { operators: [ 'is' ], isPrimary: false } );
		expect( field.rest.param ).toBe( 'featured' );
		expect( field.rest.toParams?.( true, 'is' ) ).toEqual( { featured: true } );
		expect( field.rest.toParams?.( 'x', 'isNot' ) ).toEqual( { exclude_featured: 'x' } );
		expect( field.rest.toParams?.( [ '1', '2' ], 'isAny' ) ).toEqual( { featured: [ '1', '2' ] } );
		expect( field.rest.toParams?.( '', 'is' ) ).toEqual( {} );
		expect( field.rest.applies.variation ).toBe( false );
	} );
} );

describe( 'actionFromDeclarative', () => {
	const response: ActionResponse = { batch_id: 'b', results: [], items: [] };

	it( 'runs on click without args or confirm, skipping placeholder rows', async () => {
		const run = vi.fn().mockResolvedValue( response );
		const action = actionFromDeclarative( makeAction(), run );
		const items = [ product(), variation(), { ...product( { id: 99 } ), _placeholder: 'loading' } as ProductListItem ];
		const onActionPerformed = vi.fn();

		expect( 'callback' in action ).toBe( true );
		expect( action.supportsBulk ).toBe( true );
		expect( action.scope ).toBe( 'both' );
		expect( action.source ).toBe( 'gds-woo-i18n' );

		( action as { callback: ( items: ProductListItem[], context: { registry: unknown; onActionPerformed?: ( items: ProductListItem[] ) => void } ) => void } ).callback( items, {
			registry: null,
			onActionPerformed,
		} );

		expect( run ).toHaveBeenCalledWith( [ 10, 11 ], {} );
		await waitFor( () => expect( onActionPerformed ).toHaveBeenCalledWith( items ) );
	} );

	it( 'is eligible by scope and never for placeholders', () => {
		const run = vi.fn();
		const forProducts = actionFromDeclarative( makeAction( { scope: 'product' } ), run );
		const forVariations = actionFromDeclarative( makeAction( { scope: 'variation' } ), run );
		const both = actionFromDeclarative( makeAction( { scope: 'both', capability: 'editOthers' } ), run );

		expect( forProducts.isEligible?.( product() ) ).toBe( true );
		expect( forProducts.isEligible?.( variation() ) ).toBe( false );
		expect( forVariations.isEligible?.( product() ) ).toBe( false );
		expect( forVariations.isEligible?.( variation() ) ).toBe( true );
		expect( both.isEligible?.( variation() ) ).toBe( true );
		expect( both.isEligible?.( { ...product(), _placeholder: 'more' } as ProductListItem ) ).toBe( false );
		expect( both.capability ).toBe( 'editOthers' );
	} );

	it( 'asks in a modal when there is a confirm text and runs on the button', async () => {
		const run = vi.fn().mockResolvedValue( response );
		const action = actionFromDeclarative( makeAction( { id: 'i18n_clear', label: 'Clear translations', confirm: 'Really clear?', destructive: true } ), run );
		const closeModal = vi.fn();
		const onActionPerformed = vi.fn();
		const items = [ product(), product( { id: 12 } ) ];

		expect( 'RenderModal' in action ).toBe( true );

		const { RenderModal } = action as { RenderModal: ( props: { items: ProductListItem[]; closeModal: () => void; onActionPerformed: ( items: ProductListItem[] ) => void } ) => JSX.Element };
		render( createElement( RenderModal, { items, closeModal, onActionPerformed } ) );

		expect( screen.getByText( 'Really clear?' ) ).toBeInTheDocument();

		const button = screen.getByRole( 'button', { name: 'Clear translations (2)' } );
		expect( button ).toHaveClass( 'is-destructive' );
		fireEvent.click( button );

		expect( run ).toHaveBeenCalledWith( [ 10, 12 ], {} );
		await waitFor( () => expect( closeModal ).toHaveBeenCalled() );
		expect( onActionPerformed ).toHaveBeenCalledWith( items );
	} );

	it( 'collects args with their defaults, blocks missing required ones and shows errors', async () => {
		const run = vi.fn().mockRejectedValue( new Error( 'Nope' ) );
		const action = actionFromDeclarative(
			makeAction( {
				args: [
					{ id: 'lang', label: 'Language', type: 'select', required: true, default: 'se', options: [ { value: 'se', label: 'Svenska' }, { value: 'en', label: 'English' } ] },
					{ id: 'overwrite', label: 'Overwrite', type: 'boolean', required: false, default: null, options: [] },
					{ id: 'note', label: 'Note', type: 'text', required: true, default: null, options: [] },
				],
			} ),
			run
		);
		const { RenderModal } = action as { RenderModal: ( props: { items: ProductListItem[] } ) => JSX.Element };

		render( createElement( RenderModal, { items: [ product() ] } ) );

		const button = screen.getByRole( 'button', { name: 'Copy default language (1)' } );
		expect( button ).toBeDisabled();

		fireEvent.change( screen.getByLabelText( /Note/ ), { target: { value: 'hi' } } );
		await waitFor( () => expect( button ).toBeEnabled() );

		fireEvent.click( button );
		expect( run ).toHaveBeenCalledWith( [ 10 ], { lang: 'se', overwrite: false, note: 'hi' } );
		expect( await screen.findByRole( 'alert' ) ).toHaveTextContent( 'Nope' );
		expect( button ).toBeEnabled();
	} );
} );

describe( 'action args', () => {
	it( 'starts a required select on its first option, so what the user sees is what is sent', async () => {
		const run = vi.fn().mockResolvedValue( { batch_id: 'b', results: [], items: [] } );
		const action = actionFromDeclarative(
			makeAction( {
				label: 'Copy translations',
				args: [
					{ id: 'lang', label: 'To language', type: 'select', required: true, default: null, options: [ { value: 'se', label: 'Svenska' }, { value: 'en', label: 'English' } ] },
					{ id: 'source', label: 'From language', type: 'select', required: false, default: 'fi', options: [ { value: 'fi', label: 'Suomi' }, { value: 'se', label: 'Svenska' } ] },
				],
			} ),
			run
		);
		const { RenderModal } = action as { RenderModal: ( props: { items: ProductListItem[] } ) => JSX.Element };

		render( createElement( RenderModal, { items: [ product() ] } ) );

		const button = screen.getByRole( 'button', { name: 'Copy translations (1)' } );
		expect( button ).toBeEnabled();
		fireEvent.click( button );
		expect( run ).toHaveBeenCalledWith( [ 10 ], { lang: 'se', source: 'fi' } );
	} );

	it( 'renders an array arg as a checkbox group and sends the chosen values as a list', async () => {
		const run = vi.fn().mockResolvedValue( { batch_id: 'b', results: [], items: [] } );
		const action = actionFromDeclarative(
			makeAction( {
				label: 'Copy translations',
				args: [
					{ id: 'fields', label: 'Fields', type: 'array', required: true, default: [ 'name' ], options: [ { value: 'name', label: 'Name' }, { value: 'slug', label: 'Slug' }, { value: 'description', label: 'Description' } ] },
				],
			} ),
			run
		);
		const { RenderModal } = action as { RenderModal: ( props: { items: ProductListItem[] } ) => JSX.Element };

		render( createElement( RenderModal, { items: [ product() ] } ) );

		const button = screen.getByRole( 'button', { name: 'Copy translations (1)' } );
		expect( screen.getByRole( 'checkbox', { name: 'Name' } ) ).toBeChecked();
		expect( screen.getByRole( 'checkbox', { name: 'Slug' } ) ).not.toBeChecked();
		expect( button ).toBeEnabled();

		// Unticking everything blocks a required list.
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Name' } ) );
		expect( button ).toBeDisabled();

		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Name' } ) );
		fireEvent.click( screen.getByRole( 'checkbox', { name: 'Slug' } ) );
		fireEvent.click( button );
		expect( run ).toHaveBeenCalledWith( [ 10 ], { fields: [ 'name', 'slug' ] } );
	} );

	it( 'defaultArgs parses list defaults and drops unknown options', () => {
		const options = [ { value: 'name', label: 'Name' }, { value: 'slug', label: 'Slug' } ];

		expect( defaultArgs( [ { id: 'f', label: 'F', type: 'array', required: false, default: 'name, slug, nope', options } ] ) ).toEqual( { f: [ 'name', 'slug' ] } );
		expect( defaultArgs( [ { id: 'f', label: 'F', type: 'array', required: false, default: null, options } ] ) ).toEqual( { f: [] } );
		expect( defaultArgs( [ { id: 'l', label: 'L', type: 'select', required: false, default: null, options } ] ) ).toEqual( { l: '' } );
		expect( defaultArgs( [ { id: 'b', label: 'B', type: 'boolean', required: false, default: null, options: [] } ] ) ).toEqual( { b: false } );
	} );
} );

describe( 'fromSettings', () => {
	it( 'converts every declarative definition and binds actions to runAction', async () => {
		const settings = makeSettings( {
			fields: [ makeField(), makeField( { id: 'i18n:en.name', path: 'i18n.en.name.value', group: 'i18n:en', writePath: 'i18n.en.name' } ) ],
			filters: [ makeFilter() ],
			actions: [ makeAction(), makeAction( { id: 'i18n_clear', confirm: 'Sure?' } ) ],
		} );
		const fields = fieldsFromSettings( settings );

		expect( fields.map( ( field ) => field.id ) ).toEqual( [ 'i18n:se.name', 'i18n:en.name', 'translation' ] );
		expect( fields.filter( ( field ) => field.filterOnly ).map( ( field ) => field.id ) ).toEqual( [ 'translation' ] );

		const runAction = vi.fn().mockResolvedValue( { batch_id: 'b', results: [], items: [] } );
		const actions = actionsFromSettings( settings, runAction );

		expect( actions.map( ( action ) => action.id ) ).toEqual( [ 'i18n_copy', 'i18n_clear' ] );
		( actions[ 0 ] as { callback: ( items: ProductListItem[], context: { registry: unknown } ) => void } ).callback( [ product() ], { registry: null } );
		await waitFor( () => expect( runAction ).toHaveBeenCalledWith( 'i18n_copy', [ 10 ], {} ) );
		expect( 'RenderModal' in ( actions[ 1 ] as object ) ).toBe( true );
	} );
} );

describe( 'actionPerformed', () => {
	it( 'announces the rows a server action processed without error, in the callback and the modal paths', async () => {
		const seen: unknown[] = [];
		addAction( ACTIONS.actionPerformed, 'test/action-performed', ( result: unknown ) => seen.push( result ) );

		try {
			const response: ActionResponse = { batch_id: 'b-9', results: [ { id: 10, ok: true }, { id: 11, ok: false, code: 'forbidden' } ], items: [ product( { id: 10 } ) ] };
			const run = vi.fn().mockResolvedValue( response );
			const plain = actionFromDeclarative( makeAction(), run );

			( plain as { callback: ( items: ProductListItem[], context: { registry: unknown } ) => void } ).callback( [ product(), variation() ], { registry: null } );
			await waitFor( () => expect( seen ).toHaveLength( 1 ) );
			expect( seen[ 0 ] ).toEqual( { action: 'i18n_copy', ids: [ 10 ], batchId: 'b-9', items: response.items } );

			const modal = actionFromDeclarative( makeAction( { confirm: 'Sure?' } ), run );
			const { RenderModal } = modal as { RenderModal: ( props: { items: ProductListItem[]; closeModal: () => void } ) => JSX.Element };
			render( createElement( RenderModal, { items: [ product() ], closeModal: vi.fn() } ) );
			fireEvent.click( screen.getByRole( 'button', { name: 'Copy default language (1)' } ) );
			await waitFor( () => expect( seen ).toHaveLength( 2 ) );
			expect( seen[ 1 ] ).toMatchObject( { action: 'i18n_copy', ids: [ 10 ] } );

			// A failed action announces nothing.
			const failing = actionFromDeclarative( makeAction(), vi.fn().mockRejectedValue( new Error( 'no' ) ) );
			( failing as { callback: ( items: ProductListItem[], context: { registry: unknown } ) => void } ).callback( [ product() ], { registry: null } );
			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
			expect( seen ).toHaveLength( 2 );
		} finally {
			removeAction( ACTIONS.actionPerformed, 'test/action-performed' );
		}
	} );

	it( 'keeps a declarative filter out of the column pickers', () => {
		const filter = filterFromDeclarative( { id: 'translation', label: 'Translation', type: 'select', param: null, options: [], operators: [ 'is' ], isPrimary: false, multiple: false, variations: false, order: 0, source: 'x' } );

		expect( filter.enableHiding ).toBe( false );
		expect( filter.filterOnly ).toBe( true );
	} );
} );
