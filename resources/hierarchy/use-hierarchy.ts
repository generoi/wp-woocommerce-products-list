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
 *
 * Speed rules (the table re-renders every row on every store change):
 * - load progress is published through one coalesced emit per short window,
 *   so a parent whose pages trickle in produces a few renders, not one per
 *   response; user gestures (expand, collapse, patches) emit at once;
 * - "expand all" publishes in bounded commits (every BULK_PUBLISH_ROWS loaded
 *   rows, one per frame), never one render of the whole page at the end;
 * - every load carries an AbortController: collapsing a parent, paging away
 *   from it or unmounting aborts the request and drops it from the limiter
 *   queue, so the page the user looks at is never queued behind the one
 *   they left;
 * - loaded children of parents that are neither expanded nor on the page
 *   are evicted beyond a cap, so memory does not grow with every parent
 *   ever visited.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from '@wordpress/element';
import { addAction } from '@wordpress/hooks';
import { __, _n, sprintf } from '@wordpress/i18n';
import { getVariations } from '../api/client';
import { isAbortError } from '../api/errors';
import { getSettings } from '../settings';
import { notify } from '../actions/notices';
import { ACTIONS } from '../extensions/hooks';
import { getItemId } from '../types/product';
import type { BatchResult, ProductField } from '../types/extension';
import type { ProductListItem, ProductRow, RawImage, RawVariation, VariationRow } from '../types/product';
import { flattenHierarchy } from './flatten';
import type { ChildrenState } from './flatten';
import { normalizeVariation } from './normalize';

export const EXPANDED_STORAGE_KEY = 'wcProductsList.expanded';

/**
 * Rows above which expandAll asks before loading. DataViews renders every
 * row (no virtualisation): a 1,800-row table takes ~2 s per render with
 * production React and holds hundreds of MB, so the warning comes early.
 */
export const EXPAND_ALL_WARN_ROWS = 600;

/**
 * Rows a page never grows beyond through expandAll or a restored expansion:
 * a 2,500-row table froze the renderer for most of a minute. expandAll stops
 * at the parent that would cross it (the rest stay collapsed, with a notice);
 * expanded ids restored from storage or revisited on a later page are trimmed
 * to it in page order (to EXPAND_ALL_WARN_ROWS when restored on load, where
 * nobody asked for a large table).
 */
export const EXPAND_ALL_MAX_ROWS = 1500;

export const VARIATIONS_PER_PAGE = 100;

export const MAX_CONCURRENT_REQUESTS = 6;

/** Loaded parents kept beyond the expanded ones and the current page. */
export const MAX_CACHED_PARENTS = 60;

/** Responses arriving within this window share one render (ms). */
export const EMIT_WINDOW = 40;

/**
 * While `expandAll` runs, loaded rows are published in commits of about
 * this many rows, one per animation frame, instead of once at the end: a
 * single commit of a 1,000-row table blocks the renderer for seconds (16 s
 * measured with the development React build), while a commit of 150 rows
 * on top of memoised ones is short enough for the page to stay responsive
 * and show the counter between commits. Per-parent loading markers are
 * still not published (the expanded ids already show every parent as
 * loading). Progress goes through its own tiny store
 * (`useExpandAllProgress`), read by a component outside the table, so the
 * counter never re-renders a row.
 */
export const BULK_PUBLISH_ROWS = 150;

export interface ExpandAllProgress {
	done: number;
	total: number;
}

/** The `_fields` every variation request carries, whatever the view shows. */
export const VARIATION_BASE_FIELDS = [ 'id', 'name', 'status', 'parent_id', 'attributes', 'image', 'sku', 'wc_products_list' ] as const;

export type VariationsResult = { items: RawVariation[]; total: number; totalPages: number };

export type FetchVariations = (
	parentId: number,
	page: number,
	options: { perPage: number; fields: string[]; signal?: AbortSignal }
) => Promise< VariationsResult >;

export interface ExpandAllLimit {
	/** Parents expanded by this call. */
	expanded: number;
	/** Parents left collapsed because the page would pass EXPAND_ALL_MAX_ROWS. */
	skipped: number;
	/** Rows on the page after the call. */
	rows: number;
}

