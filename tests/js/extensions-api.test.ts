import { addAction, addFilter, applyFilters, removeAction, removeFilter } from '@wordpress/hooks';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ACTIONS,
	FILTERS,
	applyQueryParamCallbacks,
	createExtensionApi,
	getExtensionApi,
	getQueryParamCallbacks,
	getQuickEditTabs,
	getRegisteredActions,
	getRegisteredFields,
	getRegistryVersion,
	hookNamespace,
	normalizeRegisteredField,
	registerAction,
	registerField,
	resetRegistry,
	subscribeRegistry,
	useRegistryVersion,
} from '../../resources/extensions';
import type { ExtensionApiDeps } from '../../resources/extensions';
import type { ProductListItem, QueryContext, Settings } from '../../resources/types';

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
		features: { cogs: false, brands: false, reviews: true },
		limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 50, actionBatchSize: 100 },
		links: { admin: '', rest: '', page: '', history: '', legacyList: '', newProduct: '', editProduct: '', assets: '' },
		fields: [],
		filters: [],
		actions: [],
		languages: null,
		...overrides,
	};
}

function makeDeps( overrides: Partial< ExtensionApiDeps > = {} ): ExtensionApiDeps {
	return {
		settings: makeSettings(),
		refresh: vi.fn().mockResolvedValue( undefined ),
		patchItems: vi.fn(),
		batchUpdate: vi.fn().mockResolvedValue( { updated: [], errors: [], batchId: 'b' } ),
		notices: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
		getItems: vi.fn().mockReturnValue( [] ),
		...overrides,
	};
}

const item = { id: 1, _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0 } as ProductListItem;

describe( 'hook names', () => {
	it( 'are stable strings under the wcProductsList namespace', () => {
		expect( Object.values( FILTERS ).every( ( name ) => name.startsWith( 'wcProductsList.' ) ) ).toBe( true );
		expect( Object.values( ACTIONS ) ).toEqual( [ 'wcProductsList.ready', 'wcProductsList.loaded', 'wcProductsList.saved', 'wcProductsList.deleted' ] );
		expect( FILTERS.quickEditTabs ).toBe( 'wcProductsList.quickEdit.tabs' );
		expect( FILTERS.quickEditLayout ).toBe( 'wcProductsList.quickEdit.layout' );
		expect( hookNamespace( 'gds-woo-i18n' ) ).toBe( 'gds-woo-i18n/wc-products-list' );
	} );
} );

describe( 'registries', () => {
	beforeEach( () => resetRegistry() );

	it( 'normalise loose fields and replace duplicates by id', () => {
		registerField( { id: 'total_sales', label: 'Sales' } );

		expect( getRegisteredFields() ).toHaveLength( 1 );
		expect( getRegisteredFields()[ 0 ] ).toMatchObject( {
			id: 'total_sales',
			rest: { fields: [ 'total_sales' ], applies: { product: true, variation: false } },
			productTypes: 'all',
			edit: false,
			source: 'js',
		} );

		registerField( { id: 'total_sales', label: 'Total sales', rest: { fields: [ 'total_sales', 'type' ], applies: { variation: true } }, edit: { group: 'g', bulk: false }, source: 'demo' } );

		expect( getRegisteredFields() ).toHaveLength( 1 );
		expect( getRegisteredFields()[ 0 ] ).toMatchObject( {
			label: 'Total sales',
			rest: { fields: [ 'total_sales', 'type' ], applies: { product: true, variation: true } },
			edit: { group: 'g', bulk: false },
			source: 'demo',
		} );
		expect( normalizeRegisteredField( { id: 'meta.note' } ).rest.fields ).toEqual( [ 'meta' ] );
		expect( () => registerField( { id: '' } ) ).toThrow( /id/ );
	} );

	it( 'register actions and reject ones without a handler', () => {
		registerAction( { id: 'a', label: 'A', callback: () => {} } );
		registerAction( { id: 'a', label: 'A2', callback: () => {}, source: 'demo' } );

		expect( getRegisteredActions() ).toHaveLength( 1 );
		expect( getRegisteredActions()[ 0 ] ).toMatchObject( { label: 'A2', source: 'demo' } );
		expect( () => registerAction( { id: 'b', label: 'B' } as never ) ).toThrow( /callback or a RenderModal/ );
	} );

	it( 'bump a version and notify subscribers on every registration', () => {
		const listener = vi.fn();
		const unsubscribe = subscribeRegistry( listener );
		const before = getRegistryVersion();

		registerField( { id: 'x' } );
		registerAction( { id: 'y', label: 'Y', callback: () => {} } );

		expect( getRegistryVersion() ).toBe( before + 2 );
		expect( listener ).toHaveBeenCalledTimes( 2 );

		unsubscribe();
		registerField( { id: 'z' } );
		expect( listener ).toHaveBeenCalledTimes( 2 );
	} );

	it( 're-render a component through useRegistryVersion', () => {
		const { result } = renderHook( () => useRegistryVersion() );
		const first = result.current;

		act( () => registerField( { id: 'late' } ) );

		expect( result.current ).toBe( first + 1 );
	} );
} );

