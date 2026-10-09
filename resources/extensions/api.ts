/**
 * `window.wcProductsList`: the JavaScript extension API, plus the registries
 * it writes to. The registries are module state so `registerField()` and
 * friends work before the app mounts (extension scripts run between this
 * script's module code and `domReady`) and after it (a registry version is
 * bumped and subscribers re-derive their fields/actions).
 */
import { useSyncExternalStore } from '@wordpress/element';
import { addAction, addFilter, applyFilters, doAction, hasFilter, removeAction, removeFilter } from '@wordpress/hooks';
import type { Field } from '../dataviews';
import type {
	BatchResult,
	BatchUpdate,
	ExtensionApi,
	NoticeOptions,
	ProductAction,
	ProductField,
	ProductListItem,
	QueryContext,
	QueryParams,
	QuickEditTab,
	Settings,
} from '../types';
import { ACTIONS, FILTERS, HOOK_NAMESPACE, hookNamespace } from './hooks';
import { setExpectProvider } from '../edit/expect';

export type QueryParamsCallback = ( params: QueryParams, context: QueryContext ) => QueryParams;

/**
 * What an extension may pass to `registerField`: a DataViews field with the
 * ProductField extras optional. Missing parts get defaults (`rest.fields`
 * from the id, applies to products only, not editable).
 */
export type LooseProductField = Field< ProductListItem > &
	Partial< Pick< ProductField, 'productTypes' | 'edit' | 'reference' | 'source' > > & {
		rest?: Partial< Omit< ProductField[ 'rest' ], 'applies' > > & { applies?: Partial< ProductField[ 'rest' ][ 'applies' ] > };
	};

export interface ExtensionApiDeps {
	settings: Settings;
	refresh: ExtensionApi[ 'refresh' ];
	patchItems: ExtensionApi[ 'patchItems' ];
	batchUpdate: ExtensionApi[ 'batchUpdate' ];
	notices: ExtensionApi[ 'notices' ];
	/** The rows currently in the list (parents and expanded variations). */
	getItems?: () => ProductListItem[];
}

export interface ExtensionHooks {
	namespace: typeof HOOK_NAMESPACE;
	filters: typeof FILTERS;
	actions: typeof ACTIONS;
	addFilter: typeof addFilter;
	removeFilter: typeof removeFilter;
	hasFilter: typeof hasFilter;
	applyFilters: typeof applyFilters;
	addAction: typeof addAction;
	removeAction: typeof removeAction;
	doAction: typeof doAction;
	/** `hookNamespace( 'my-plugin' )` → the namespace to pass to addFilter/addAction. */
	hookNamespace: typeof hookNamespace;
}

/** The contract's ExtensionApi plus `getItems()`, `hooks` and the registry version. */
export interface ProductsListApi extends ExtensionApi {
	getItems(): ProductListItem[];
	hooks: ExtensionHooks;
	/** Increments on every register* call; the screen re-derives fields and actions when it changes. */
	readonly registryVersion: number;
}

interface Registry {
	fields: Map< string, ProductField >;
	actions: Map< string, ProductAction >;
	queryCallbacks: QueryParamsCallback[];
	tabs: Map< string, QuickEditTab >;
	version: number;
	listeners: Set< () => void >;
}

const registry: Registry = {
	fields: new Map(),
	actions: new Map(),
	queryCallbacks: [],
	tabs: new Map(),
	version: 0,
	listeners: new Set(),
};

let api: ProductsListApi | undefined;

function bump(): void {
	registry.version += 1;
	registry.listeners.forEach( ( listener ) => listener() );
}

function assertId( id: unknown, what: string ): asserts id is string {
	if ( typeof id !== 'string' || id === '' ) {
		throw new TypeError( `wcProductsList: a ${ what } needs a non-empty string id.` );
	}
}

/** True when the list query can act on a filter of this field (docs/contracts.md §3.1). */
export function hasFilterMapping( field: LooseProductField ): boolean {
	const rest = ( field.rest ?? {} ) as { param?: string; toParams?: unknown };

	if ( rest.param || typeof rest.toParams === 'function' ) {
		return true;
	}

	return ( ( field.elements ?? [] ) as Array< { params?: unknown } > ).some( ( element ) => element && typeof element === 'object' && 'params' in element );
}

export function normalizeRegisteredField( field: LooseProductField ): ProductField {
	assertId( field.id, 'field' );

	const rest: NonNullable< LooseProductField[ 'rest' ] > = field.rest ?? {};
	const applies: Partial< ProductField[ 'rest' ][ 'applies' ] > = rest.applies ?? {};

	return {
		...field,
		// A filter the server cannot map would silently do nothing: offer it only with a mapping.
		filterBy: field.filterBy === undefined && ! hasFilterMapping( field ) ? false : field.filterBy,
		rest: {
			...rest,
			fields: rest.fields ?? [ field.id.split( '.' )[ 0 ] as string ],
			applies: {
				product: applies.product ?? true,
				variation: applies.variation ?? false,
			},
		},
		productTypes: field.productTypes ?? 'all',
		edit: field.edit ?? false,
		source: field.source ?? 'js',
	};
}