export interface HierarchyOptions {
	/** Defaults to `api/client` `getVariations`; tests inject a stub. */
	fetchVariations?: FetchVariations;
	/** Defaults to `limits.maxChildrenPerParent`. */
	maxChildren?: number;
	/** Asked before expandAll adds more than EXPAND_ALL_WARN_ROWS rows; defaults to window.confirm. */
	confirmExpandAll?: ( rows: number ) => boolean | Promise< boolean >;
	/** Called when expandAll left parents collapsed to stay under EXPAND_ALL_MAX_ROWS; defaults to an info notice. */
	onExpandAllLimit?: ( limit: ExpandAllLimit ) => void;
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
	/**
	 * Expand the variable products on the page, in page order, as far as
	 * EXPAND_ALL_MAX_ROWS allows. Resolves to false when the user declined the
	 * warning or nothing could be expanded.
	 */
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
	 * With `where`, only the variations it accepts are added (e.g. the
	 * out-of-stock ones).
	 */
	selectVariations( parentId: number, current?: string[], where?: ( item: VariationRow ) => boolean ): Promise< string[] >;
}

export const getItemParentId = ( item: ProductListItem ): number | null => item._parentId;
export const getItemHasChildren = ( item: ProductListItem ): boolean => item._hasChildren;
export const getItemLevel = ( item: ProductListItem ): number => item._level;

/* ------------------------------------------------------------------------ */
/* Children store                                                            */
/* ------------------------------------------------------------------------ */

type Listener = () => void;

interface Inflight {
	promise: Promise< void >;
	controller: AbortController;
}

let children: Map< number, ChildrenState > = new Map();
const listeners = new Set< Listener >();
const inflight = new Map< number, Inflight >();
const idCache = new Map< number, number[] >();
/** Each loaded parent's first image: what wc/v3 reads show for a variation without an image of its own. */
const parentImages = new Map< number, RawImage | undefined >();

/** What the mounted hook currently shows: used by the eviction and by the limiter's cancellation checks. */
let currentExpanded: ReadonlySet< number > = new Set();
let currentParents: ReadonlySet< number > = new Set();

let emitTimer: ReturnType< typeof setTimeout > | undefined;
let emitWaiters: Array< () => void > = [];

/** Running `expandAll` calls; while above zero, loads are published in bounded commits (BULK_PUBLISH_ROWS). */
let bulkLoads = 0;
/** A change happened while a bulk load held the publishes back. */
let pendingEmit = false;
/** Rows loaded by the running bulk loads since their last commit. */
let bulkUnpublishedRows = 0;
let bulkCommitScheduled = false;

function inBulkLoad(): boolean {
	return bulkLoads > 0;
}

/**
 * On the next macrotask: the event loop handles the input and paints the
 * frame queued during the previous commit first. A timer, not
 * requestAnimationFrame, which never fires in a background tab.
 */
function afterFrame( callback: () => void ): void {
	setTimeout( callback, 0 );
}

/**
 * A bulk load finished a parent: once BULK_PUBLISH_ROWS rows wait, publish
 * them on the next frame. One commit at a time; what arrives while it is
 * scheduled goes into the same commit.
 */
function noteBulkRows( count: number ): void {
	bulkUnpublishedRows += count;

	if ( bulkUnpublishedRows < BULK_PUBLISH_ROWS || bulkCommitScheduled ) {
		return;
	}

	bulkCommitScheduled = true;
	afterFrame( () => {
		bulkCommitScheduled = false;

		if ( inBulkLoad() && bulkUnpublishedRows > 0 ) {
			bulkUnpublishedRows = 0;
			emit();
		}
	} );
}

function emit(): void {
	if ( emitTimer !== undefined ) {
		clearTimeout( emitTimer );
		emitTimer = undefined;
	}

	pendingEmit = false;

	const waiters = emitWaiters;
	emitWaiters = [];

	for ( const listener of listeners ) {
		listener();
	}

	waiters.forEach( ( resolve ) => resolve() );
}

/**
 * Publish on the next window; resolves once the listeners ran. During a
 * bulk load the change is only noted (the bulk's end publishes) and the
 * promise resolves at once, so a load never waits for a render that will
 * not come before it ends.
 */
function scheduleEmit(): Promise< void > {
	if ( inBulkLoad() ) {
		pendingEmit = true;

		return Promise.resolve();
	}

	return new Promise< void >( ( resolve ) => {
		emitWaiters.push( resolve );

		if ( emitTimer === undefined ) {
			emitTimer = setTimeout( emit, EMIT_WINDOW );
		}
	} );
}

/* Expand-all progress: its own store, so the counter never touches the table. */
let expandAllProgress: ExpandAllProgress | null = null;
const progressListeners = new Set< Listener >();

