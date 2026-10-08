/**
 * Expansion state and variation loading for the product list.
 *
 * Children live in a module-level store (useSyncExternalStore) so that:
 * - paging back to a parent you expanded earlier is instant;
 * - `patchVariationRows` / `removeVariationRows` (called from the products
 *   store after a save, an action or an optimistic patch) reach every
 *   variation row the list shows, wherever the hook is mounted.
 *
 * Expanded ids persist in sessionStorage so a reload keeps the tree open.
 * Loading goes through one limiter: at most 4 requests in flight for the
 * whole hierarchy (expand all, variationIdsOf and single expands share it).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from '@wordpress/element';
import { addAction } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';
import { getVariations } from '../api/client';
import { getSettings } from '../settings';
import { ACTIONS } from '../extensions/hooks';
import { getItemId } from '../types/product';
import type { BatchResult, ProductField } from '../types/extension';
import type { ProductListItem, ProductRow, RawVariation, VariationRow } from '../types/product';
import { flattenHierarchy, projectedChildRows } from './flatten';
import type { ChildrenState } from './flatten';
import { normalizeVariation } from './normalize';

export const EXPANDED_STORAGE_KEY = 'wcProductsList.expanded';

/** Rows above which expandAll asks before loading. */
export const EXPAND_ALL_WARN_ROWS = 2000;

export const VARIATIONS_PER_PAGE = 100;

export const MAX_CONCURRENT_REQUESTS = 4;

/** The `_fields` every variation request carries, whatever the view shows. */
export const VARIATION_BASE_FIELDS = [ 'id', 'name', 'status', 'parent_id', 'attributes', 'image', 'sku', 'wc_products_list' ] as const;

export type VariationsResult = { items: RawVariation[]; total: number; totalPages: number };

export type FetchVariations = (
	parentId: number,
	page: number,
	options: { perPage: number; fields: string[]; signal?: AbortSignal }
) => Promise< VariationsResult >;

export interface HierarchyOptions {
	/** Defaults to `api/client` `getVariations`; tests inject a stub. */
	fetchVariations?: FetchVariations;
	/** Defaults to `limits.maxChildrenPerParent`. */
	maxChildren?: number;
	/** Asked before expandAll adds more than EXPAND_ALL_WARN_ROWS rows; defaults to window.confirm. */
	confirmExpandAll?: ( rows: number ) => boolean | Promise< boolean >;
	/** Defaults to window.sessionStorage. */
	storage?: Pick< Storage, 'getItem' | 'setItem' > | null;
}

export interface Hierarchy {
	/** The flattened rows for DataViews. */
	rows: ProductListItem[];
	expandedItemIds: number[];
	onChangeExpandedItemIds( ids: number[] ): void;
	isExpanded( id: number ): boolean;
	toggle( id: number ): void;
	/** Expand and resolve once the variations are loaded (or failed). */
	expand( id: number ): Promise< void >;
	collapse( id: number ): void;
	/** Reload a parent's variations (after an error, or to refresh). */
	retry( id: number ): Promise< void >;
	/** Expand every variable product on the page. Resolves to false when the user declined the warning. */
	expandAll( options?: { force?: boolean } ): Promise< boolean >;
	collapseAll(): void;
	getItemParentId( item: ProductListItem ): number | null;
	getItemHasChildren( item: ProductListItem ): boolean;
	getItemLevel( item: ProductListItem ): number;
	childrenOf( parentId: number ): ChildrenState | undefined;
	/** Every parent's state, for HierarchicalDataViews' `childrenState`. */
	childrenState: ReadonlyMap< number, ChildrenState >;
	/** All variation ids of the parents (loaded or fetched with `_fields=id`), in parent order. */
	variationIdsOf( parentIds: number[] ): Promise< number[] >;
	/**
	 * Expand a parent and return `current` plus its variation ids as
	 * DataViews selection ids. DataViews drops selected ids that are not in
	 * `data`, so the parent must be expanded for the selection to stick.
	 */
	selectVariations( parentId: number, current?: string[] ): Promise< string[] >;
}

export const getItemParentId = ( item: ProductListItem ): number | null => item._parentId;
export const getItemHasChildren = ( item: ProductListItem ): boolean => item._hasChildren;
export const getItemLevel = ( item: ProductListItem ): number => item._level;