describe( 'createExtensionApi', () => {
	beforeEach( () => {
		resetRegistry();
		removeAction( ACTIONS.ready, 'test/ready' );
		removeFilter( FILTERS.query, 'demo/wc-products-list' );
	} );

	afterEach( () => resetRegistry() );

	it( 'assigns window.wcProductsList and fires ready with it', () => {
		const ready = vi.fn();
		addAction( ACTIONS.ready, 'test/ready', ready );

		const deps = makeDeps();
		const api = createExtensionApi( deps );

		expect( window.wcProductsList ).toBe( api );
		expect( getExtensionApi() ).toBe( api );
		expect( ready ).toHaveBeenCalledWith( api );
		expect( api.version ).toBe( '0.1.0' );
		expect( api.settings ).toBe( deps.settings );
		expect( api.hooks.filters ).toBe( FILTERS );
		expect( api.hooks.actions ).toBe( ACTIONS );
		expect( api.hooks.namespace ).toBe( 'wcProductsList' );
	} );

	it( 'registers fields, actions, query callbacks and tabs before or after ready', () => {
		registerField( { id: 'before' } );

		const api = createExtensionApi( makeDeps() );
		api.registerField( { id: 'after', label: 'After' } as never );
		api.registerAction( { id: 'act', label: 'Act', callback: () => {} } );
		api.registerQuickEditTab( { id: 'notes', label: 'Notes', order: 200 } );
		api.registerQuickEditTab( { id: 'i18n:se', label: 'Svenska', order: 50 } );
		api.registerQuickEditTab( { id: 'plain', label: '' } );
		api.addQueryParams( ( params, context ) => ( context.tab === 'publish' ? { ...params, demo: 1 } : params ) );
		api.addQueryParams( ( params ) => ( { ...params, order: 'asc' } ) );

		expect( getRegisteredFields().map( ( field ) => field.id ) ).toEqual( [ 'before', 'after' ] );
		expect( getRegisteredActions().map( ( action ) => action.id ) ).toEqual( [ 'act' ] );
		expect( getQuickEditTabs().map( ( tab ) => tab.id ) ).toEqual( [ 'i18n:se', 'plain', 'notes' ] );
		expect( getQuickEditTabs()[ 1 ]?.label ).toBe( 'plain' );
		expect( getQueryParamCallbacks() ).toHaveLength( 2 );

		const context = { tab: 'publish', view: { type: 'table' }, fields: [] } as unknown as QueryContext;
		expect( applyQueryParamCallbacks( { page: 1 }, context ) ).toEqual( { page: 1, demo: 1, order: 'asc' } );
		expect( applyQueryParamCallbacks( { page: 1 }, { ...context, tab: 'draft' } ) ).toEqual( { page: 1, order: 'asc' } );
		expect( api.registryVersion ).toBe( getRegistryVersion() );
		expect( () => api.addQueryParams( 'nope' as never ) ).toThrow( /function/ );
	} );

	it( 'ignores query callbacks that return nothing', () => {
		const api = createExtensionApi( makeDeps() );
		api.addQueryParams( () => undefined as never );

		expect( applyQueryParamCallbacks( { page: 2 }, { tab: 'all', view: { type: 'table' }, fields: [] } as unknown as QueryContext ) ).toEqual( { page: 2 } );
	} );

	it( 'delegates refresh, patchItems, batchUpdate, notices and getItems to the app', async () => {
		const deps = makeDeps( { getItems: vi.fn().mockReturnValue( [ item ] ) } );
		const api = createExtensionApi( deps );

		await api.refresh( { counts: true } );
		expect( deps.refresh ).toHaveBeenCalledWith( { counts: true } );

		api.patchItems( [ { id: 1, sku: 'X' } ] );
		expect( deps.patchItems ).toHaveBeenCalledWith( [ { id: 1, sku: 'X' } ] );

		const update = { products: [ { id: 1, sale_price: '' } ] };
		await expect( api.batchUpdate( update, { source: 'extension' } ) ).resolves.toEqual( { updated: [], errors: [], batchId: 'b' } );
		expect( deps.batchUpdate ).toHaveBeenCalledWith( update, { source: 'extension' } );

		api.notices.success( 'ok', { type: 'snackbar' } );
		api.notices.error( 'bad' );
		api.notices.info( 'fyi' );
		expect( deps.notices.success ).toHaveBeenCalledWith( 'ok', { type: 'snackbar' } );
		expect( deps.notices.error ).toHaveBeenCalledWith( 'bad', undefined );
		expect( deps.notices.info ).toHaveBeenCalledWith( 'fyi', undefined );

		expect( api.getItems() ).toEqual( [ item ] );
		expect( createExtensionApi( makeDeps( { getItems: undefined } ) ).getItems() ).toEqual( [] );
	} );

	it( 'exposes wp.hooks so an extension can filter without importing anything', () => {
		const api = createExtensionApi( makeDeps() );

		api.hooks.addFilter( api.hooks.filters.query, api.hooks.hookNamespace( 'demo' ), ( params: Record< string, unknown > ) => ( { ...params, demo: true } ) );

		expect( applyFilters( FILTERS.query, { page: 1 }, {} ) ).toEqual( { page: 1, demo: true } );
		expect( api.hooks.hasFilter( FILTERS.query, 'demo/wc-products-list' ) ).toBe( true );

		addFilter( FILTERS.fields, 'test/fields', ( fields: unknown[] ) => [ ...fields, { id: 'via-hook' } ] );
		expect( api.hooks.applyFilters( FILTERS.fields, [], api.settings ) ).toEqual( [ { id: 'via-hook' } ] );
		removeFilter( FILTERS.fields, 'test/fields' );
	} );

	it( 'resetRegistry forgets the api and the window global', () => {
		createExtensionApi( makeDeps() );
		resetRegistry();

		expect( window.wcProductsList ).toBeUndefined();
		expect( getExtensionApi() ).toBeUndefined();
		expect( getRegisteredFields() ).toEqual( [] );
	} );
} );