function setExpandAllProgress( next: ExpandAllProgress | null ): void {
	expandAllProgress = next;
	progressListeners.forEach( ( listener ) => listener() );
}

export function subscribeExpandAllProgress( listener: Listener ): () => void {
	progressListeners.add( listener );

	return () => {
		progressListeners.delete( listener );
	};
}

export function getExpandAllProgress(): ExpandAllProgress | null {
	return expandAllProgress;
}

/** `{done, total}` while an expandAll is loading, else null. */
export function useExpandAllProgress(): ExpandAllProgress | null {
	return useSyncExternalStore( subscribeExpandAllProgress, getExpandAllProgress, getExpandAllProgress );
}

function setChildren( parentId: number, state: ChildrenState, immediate = true ): Promise< void > {
	const next = new Map( children );
	next.set( parentId, state );
	children = next;

	if ( immediate ) {
		emit();

		return Promise.resolve();
	}

	return scheduleEmit();
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

				return patch ? ( normalizeVariation( withImageFallback( item, patch, parentId ), parentId ) as VariationRow ) : item;
			} ),
		} );
	}

	if ( changed ) {
		children = next;
		emit();
	}
}

/**
 * Merge a patch into a variation row without blanking its thumbnail. Write
 * responses are serialised in the edit context, where a variation without an
 * image of its own has `image: null` (and the client turns that into
 * `images: []`), while reads fall back to the parent's image. So a patch that
 * carries no image shows what a read would: the parent's image when known,
 * else what the row already shows.
 */