/* ------------------------------------------------------------------------ */
/* Children store                                                            */
/* ------------------------------------------------------------------------ */

type Listener = () => void;

let children: Map< number, ChildrenState > = new Map();
const listeners = new Set< Listener >();
const inflight = new Map< number, Promise< void > >();
const idCache = new Map< number, number[] >();

function emit(): void {
	for ( const listener of listeners ) {
		listener();
	}
}

function setChildren( parentId: number, state: ChildrenState ): void {
	const next = new Map( children );
	next.set( parentId, state );
	children = next;
	emit();
}

export function subscribeChildren( listener: Listener ): () => void {
	listeners.add( listener );

	return () => {
		listeners.delete( listener );
	};
}

export function getChildrenState(): ReadonlyMap< number, ChildrenState > {
	return children;
}

/**
 * Merge partial rows into loaded variations by id. Called by the products
 * store's `patchItems`; unknown ids are ignored.
 */
export function patchVariationRows( items: Array< Partial< ProductListItem > & { id: number } > ): void {
	if ( ! items.length || ! children.size ) {
		return;
	}

	const byId = new Map( items.map( ( item ) => [ item.id, item ] ) );
	let changed = false;
	const next = new Map( children );

	for ( const [ parentId, state ] of children ) {
		if ( ! state.items.some( ( item ) => byId.has( item.id ) ) ) {
			continue;
		}

		changed = true;
		next.set( parentId, {
			...state,
			items: state.items.map( ( item ) => {
				const patch = byId.get( item.id );

				return patch ? ( normalizeVariation( { ...item, ...patch } as RawVariation, parentId ) as VariationRow ) : item;
			} ),
		} );
	}

	if ( changed ) {
		children = next;
		emit();
	}
}

/** Drop variations by id (after delete). Parents being removed drop their whole state. */
export function removeVariationRows( ids: number[] ): void {
	if ( ! ids.length || ! children.size ) {
		return;
	}

	const gone = new Set( ids );
	let changed = false;
	const next = new Map( children );

	for ( const [ parentId, state ] of children ) {
		if ( gone.has( parentId ) ) {
			next.delete( parentId );
			idCache.delete( parentId );
			changed = true;
			continue;
		}

		const kept = state.items.filter( ( item ) => ! gone.has( item.id ) );

		if ( kept.length !== state.items.length ) {
			changed = true;
			next.set( parentId, { ...state, items: kept, total: Math.max( 0, state.total - ( state.items.length - kept.length ) ) } );
			idCache.delete( parentId );
		}
	}

	if ( changed ) {
		children = next;
		emit();
	}
}

/** Forget loaded variations (all, or of the given parents); expanded parents reload on the next render. */
export function invalidateVariations( parentIds?: number[] ): void {
	if ( ! parentIds ) {
		children = new Map();
		idCache.clear();
		emit();

		return;
	}

	const next = new Map( children );

	for ( const id of parentIds ) {
		next.delete( id );
		idCache.delete( id );
	}

	children = next;
	emit();
}

/**
 * Confirmed saves and deletions reach the variation rows through the
 * app's own actions, so the hierarchy stays right even before the products
 * store wires `patchVariationRows` / `removeVariationRows` for optimistic
 * patches (docs/contracts.md, "Hierarchy").
 */
addAction( ACTIONS.saved, 'wcProductsList/hierarchy', ( result: BatchResult ) => {
	if ( Array.isArray( result?.updated ) ) {
		patchVariationRows( result.updated );
	}
} );

addAction( ACTIONS.deleted, 'wcProductsList/hierarchy', ( ids: number[] ) => {
	if ( Array.isArray( ids ) ) {
		removeVariationRows( ids );
	}
} );

/* ------------------------------------------------------------------------ */
/* Request limiter                                                           */
/* ------------------------------------------------------------------------ */

export function createLimiter( concurrency: number ) {
	let active = 0;
	const queue: Array< () => void > = [];

	const next = () => {
		active -= 1;
		queue.shift()?.();
	};

	return async function run< T >( task: () => Promise< T > ): Promise< T > {
		if ( active >= concurrency ) {
			await new Promise< void >( ( resolve ) => queue.push( resolve ) );
		}

		active += 1;

		try {
			return await task();
		} finally {
			next();
		}
	};
}