/** Fields registered from JavaScript, in registration order; a re-registered id replaces the earlier one in place. */
export function getRegisteredFields(): ProductField[] {
	return Array.from( registry.fields.values() );
}

export function getRegisteredActions(): ProductAction[] {
	return Array.from( registry.actions.values() );
}

export function getQueryParamCallbacks(): QueryParamsCallback[] {
	return registry.queryCallbacks.slice();
}

/** Tabs sorted by `order` (default 100), ties in registration order. */
export function getQuickEditTabs(): QuickEditTab[] {
	return Array.from( registry.tabs.values() )
		.map( ( tab, index ) => ( { tab, index } ) )
		.sort( ( a, b ) => ( a.tab.order ?? 100 ) - ( b.tab.order ?? 100 ) || a.index - b.index )
		.map( ( { tab } ) => tab );
}

export function registerField( field: LooseProductField ): void {
	const normalized = normalizeRegisteredField( field );
	const expect = normalized.rest.expect;

	registry.fields.set( normalized.id, normalized );
	// Its expected values go with every write of the field (edit/expect.ts), the editor's and batchUpdate's alike.
	setExpectProvider( normalized.id, typeof expect === 'function' ? ( item, payload ) => expect( item, payload ) : undefined );
	bump();
}

export function registerAction( action: ProductAction ): void {
	assertId( action.id, 'action' );

	const kind = action as { callback?: unknown; RenderModal?: unknown };

	if ( typeof kind.callback !== 'function' && typeof kind.RenderModal !== 'function' ) {
		throw new TypeError( `wcProductsList: action "${ action.id }" needs a callback or a RenderModal.` );
	}

	registry.actions.set( action.id, { source: 'js', ...action } );
	bump();
}

export function addQueryParams( callback: QueryParamsCallback ): void {
	if ( typeof callback !== 'function' ) {
		throw new TypeError( 'wcProductsList: addQueryParams expects a function.' );
	}

	registry.queryCallbacks.push( callback );
	bump();
}

export function registerQuickEditTab( tab: QuickEditTab ): void {
	assertId( tab.id, 'quick-edit tab' );

	registry.tabs.set( tab.id, { ...tab, label: tab.label || tab.id } );
	bump();
}

/** Runs every `addQueryParams` callback over the params, in registration order. */
export function applyQueryParamCallbacks( params: QueryParams, context: QueryContext ): QueryParams {
	return registry.queryCallbacks.reduce( ( current, callback ) => {
		const next = callback( current, context );

		return next && typeof next === 'object' ? next : current;
	}, params );
}

export function getRegistryVersion(): number {
	return registry.version;
}

export function subscribeRegistry( listener: () => void ): () => void {
	registry.listeners.add( listener );

	return () => {
		registry.listeners.delete( listener );
	};
}

/** Re-renders the component when an extension registers something after mount. */
export function useRegistryVersion(): number {
	return useSyncExternalStore( subscribeRegistry, getRegistryVersion, getRegistryVersion );
}

/** Tests: empty the registries and forget the api. */
export function resetRegistry(): void {
	registry.fields.forEach( ( _field, id ) => setExpectProvider( id ) );
	registry.fields.clear();
	registry.actions.clear();
	registry.queryCallbacks.length = 0;
	registry.tabs.clear();
	registry.version = 0;
	registry.listeners.clear();
	api = undefined;

	if ( typeof window !== 'undefined' ) {
		delete window.wcProductsList;
	}
}

export function getExtensionApi(): ProductsListApi | undefined {
	return api;
}

/**
 * Creates the api, assigns it to `window.wcProductsList` and fires
 * `wcProductsList.ready` with it. Call once, before mounting the app. Calling
 * it again (hot reload, tests) replaces the window object and fires again;
 * registries are kept.
 */
export function createExtensionApi( deps: ExtensionApiDeps ): ProductsListApi {
	const notices: ExtensionApi[ 'notices' ] = {
		success: ( message: string, options?: NoticeOptions ) => deps.notices.success( message, options ),
		error: ( message: string, options?: NoticeOptions ) => deps.notices.error( message, options ),
		info: ( message: string, options?: NoticeOptions ) => deps.notices.info( message, options ),
	};

	const created: ProductsListApi = {
		version: deps.settings.version,
		settings: deps.settings,
		registerField: ( field: LooseProductField ) => registerField( field ),
		registerAction,
		addQueryParams,
		registerQuickEditTab,
		refresh: ( options?: { counts?: boolean } ) => deps.refresh( options ),
		patchItems: ( items ) => deps.patchItems( items ),
		batchUpdate: ( update: BatchUpdate, options?: { source?: string } ): Promise< BatchResult > => deps.batchUpdate( update, options ),
		notices,
		getItems: () => deps.getItems?.() ?? [],
		hooks: {
			namespace: HOOK_NAMESPACE,
			filters: FILTERS,
			actions: ACTIONS,
			addFilter,
			removeFilter,
			hasFilter,
			applyFilters,
			addAction,
			removeAction,
			doAction,
			hookNamespace,
		},
		get registryVersion() {
			return registry.version;
		},
	};

	api = created;

	if ( typeof window !== 'undefined' ) {
		window.wcProductsList = created;
	}

	doAction( ACTIONS.ready, created );

	return created;
}