function withImageFallback( item: VariationRow, patch: Partial< ProductListItem >, parentId: number ): RawVariation {
	const merged = { ...item, ...patch } as RawVariation & { images?: RawImage[] };
	const touchesImage = 'image' in patch || 'images' in patch;
	const patchImages = ( patch as { images?: RawImage[] } ).images;
	const hasOwn = Boolean( ( patch as { image?: RawImage | null } ).image ) || ( Array.isArray( patchImages ) && patchImages.length > 0 );

	if ( touchesImage && ! hasOwn ) {
		const fallback = parentImages.get( parentId );
		merged.image = null;
		merged.images = fallback ? [ fallback ] : ( ( item as { images?: RawImage[] } ).images ?? [] );
	}

	return merged;
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

/**
 * Mark loaded variations stale (all, or of the given parents): their rows
 * stay on screen (status 'idle' with the old items) and expanded parents
 * refetch on the next render, replacing them when the new rows arrive. A
 * refetch never removes a row from under an open quick edit.
 */
export function invalidateVariations( parentIds?: number[] ): void {
	const ids = parentIds ?? Array.from( children.keys() );

	if ( ! parentIds ) {
		abortLoads();
		idCache.clear();
	}

	const next = new Map( children );

	for ( const id of ids ) {
		abortLoad( id );
		idCache.delete( id );

		const state = next.get( id );

		if ( state && state.items.length > 0 ) {
			next.set( id, { status: 'idle', items: state.items, total: state.total } );
		} else {
			next.delete( id );
		}
	}

	children = next;
	emit();
}

/** Loaded parents that are neither expanded nor on the page, oldest first, beyond the cap. */
function evict(): void {
	if ( children.size <= MAX_CACHED_PARENTS ) {
		return;
	}

	const next = new Map( children );

	for ( const [ parentId, state ] of children ) {
		if ( next.size <= MAX_CACHED_PARENTS ) {
			break;
		}

		if ( state.status === 'loading' || currentExpanded.has( parentId ) || currentParents.has( parentId ) ) {
			continue;
		}

		next.delete( parentId );
	}

	if ( next.size !== children.size ) {
		children = next;
	}
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

export interface LimiterOptions {
	/** Checked when the task reaches the front of the queue: true drops it with an abort error. */
	isCancelled?: () => boolean;
}

export function abortError(): Error {
	const error = new Error( 'Request aborted' );
	error.name = 'AbortError';

	return error;
}

interface Queued {
	start: () => void;
	cancel: () => void;
	isCancelled?: () => boolean;
}

/**
 * At most `concurrency` tasks at once, FIFO. A queued task whose
 * `isCancelled()` says so when its turn comes is rejected without running,
 * so a collapsed parent's remaining pages never take a slot.
 */
export function createLimiter( concurrency: number ) {
	let active = 0;
	const queue: Queued[] = [];

	const dequeue = () => {
		while ( active < concurrency && queue.length ) {
			const entry = queue.shift() as Queued;

			if ( entry.isCancelled?.() ) {
				entry.cancel();
				continue;
			}

			active += 1;
			entry.start();
		}
	};

	const release = () => {
		active -= 1;
		dequeue();
	};

	return function run< T >( task: () => Promise< T >, options: LimiterOptions = {} ): Promise< T > {
		return new Promise< T >( ( resolve, reject ) => {
			queue.push( {
				isCancelled: options.isCancelled,
				cancel: () => reject( abortError() ),
				start: () => {
					let result: Promise< T >;

					try {
						result = task();
					} catch ( error ) {
						release();
						reject( error );

						return;
					}

					result.then(
						( value ) => {
							release();
							resolve( value );
						},
						( error: unknown ) => {
							release();
							reject( error );
						}
					);
				},
			} );
			dequeue();
		} );
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

/** Abort one parent's load, if any; its state goes back to idle so a later expand refetches. */
export function abortLoad( parentId: number ): void {
	const entry = inflight.get( parentId );

	if ( ! entry ) {
		return;
	}

	inflight.delete( parentId );
	entry.controller.abort();
}

export function abortLoads(): void {
	for ( const parentId of Array.from( inflight.keys() ) ) {
		abortLoad( parentId );
	}
}

/** Parents currently loading (tests, the toolbar). */
export function loadingParentIds(): number[] {
	return Array.from( inflight.keys() );
}

/**
 * Load all variations of a parent: page 1 first (it carries the total), then
 * the remaining pages in parallel up to the cap, through the shared limiter.
 * Page 1 is published as soon as it arrives; the rest when complete. Rows
 * are kept in page order whatever order the responses arrive in.
 */
function loadChildren( parent: ProductRow, fields: string[], fetch: FetchVariations, maxChildren: number ): Promise< void > {
	const parentId = parent.id;
	const pending = inflight.get( parentId );

	parentImages.set( parentId, parent.images?.[ 0 ] );

	if ( pending ) {
		return pending.promise;
	}

	const previous = children.get( parentId );

	if ( previous?.status === 'loaded' ) {
		return Promise.resolve();
	}

	const controller = new AbortController();
	const { signal } = controller;
	const entry: Inflight = { controller, promise: Promise.resolve() };
	const isCancelled = () => signal.aborted;

	// The loading marker shows at once for a single expand; during expandAll the expanded ids already show every parent loading.
	void setChildren( parentId, { status: 'loading', items: previous?.items ?? [], total: previous?.total ?? 0 }, ! inBulkLoad() );

	const perPage = VARIATIONS_PER_PAGE;
	const cap = maxChildren > 0 ? maxChildren : Infinity;
	const normalize = ( rows: RawVariation[] ) => rows.map( ( row ) => normalizeVariation( row, parent ) );

	entry.promise = ( async () => {
		try {
			const first = await limit( () => fetch( parentId, 1, { perPage, fields, signal } ), { isCancelled } );
			const pages: VariationRow[][] = [ normalize( first.items ) ];
			const total = first.total || first.items.length;
			const wanted = Math.min( total, cap );
			const lastPage = Math.max( 1, Math.ceil( wanted / perPage ) );

			if ( lastPage > 1 ) {
				// A first load shows page 1 at once; a refetch keeps the
				// stale rows on screen until the whole list is back.
				if ( ! previous?.items.length ) {
					void setChildren( parentId, { status: 'loading', items: pages[ 0 ] ?? [], total }, false );
				}

				await Promise.all(
					Array.from( { length: lastPage - 1 }, ( _, index ) => index + 2 ).map( async ( page ) => {
						const result = await limit( () => fetch( parentId, page, { perPage, fields, signal } ), { isCancelled } );
						pages[ page - 1 ] = normalize( result.items );
					} )
				);
			}

			if ( signal.aborted ) {
				return;
			}

			evict();
			const items = pages.flat();
			await setChildren( parentId, { status: 'loaded', items, total }, false );

			if ( inBulkLoad() ) {
				noteBulkRows( items.length );
			}
		} catch ( error ) {
			if ( signal.aborted || isAbortError( error ) ) {
				// Collapsed or paged away: back to idle, the next expand
				// refetches. A load started since (retry, re-expand) owns the state.
				const current = children.get( parentId );

				if ( ! inflight.has( parentId ) && current?.status === 'loading' ) {
					// Stale rows of a refetch stay; a first load's partial page goes.
					await setChildren( parentId, previous?.items.length ? { status: 'idle', items: previous.items, total: previous.total } : { status: 'idle', items: [], total: 0 }, false );
				}

				return;
			}

			const partial = children.get( parentId );
			await setChildren( parentId, { status: 'error', items: partial?.items ?? [], total: partial?.total ?? 0, error: errorMessage( error ) }, false );
		} finally {
			if ( inflight.get( parentId ) === entry ) {
				inflight.delete( parentId );
			}
		}
	} )();

	inflight.set( parentId, entry );

	return entry.promise;
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
			__( 'This will show about %d rows on one page, which makes the table slow to render and scroll. Continue? (A smaller page size or a filter keeps it fast.)', 'wp-woocommerce-products-list' ),
			rows
		)
	);
}

function sameIds( a: number[], b: number[] ): boolean {
	return a.length === b.length && a.every( ( id, index ) => id === b[ index ] );
}

function childRowsOf( parent: ProductRow, state: ChildrenState | undefined, cap: number ): number {
	const count = state?.status === 'loaded' ? Math.max( state.total, state.items.length ) : parent._childCount;

	return Math.min( count, cap );
}

/**
 * Which of `parents` (in page order) fit on a page of at most `maxRows` rows
 * on top of `baseRows`: the first ones whose variations keep the total under
 * the limit; the first parent that would cross it stops the walk.
 */
export function parentsWithinRows( parents: ProductRow[], baseRows: number, children: ReadonlyMap< number, ChildrenState >, maxChildren: number, maxRows: number ): { fit: ProductRow[]; rows: number } {
	const cap = maxChildren > 0 ? maxChildren : Infinity;
	const fit: ProductRow[] = [];
	let rows = baseRows;

	for ( const parent of parents ) {
		if ( ! parent._hasChildren ) {
			continue;
		}

		const added = childRowsOf( parent, children.get( parent.id ), cap );

		if ( rows + added > maxRows ) {
			break;
		}

		rows += added;
		fit.push( parent );
	}

	return { fit, rows };
}

/**
 * `expanded` trimmed so the page stays within `maxRows`: ids not on the page
 * are kept (they belong to other pages), ids on the page are kept in page
 * order while they fit. Order of the result follows `expanded`.
 */
export function boundExpanded( expanded: number[], parents: ProductRow[], children: ReadonlyMap< number, ChildrenState >, maxChildren: number, maxRows: number ): number[] {
	const expandedSet = new Set( expanded );
	const onPage = parents.filter( ( parent ) => expandedSet.has( parent.id ) );

	if ( ! onPage.length ) {
		return expanded;
	}

	const { fit } = parentsWithinRows( onPage, parents.length, children, maxChildren, maxRows );
	const keep = new Set( fit.map( ( parent ) => parent.id ) );
	const pageIds = new Set( parents.map( ( parent ) => parent.id ) );
	const next = expanded.filter( ( id ) => ! pageIds.has( id ) || keep.has( id ) );

	return next.length === expanded.length ? expanded : next;
}

function defaultOnExpandAllLimit( { expanded, skipped, rows }: ExpandAllLimit ): void {
	notify.info(
		sprintf(
			/* translators: 1: number of products expanded, 2: number left collapsed, 3: number of rows on the page */
			_n(
				'Expanded %1$d product; %2$d more left collapsed so the page stays under %3$d rows. Use a smaller page size or a filter to see the rest.',
				'Expanded %1$d products; %2$d more left collapsed so the page stays under %3$d rows. Use a smaller page size or a filter to see the rest.',
				expanded,
				'wp-woocommerce-products-list'
			),
			expanded,
			skipped,
			rows
		)
	);
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
	const onExpandAllLimit = options.onExpandAllLimit ?? defaultOnExpandAllLimit;
	const storage = options.storage === undefined ? defaultStorage() : options.storage;

	const [ expandedItemIds, setExpandedState ] = useState< number[] >( () => readExpanded( storage ) );
	// Ids read from storage are bounded harder (EXPAND_ALL_WARN_ROWS) when the first page arrives: a reload must not rebuild a table nobody asked for.
	const restoringRef = useRef( expandedItemIds.length > 0 );
	const pageKey = useMemo( () => parents.map( ( parent ) => parent.id ).join( ',' ), [ parents ] );
	const boundedPageRef = useRef( '' );
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
		currentExpanded = expandedSet;
		currentParents = new Set( parentsById.keys() );
	} );

	// Loads for parents that left the page are wasted work and would queue
	// the new page's expansions behind them: abort them. Unmounting aborts
	// everything.
	useEffect( () => {
		for ( const parentId of loadingParentIds() ) {
			if ( ! parentsById.has( parentId ) ) {
				abortLoad( parentId );
			}
		}
	}, [ parentsById ] );

	useEffect( () => () => abortLoads(), [] );

	const setExpanded = useCallback(
		( ids: number[] ) => {
			const unique = Array.from( new Set( ids.filter( ( id ) => Number.isInteger( id ) && id > 0 ) ) );
			const current = latestRef.current.expandedItemIds;

			// Collapsed while loading: stop the request.
			for ( const id of current ) {
				if ( ! unique.includes( id ) ) {
					abortLoad( id );
				}
			}

			setExpandedState( ( state ) => ( sameIds( state, unique ) ? state : unique ) );
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
	// A new page (new set of parent ids) is first bounded to the row limit,
	// so a restored or revisited expansion never loads what it will not show.
	useEffect( () => {
		if ( parents.length && boundedPageRef.current !== pageKey ) {
			boundedPageRef.current = pageKey;
			const limit = restoringRef.current ? EXPAND_ALL_WARN_ROWS : EXPAND_ALL_MAX_ROWS;
			restoringRef.current = false;
			const bounded = boundExpanded( expandedItemIds, parents, children, maxChildren, limit );

			if ( ! sameIds( bounded, expandedItemIds ) ) {
				setExpanded( bounded );

				return;
			}
		}

		for ( const id of expandedItemIds ) {
			const parent = parentsById.get( id );
			const state = children.get( id );

			if ( parent?._hasChildren && ( ! state || state.status === 'idle' ) ) {
				void load( id );
			}
		}
	}, [ expandedItemIds, parentsById, childrenState, load, pageKey, parents, maxChildren, setExpanded ] );

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

			// In page order, as many as keep the page under the hard limit.
			const { fit, rows: projected } = parentsWithinRows( missing, rows.length, children, maxChildren, EXPAND_ALL_MAX_ROWS );
			const skipped = missing.length - fit.length;

			if ( ! fit.length ) {
				onExpandAllLimit( { expanded: 0, skipped, rows: rows.length } );

				return false;
			}

			if ( ! force && projected > EXPAND_ALL_WARN_ROWS && ! ( await confirmExpandAll( projected ) ) ) {
				return false;
			}

			bulkLoads += 1;
			let done = 0;
			const total = fit.length;
			setExpandAllProgress( { done, total } );

			try {
				// One render now (every parent gets its loading row), then one per BULK_PUBLISH_ROWS loaded rows, one when all are in.
				setExpanded( [ ...current, ...fit.map( ( parent ) => parent.id ) ] );
				await Promise.all(
					fit.map( ( parent ) =>
						load( parent.id ).then( () => {
							done += 1;
							setExpandAllProgress( { done, total } );
						} )
					)
				);
			} finally {
				bulkLoads -= 1;

				if ( ! inBulkLoad() ) {
					bulkUnpublishedRows = 0;
					setExpandAllProgress( null );

					if ( pendingEmit ) {
						emit();
					}
				}
			}

			if ( skipped > 0 ) {
				onExpandAllLimit( { expanded: fit.length, skipped, rows: projected } );
			}

			return true;
		},
		[ parents, rows.length, maxChildren, confirmExpandAll, onExpandAllLimit, setExpanded, load ]
	);

	const collapseAll = useCallback( () => setExpanded( [] ), [ setExpanded ] );

	const childrenOf = useCallback( ( parentId: number ) => childrenState.get( parentId ), [ childrenState ] );

	const variationIdsOf = useCallback( async ( parentIds: number[] ): Promise< number[] > => {
		const lists = await Promise.all( parentIds.map( ( id ) => loadVariationIds( id, latestRef.current.fetch ) ) );

		return lists.flat();
	}, [] );

	const selectVariations = useCallback(
		async ( parentId: number, current: string[] = [], where?: ( item: VariationRow ) => boolean ): Promise< string[] > => {
			await expand( parentId );

			const state = children.get( parentId );
			const matching = ( state?.items ?? [] ).filter( ( item ) => ! where || where( item ) );
			const ids = matching.map( ( item ) => getItemId( item ) );
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
	abortLoads();
	bulkLoads = 0;
	pendingEmit = false;
	bulkUnpublishedRows = 0;
	bulkCommitScheduled = false;
	expandAllProgress = null;
	children = new Map();
	inflight.clear();
	idCache.clear();
	parentImages.clear();
	currentExpanded = new Set();
	currentParents = new Set();
	emit();
}