const limit = createLimiter( MAX_CONCURRENT_REQUESTS );

/* ------------------------------------------------------------------------ */
/* Loading                                                                   */
/* ------------------------------------------------------------------------ */

function errorMessage( error: unknown ): string {
	if ( error instanceof Error && error.message ) {
		return error.message;
	}

	return __( 'The variations could not be loaded.', 'wp-woocommerce-products-list' );
}

function restFields( fields: ProductField[] ): string[] {
	const keys = new Set< string >( VARIATION_BASE_FIELDS );

	for ( const field of fields ) {
		if ( field.rest?.applies?.variation === false ) {
			continue;
		}

		for ( const key of field.rest?.fields ?? [] ) {
			// Variations carry one `image`, not a gallery.
			keys.add( key === 'images' ? 'image' : key );
		}
	}

	return Array.from( keys );
}

/**
 * Load all variations of a parent: page 1 first (it carries the total), then
 * the remaining pages up to the cap, through the shared limiter. Rows are
 * kept in page order whatever order the responses arrive in.
 */
function loadChildren( parent: ProductRow, fields: string[], fetch: FetchVariations, maxChildren: number ): Promise< void > {
	const parentId = parent.id;
	const pending = inflight.get( parentId );

	if ( pending ) {
		return pending;
	}

	const previous = children.get( parentId );

	if ( previous?.status === 'loaded' ) {
		return Promise.resolve();
	}

	setChildren( parentId, { status: 'loading', items: previous?.items ?? [], total: previous?.total ?? 0 } );

	const perPage = VARIATIONS_PER_PAGE;
	const cap = maxChildren > 0 ? maxChildren : Infinity;
	const normalize = ( rows: RawVariation[] ) => rows.map( ( row ) => normalizeVariation( row, parent ) );

	const task = ( async () => {
		try {
			const first = await limit( () => fetch( parentId, 1, { perPage, fields } ) );
			const pages: VariationRow[][] = [ normalize( first.items ) ];
			const total = first.total || first.items.length;
			const wanted = Math.min( total, cap );
			const lastPage = Math.max( 1, Math.ceil( wanted / perPage ) );

			if ( lastPage > 1 ) {
				setChildren( parentId, { status: 'loading', items: pages[ 0 ] ?? [], total } );

				await Promise.all(
					Array.from( { length: lastPage - 1 }, ( _, index ) => index + 2 ).map( async ( page ) => {
						const result = await limit( () => fetch( parentId, page, { perPage, fields } ) );
						pages[ page - 1 ] = normalize( result.items );
					} )
				);
			}

			setChildren( parentId, { status: 'loaded', items: pages.flat(), total } );
		} catch ( error ) {
			const partial = children.get( parentId );
			setChildren( parentId, { status: 'error', items: partial?.items ?? [], total: partial?.total ?? 0, error: errorMessage( error ) } );
		} finally {
			inflight.delete( parentId );
		}
	} )();

	inflight.set( parentId, task );

	return task;
}

async function loadVariationIds( parentId: number, fetch: FetchVariations ): Promise< number[] > {
	const loaded = children.get( parentId );

	if ( loaded?.status === 'loaded' && loaded.items.length >= loaded.total ) {
		return loaded.items.map( ( item ) => item.id );
	}

	const cached = idCache.get( parentId );

	if ( cached ) {
		return cached;
	}

	const perPage = VARIATIONS_PER_PAGE;
	const fields = [ 'id' ];
	const first = await limit( () => fetch( parentId, 1, { perPage, fields } ) );
	const pages: number[][] = [ first.items.map( ( item ) => item.id ) ];
	const lastPage = Math.max( 1, first.totalPages || Math.ceil( first.total / perPage ) );

	await Promise.all(
		Array.from( { length: lastPage - 1 }, ( _, index ) => index + 2 ).map( async ( page ) => {
			const result = await limit( () => fetch( parentId, page, { perPage, fields } ) );
			pages[ page - 1 ] = result.items.map( ( item ) => item.id );
		} )
	);

	const ids = pages.flat();
	idCache.set( parentId, ids );

	return ids;
}

/* ------------------------------------------------------------------------ */
/* Persistence                                                               */
/* ------------------------------------------------------------------------ */

function defaultStorage(): Pick< Storage, 'getItem' | 'setItem' > | null {
	try {
		return typeof window !== 'undefined' ? window.sessionStorage : null;
	} catch {
		return null;
	}
}

export function readExpanded( storage: Pick< Storage, 'getItem' > | null ): number[] {
	try {
		const raw = storage?.getItem( EXPANDED_STORAGE_KEY );
		const parsed: unknown = raw ? JSON.parse( raw ) : [];

		return Array.isArray( parsed ) ? parsed.filter( ( id ): id is number => Number.isInteger( id ) && id > 0 ) : [];
	} catch {
		return [];
	}
}

export function writeExpanded( storage: Pick< Storage, 'setItem' > | null, ids: number[] ): void {
	try {
		storage?.setItem( EXPANDED_STORAGE_KEY, JSON.stringify( ids ) );
	} catch {
		// Private mode or a full store: the tree just will not survive a reload.
	}
}

function defaultConfirm( rows: number ): boolean {
	if ( typeof window === 'undefined' || typeof window.confirm !== 'function' ) {
		return true;
	}

	return window.confirm(
		sprintf(
			/* translators: %d: number of rows */
			__( 'This will show about %d rows, which may be slow. Continue?', 'wp-woocommerce-products-list' ),
			rows
		)
	);
}

function sameIds( a: number[], b: number[] ): boolean {
	return a.length === b.length && a.every( ( id, index ) => id === b[ index ] );
}

/* ------------------------------------------------------------------------ */
/* Hook                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * @param parents The page's products (level 0), normalised.
 * @param fields  The visible fields: their `rest.fields` decide the `_fields` of variation requests.
 */
export function useHierarchy( parents: ProductRow[], fields: ProductField[], options: HierarchyOptions = {} ): Hierarchy {
	const fetch = options.fetchVariations ?? ( getVariations as unknown as FetchVariations );
	const maxChildren = options.maxChildren ?? getSettings().limits.maxChildrenPerParent;
	const confirmExpandAll = options.confirmExpandAll ?? defaultConfirm;
	const storage = options.storage === undefined ? defaultStorage() : options.storage;

	const [ expandedItemIds, setExpandedState ] = useState< number[] >( () => readExpanded( storage ) );
	const expandedSet = useMemo( () => new Set( expandedItemIds ), [ expandedItemIds ] );
	const childrenState = useSyncExternalStore( subscribeChildren, getChildrenState, getChildrenState );

	const parentsById = useMemo( () => new Map( parents.map( ( parent ) => [ parent.id, parent ] ) ), [ parents ] );
	const fieldKeys = useMemo( () => restFields( fields ), [ fields ] );

	// A column shown later needs values the loaded variations were fetched
	// without: forget them, the expanded parents reload below. Hiding a
	// column leaves extra data behind, which is harmless.
	const knownKeys = useRef( new Set( fieldKeys ) );
	useEffect( () => {
		const missing = fieldKeys.some( ( key ) => ! knownKeys.current.has( key ) );

		fieldKeys.forEach( ( key ) => knownKeys.current.add( key ) );

		if ( missing && children.size > 0 ) {
			invalidateVariations();
		}
	}, [ fieldKeys ] );

	// Latest values for callbacks that must not change identity on every
	// render; refreshed before any effect or event handler can read them.
	const latestRef = useRef( { parentsById, fieldKeys, fetch, maxChildren, expandedItemIds } );
	useLayoutEffect( () => {
		latestRef.current = { parentsById, fieldKeys, fetch, maxChildren, expandedItemIds };
	} );

	const setExpanded = useCallback(
		( ids: number[] ) => {
			const unique = Array.from( new Set( ids.filter( ( id ) => Number.isInteger( id ) && id > 0 ) ) );

			setExpandedState( ( current ) => ( sameIds( current, unique ) ? current : unique ) );
			writeExpanded( storage, unique );
		},
		[ storage ]
	);

	const load = useCallback( ( id: number ): Promise< void > => {
		const { parentsById: byId, fieldKeys: keys, fetch: fetcher, maxChildren: cap } = latestRef.current;
		const parent = byId.get( id );

		if ( ! parent || ! parent._hasChildren ) {
			return Promise.resolve();
		}

		return loadChildren( parent, keys, fetcher, cap );
	}, [] );

	// Expanded parents on this page without loaded children: fetch them.
	// Covers the session restore, a toggle, expandAll and invalidation.
	useEffect( () => {
		for ( const id of expandedItemIds ) {
			const parent = parentsById.get( id );
			const state = children.get( id );

			if ( parent?._hasChildren && ( ! state || state.status === 'idle' ) ) {
				void load( id );
			}
		}
	}, [ expandedItemIds, parentsById, childrenState, load ] );

	const rows = useMemo(
		() => flattenHierarchy( parents, expandedSet, childrenState, maxChildren ),
		[ parents, expandedSet, childrenState, maxChildren ]
	);

	const isExpanded = useCallback( ( id: number ) => expandedSet.has( id ), [ expandedSet ] );

	const expand = useCallback(
		( id: number ) => {
			const current = latestRef.current.expandedItemIds;

			if ( ! current.includes( id ) ) {
				setExpanded( [ ...current, id ] );
			}

			return load( id );
		},
		[ load, setExpanded ]
	);

	const collapse = useCallback(
		( id: number ) => {
			setExpanded( latestRef.current.expandedItemIds.filter( ( expandedId ) => expandedId !== id ) );
		},
		[ setExpanded ]
	);

	const toggle = useCallback(
		( id: number ) => {
			if ( latestRef.current.expandedItemIds.includes( id ) ) {
				collapse( id );
			} else {
				void expand( id );
			}
		},
		[ collapse, expand ]
	);

	const retry = useCallback(
		( id: number ) => {
			invalidateVariations( [ id ] );

			return expand( id );
		},
		[ expand ]
	);

	const expandAll = useCallback(
		async ( { force = false }: { force?: boolean } = {} ) => {
			const current = latestRef.current.expandedItemIds;
			const expandable = parents.filter( ( parent ) => parent._hasChildren );
			const missing = expandable.filter( ( parent ) => ! current.includes( parent.id ) );

			if ( ! missing.length ) {
				return true;
			}

			const projected = rows.length + projectedChildRows( missing, children, maxChildren );

			if ( ! force && projected > EXPAND_ALL_WARN_ROWS && ! ( await confirmExpandAll( projected ) ) ) {
				return false;
			}

			setExpanded( [ ...current, ...missing.map( ( parent ) => parent.id ) ] );
			await Promise.all( missing.map( ( parent ) => load( parent.id ) ) );

			return true;
		},
		[ parents, rows.length, maxChildren, confirmExpandAll, setExpanded, load ]
	);

	const collapseAll = useCallback( () => setExpanded( [] ), [ setExpanded ] );

	const childrenOf = useCallback( ( parentId: number ) => childrenState.get( parentId ), [ childrenState ] );

	const variationIdsOf = useCallback( async ( parentIds: number[] ): Promise< number[] > => {
		const lists = await Promise.all( parentIds.map( ( id ) => loadVariationIds( id, latestRef.current.fetch ) ) );

		return lists.flat();
	}, [] );

	const selectVariations = useCallback(
		async ( parentId: number, current: string[] = [] ): Promise< string[] > => {
			await expand( parentId );

			const state = children.get( parentId );
			const ids = ( state?.items ?? [] ).map( ( item ) => getItemId( item ) );
			const have = new Set( current );

			return [ ...current, ...ids.filter( ( id ) => ! have.has( id ) ) ];
		},
		[ expand ]
	);

	return {
		rows,
		expandedItemIds,
		onChangeExpandedItemIds: setExpanded,
		isExpanded,
		toggle,
		expand,
		collapse,
		retry,
		expandAll,
		collapseAll,
		getItemParentId,
		getItemHasChildren,
		getItemLevel,
		childrenOf,
		childrenState,
		variationIdsOf,
		selectVariations,
	};
}

/** Tests: reset the module store. */
export function resetHierarchyStore(): void {
	children = new Map();
	inflight.clear();
	idCache.clear();
	emit();
}
