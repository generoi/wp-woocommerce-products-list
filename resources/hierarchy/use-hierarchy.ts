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
 * Loading goes through one limiter: at most MAX_CONCURRENT_REQUESTS
 * requests in flight for the whole hierarchy (expand all, variationIdsOf
 * and single expands share it). Several parents at once (expand all, a
 * restored expansion, "Select all variations", variationIdsOf) are read
 * across parents, `GET wc-products-list/v1/variations?parent=1,2,3`: one
 * request per 100 variations instead of one or more per parent (51
 * requests for an expanded 100-row page before). A server without that
 * route falls back to one request per parent.
 *
 * Speed rules (the table re-renders every row on every store change):
 * - load progress is published through one coalesced emit per short window,
 *   so a parent whose pages trickle in produces a few renders, not one per
 *   response; user gestures (expand, collapse, patches) emit at once;
 * - "expand all" publishes in bounded commits (about BULK_PUBLISH_ROWS rows
 *   each, one per macrotask), never one render of the whole page at the
 *   end, and never a commit large enough to keep the limiter's slots idle;
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
import { getVariations, getVariationsAcross } from '../api/client';
import { isAbortError } from '../api/errors';
import { getSettings } from '../settings';
import { notify } from '../actions/notices';
import { ACTIONS } from '../extensions/hooks';
import { getItemId } from '../types/product';
import type { BatchResult, ProductField, QueryParams } from '../types/extension';
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
export const EXPAND_ALL_WARN_ROWS = 400;

/**
 * Rows a page never grows beyond through expandAll or a restored expansion:
 * a 2,500-row table froze the renderer for most of a minute, and at 1,470
 * rows "select all" took ~2 s of synchronous work (development React) and a
 * single checkbox 0.25-0.5 s, more than a minute on a loaded machine. Every
 * selection or collapse re-renders each row, so the cap keeps those under
 * a second until rows are virtualised. expandAll stops
 * at the parent that would cross it (the rest stay collapsed, with a notice);
 * expanded ids restored from storage or revisited on a later page are trimmed
 * to it in page order (to EXPAND_ALL_WARN_ROWS when restored on load, where
 * nobody asked for a large table).
 */
export const EXPAND_ALL_MAX_ROWS = 600;

export const VARIATIONS_PER_PAGE = 100;

export const MAX_CONCURRENT_REQUESTS = 6;

/** Loaded parents kept beyond the expanded ones and the current page. */
export const MAX_CACHED_PARENTS = 60;

/** Responses arriving within this window share one render (ms). */
export const EMIT_WINDOW = 40;

/**
 * While a bulk load runs (expand all, expand next, a restored expansion),
 * loaded parents are committed in slices of about this many rows, one slice
 * per macrotask, instead of once at the end: a single commit of a
 * 1,000-row table blocks the renderer for seconds, and 150-row commits
 * measured 200-620 ms long tasks on a 600-row page, long enough to leave
 * the request limiter idle (requests start between commits). 50 new rows
 * on top of memoised ones keep each task well under 200 ms. A parent is
 * never split: one with more rows is a slice of its own. Per-parent
 * loading markers are not published (the expanded ids already show every
 * parent as loading). Progress goes through its own tiny store
 * (`useExpandAllProgress`), read by a component outside the table, so the
 * counter never re-renders a row.
 */
export const BULK_PUBLISH_ROWS = 50;

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
	options: { perPage: number; fields: string[]; signal?: AbortSignal; params?: QueryParams }
) => Promise< VariationsResult >;

/**
 * One page of the variations of several parents (api/client.ts
 * `getVariationsAcross`): grouped parent by parent, each row naming its
 * parent (`parent_id` or `_parentId`), `total` counting them all. Null when
 * the server has no cross-parent route.
 */
export type FetchVariationsAcross = (
	parentIds: number[],
	page: number,
	options: { perPage: number; fields: string[]; signal?: AbortSignal }
) => Promise< VariationsResult | null >;

/** Parents per cross-parent request (the route's limit). */
export const ACROSS_MAX_PARENTS = 100;

/** The variations-endpoint params of the list's variation-level filters (api/query.ts `variationFilterParams`). */
export interface VariationFilterSpec {
	key: string;
	params: QueryParams;
}

export interface ExpandAllLimit {
	/** Parents expanded by this call. */
	expanded: number;
	/** Parents left collapsed because the page would pass EXPAND_ALL_MAX_ROWS. */
	skipped: number;
	/** Rows on the page after the call. */
	rows: number;
}

/** What an expandAll is about to do: told to the confirm so it can say how many products stay collapsed. */
export interface ExpandAllPlan {
	/** Parents this call would expand. */
	expanding: number;
	/** Parents it would leave collapsed to stay under EXPAND_ALL_MAX_ROWS. */
	skipped: number;
	/** Rows on the page afterwards. */
	rows: number;
	/** The page's row limit (EXPAND_ALL_MAX_ROWS). */
	maxRows: number;
}

/**
 * The confirm text of an expandAll: the row count, and when some products
 * will stay collapsed, how many of how many get expanded.
 */
export function expandAllConfirmMessage( plan: Pick< ExpandAllPlan, 'expanding' | 'skipped' | 'rows' > & { maxRows?: number } ): string {
	if ( plan.skipped > 0 ) {
		return sprintf(
			/* translators: 1: products that get expanded, 2: expandable products on the page, 3: rows on the page afterwards, 4: products left collapsed, 5: row limit */
			_n(
				'Expands %1$d of %2$d products (about %3$d rows on one page); %4$d stays collapsed so the page stays under %5$d rows. Large tables are slow to render and scroll; a smaller page size or a filter keeps it fast. Continue?',
				'Expands %1$d of %2$d products (about %3$d rows on one page); %4$d stay collapsed so the page stays under %5$d rows. Large tables are slow to render and scroll; a smaller page size or a filter keeps it fast. Continue?',
				plan.skipped,
				'wp-woocommerce-products-list'
			),
			plan.expanding,
			plan.expanding + plan.skipped,
			plan.rows,
			plan.skipped,
			plan.maxRows ?? EXPAND_ALL_MAX_ROWS
		);
	}

	return sprintf(
		/* translators: 1: number of products, 2: number of rows */
		_n(
			'Expands %1$d product (about %2$d rows on one page), which makes the table slow to render and scroll. Continue? (A smaller page size or a filter keeps it fast.)',
			'Expands %1$d products (about %2$d rows on one page), which makes the table slow to render and scroll. Continue? (A smaller page size or a filter keeps it fast.)',
			plan.expanding,
			'wp-woocommerce-products-list'
		),
		plan.expanding,
		plan.rows
	);
}

/**
 * The page's expansion at a glance, for the toolbar: how many of its
 * variable products are open. Null when there is nothing to expand.
 */
export function expansionSummary( parents: ProductRow[], expandedIds: readonly number[] ): { expanded: number; total: number } | null {
	const expanded = new Set( expandedIds );
	let total = 0;
	let open = 0;

	for ( const parent of parents ) {
		if ( ! parent._hasChildren ) {
			continue;
		}

		total += 1;

		if ( expanded.has( parent.id ) ) {
			open += 1;
		}
	}

	return total > 0 ? { expanded: open, total } : null;
}

export interface HierarchyOptions {
	/** Defaults to `api/client` `getVariations`; tests inject a stub. */
	fetchVariations?: FetchVariations;
	/**
	 * Several parents in one request; defaults to `api/client`
	 * `getVariationsAcross`, or to none (one request per parent) when a test
	 * injects `fetchVariations` alone. Null turns it off.
	 */
	fetchVariationsAcross?: FetchVariationsAcross | null;
	/** Defaults to `limits.maxChildrenPerParent`. */
	maxChildren?: number;
	/**
	 * Asked before expandAll adds more than EXPAND_ALL_WARN_ROWS rows, or
	 * leaves products collapsed; defaults to window.confirm with
	 * `expandAllConfirmMessage`.
	 */
	confirmExpandAll?: ( rows: number, plan: ExpandAllPlan ) => boolean | Promise< boolean >;
	/** Called when expandAll left parents collapsed to stay under EXPAND_ALL_MAX_ROWS; defaults to an info notice. */
	onExpandAllLimit?: ( limit: ExpandAllLimit ) => void;
	/** Defaults to window.sessionStorage. */
	storage?: Pick< Storage, 'getItem' | 'setItem' > | null;
	/**
	 * Narrow every expanded parent to the variations the list is filtered
	 * for ("Colour: Black", "Any variation: Out of stock"). A new key reloads
	 * the expanded parents; `showAllVariations` lifts it for one parent.
	 */
	variationFilter?: VariationFilterSpec;
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
	/**
	 * After Expand all stopped at the row limit: the next variable products
	 * of the page, in page order after the last expanded one. They are added
	 * when they fit; when the page is full, the ones expanded now collapse
	 * first (their selected variations stay selected). (Optional: facades
	 * over the hierarchy may leave it out.)
	 */
	expandNext?(): Promise< boolean >;
	/** What `expandNext` would do now, or null when every variable product of the page is expanded or none is. */
	nextExpand?: NextExpandPlan | null;
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
	selectVariations( parentId: number | number[], current?: string[], where?: ( item: VariationRow ) => boolean ): Promise< string[] >;
	/** Whether a variation-level filter narrows the expanded parents. (Optional: facades over the hierarchy may leave it out.) */
	variationFilterActive?: boolean;
	/** List every variation of one parent despite the variation-level filter ("Show all"). */
	showAllVariations?( parentId: number ): void;
	/** Narrow one parent again after `showAllVariations` ("Only matching"). */
	showMatchingVariations?( parentId: number ): void;
}

/** What `expandNext` is about to do: `count` products open, `replaces` expanded ones collapse first (0: they stay). */
export interface NextExpandPlan {
	count: number;
	replaces: number;
}

export const getItemParentId = ( item: ProductListItem ): number | null => item._parentId;
export const getItemHasChildren = ( item: ProductListItem ): boolean => item._hasChildren;
export const getItemLevel = ( item: ProductListItem ): number => item._level;

/* ------------------------------------------------------------------------ */
/* Children store                                                            */
/* ------------------------------------------------------------------------ */

type Listener = () => void;

type RowPatch = Partial< ProductListItem > & { id: number };

/** A change made to a parent's rows while its load ran: replayed on the rows the load brings back. */
type PendingChange = { patches: Map< number, RowPatch > } | { removed: Set< number > };

interface Inflight {
	promise: Promise< void >;
	controller: AbortController;
	/** Patches and removals that arrived while this load was in flight, in order. */
	pending: PendingChange[];
}

let children: Map< number, ChildrenState > = new Map();
/** The variation-level filter every load applies, and the parents the user asked to see whole. */
let narrowing: VariationFilterSpec = { key: '', params: {} };
const showAllParents = new Set< number >();
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

/** Running bulk loads (expandAll, expandNext); while above zero, loaded parents are committed in slices (BULK_PUBLISH_ROWS). */
let bulkLoads = 0;
/** A change happened while a bulk load held the publishes back. */
let pendingEmit = false;
/** Loaded parents waiting for their slice, oldest first: `apply` puts one in the store and returns its row count. */
let staged: Array< { apply: () => number; resolve: () => void } > = [];
let pumpScheduled = false;

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
 * A bulk load finished a parent: queue it for the next slice. Resolves
 * once its rows are in the store and published. Slices go out one per
 * macrotask, so the requests the limiter starts in between are not held
 * up by one long render.
 */
function stageCommit( apply: () => number ): Promise< void > {
	return new Promise< void >( ( resolve ) => {
		staged.push( { apply, resolve } );
		schedulePump();
	} );
}

function schedulePump(): void {
	if ( pumpScheduled ) {
		return;
	}

	pumpScheduled = true;
	afterFrame( pump );
}

function pump(): void {
	pumpScheduled = false;

	const done: Array< () => void > = [];
	let rows = 0;

	while ( staged.length && ( done.length === 0 || rows < BULK_PUBLISH_ROWS ) ) {
		const next = staged.shift() as ( typeof staged )[ number ];
		rows += next.apply();
		done.push( next.resolve );

		if ( rows >= BULK_PUBLISH_ROWS ) {
			break;
		}
	}

	if ( done.length ) {
		emit();
	}

	done.forEach( ( resolve ) => resolve() );

	if ( staged.length ) {
		schedulePump();
	}
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

/** Put one parent's state in the store without publishing it. */
function putChildren( parentId: number, state: ChildrenState ): void {
	const next = new Map( children );
	next.set( parentId, state );
	children = next;
}

function setChildren( parentId: number, state: ChildrenState, immediate = true ): Promise< void > {
	putChildren( parentId, state );

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
export function patchVariationRows( items: RowPatch[] ): void {
	if ( ! items.length ) {
		return;
	}

	const byId = new Map( items.map( ( item ) => [ item.id, item ] ) );

	// A load in flight brings back rows read before this patch: replay it on them.
	for ( const entry of inflight.values() ) {
		entry.pending.push( { patches: byId } );
	}

	if ( ! children.size ) {
		return;
	}

	let changed = false;
	const next = new Map( children );

	for ( const [ parentId, state ] of children ) {
		if ( ! state.items.some( ( item ) => byId.has( item.id ) ) ) {
			continue;
		}

		const items = applyPatches( state.items, byId, parentId );

		if ( items === state.items ) {
			continue;
		}

		changed = true;
		next.set( parentId, { ...state, items } );
	}

	if ( changed ) {
		children = next;
		emit();
	}
}

/**
 * Whether merging `patch` would leave `item` as it is: every key already
 * holds the same value (by identity). A save hands the same rows to
 * patchItems and again through the `saved` action; the second merge must
 * not give every saved row a new object (and a re-render) for nothing.
 */
export function isNoopPatch( item: ProductListItem, patch: RowPatch ): boolean {
	for ( const key of Object.keys( patch ) ) {
		if ( ! Object.is( ( item as Record< string, unknown > )[ key ], ( patch as Record< string, unknown > )[ key ] ) ) {
			return false;
		}
	}

	return true;
}

/** The rows with the patches merged; the same array when none changed a row. */
function applyPatches( items: VariationRow[], byId: ReadonlyMap< number, RowPatch >, parentId: number ): VariationRow[] {
	let changed = false;
	const next = items.map( ( item ) => {
		const patch = byId.get( item.id );

		if ( ! patch || isNoopPatch( item, patch ) ) {
			return item;
		}

		changed = true;

		return normalizeVariation( withImageFallback( item, patch, parentId ), parentId ) as VariationRow;
	} );

	return changed ? next : items;
}

/** `items` with the changes made while their load ran, in the order they were made. */
function replayPending( items: VariationRow[], pending: readonly PendingChange[], parentId: number ): VariationRow[] {
	let result = items;

	for ( const change of pending ) {
		if ( 'patches' in change ) {
			if ( result.some( ( item ) => change.patches.has( item.id ) ) ) {
				result = applyPatches( result, change.patches, parentId );
			}
		} else {
			result = result.filter( ( item ) => ! change.removed.has( item.id ) );
		}
	}

	return result;
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
	if ( ! ids.length || ( ! children.size && ! inflight.size ) ) {
		return;
	}

	const gone = new Set( ids );

	for ( const entry of inflight.values() ) {
		entry.pending.push( { removed: gone } );
	}

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

/**
 * Apply a variation-level filter to every load from now on. A different
 * filter makes the loaded variations stale (the expanded parents refetch,
 * their old rows stay until the new ones arrive) and forgets the parents
 * the user opened up with "Show all".
 */
export function setVariationFilter( spec: VariationFilterSpec ): void {
	if ( spec.key === narrowing.key ) {
		return;
	}

	narrowing = { key: spec.key, params: spec.key ? spec.params : {} };
	showAllParents.clear();

	if ( children.size ) {
		invalidateVariations();
	}
}

/** The variation-level filter in force (tests, the toolbar). */
export function getVariationFilter(): VariationFilterSpec {
	return narrowing;
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
	const entry: Inflight = { controller, promise: Promise.resolve(), pending: [] };
	const isCancelled = () => signal.aborted;

	// The loading marker shows at once for a single expand; during expandAll the expanded ids already show every parent loading.
	void setChildren( parentId, { status: 'loading', items: previous?.items ?? [], total: previous?.total ?? 0 }, ! inBulkLoad() );

	const perPage = VARIATIONS_PER_PAGE;
	const cap = maxChildren > 0 ? maxChildren : Infinity;
	const normalize = ( rows: RawVariation[] ) => rows.map( ( row ) => normalizeVariation( row, parent ) );
	const params = narrowing.key && ! showAllParents.has( parentId ) ? narrowing.params : undefined;
	const filtered = params !== undefined;
	const request = ( page: number ) => fetch( parentId, page, params ? { perPage, fields, signal, params } : { perPage, fields, signal } );

	entry.promise = ( async () => {
		try {
			const first = await limit( () => request( 1 ), { isCancelled } );
			const pages: VariationRow[][] = [ normalize( first.items ) ];
			const total = first.total || first.items.length;
			const wanted = Math.min( total, cap );
			const lastPage = Math.max( 1, Math.ceil( wanted / perPage ) );

			if ( lastPage > 1 ) {
				// A first load shows page 1 at once; a refetch keeps the
				// stale rows on screen until the whole list is back.
				if ( ! previous?.items.length ) {
					void setChildren( parentId, { status: 'loading', items: replayPending( pages[ 0 ] ?? [], entry.pending, parentId ), total }, false );
				}

				await Promise.all(
					Array.from( { length: lastPage - 1 }, ( _, index ) => index + 2 ).map( async ( page ) => {
						const result = await limit( () => request( page ), { isCancelled } );
						pages[ page - 1 ] = normalize( result.items );
					} )
				);
			}

			if ( signal.aborted ) {
				return;
			}

			const fetched = pages.flat();
			// Saves, optimistic patches and deletions made while the pages were on their way win over what the pages say.
			const commit = (): number => {
				if ( signal.aborted ) {
					return 0;
				}

				evict();
				const items = replayPending( fetched, entry.pending, parentId );
				const dropped = fetched.length - items.length;
				entry.pending = [];
				const loadedTotal = Math.max( 0, total - dropped );
				putChildren( parentId, filtered ? { status: 'loaded', items, total: loadedTotal, filtered } : { status: 'loaded', items, total: loadedTotal } );

				return items.length;
			};

			if ( inBulkLoad() ) {
				await stageCommit( commit );

				if ( signal.aborted ) {
					await resetAborted( parentId, previous );
				}
			} else {
				commit();
				await scheduleEmit();
			}
		} catch ( error ) {
			if ( signal.aborted || isAbortError( error ) ) {
				await resetAborted( parentId, previous );

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

/**
 * Collapsed or paged away: back to idle, the next expand refetches. A load
 * started since (retry, re-expand) owns the state. Stale rows of a refetch
 * stay; a first load's partial page goes.
 */
async function resetAborted( parentId: number, previous: ChildrenState | undefined ): Promise< void > {
	const current = children.get( parentId );

	if ( ! inflight.has( parentId ) && current?.status === 'loading' ) {
		await setChildren( parentId, previous?.items.length ? { status: 'idle', items: previous.items, total: previous.total } : { status: 'idle', items: [], total: 0 }, false );
	}
}

/** The parent a fetched variation names: normalised rows carry `_parentId`, raw ones `parent_id`. */
function parentIdOf( row: RawVariation ): number {
	const normalised = ( row as { _parentId?: unknown } )._parentId;
	const own = ( row as { parent_id?: unknown } ).parent_id;
	const enriched = ( row as { wc_products_list?: { parent_id?: unknown } } ).wc_products_list?.parent_id;

	return Number( normalised ?? own ?? enriched ?? 0 ) || 0;
}

function chunked< T >( list: T[], size: number ): T[][] {
	const out: T[][] = [];

	for ( let index = 0; index < list.length; index += size ) {
		out.push( list.slice( index, index + size ) );
	}

	return out;
}

interface AcrossLoad {
	entry: Inflight;
	previous: ChildrenState | undefined;
	resolve: () => void;
}

/**
 * Load the variations of several parents through the cross-parent route:
 * page 1 of every 100 parents first (it carries the total), then the other
 * pages side by side through the shared limiter. The rows come grouped by
 * parent, so a parent is complete as soon as a later parent's rows follow
 * it in the pages received so far (in page order); it is published then,
 * not when every page is in. Each parent keeps its own in-flight entry:
 * collapsing one drops its rows (the shared requests run on for the
 * others) and collapsing them all aborts the requests. Parents under a
 * variation-level filter, already loaded or loading, go through
 * `single` (one request per parent), as does everything when the server
 * has no cross-parent route.
 *
 * @return One promise per parent, in `parents` order: resolved once that parent's rows are published (or failed).
 */
function loadChildrenAcross( parents: ProductRow[], fields: string[], fetchAcross: FetchVariationsAcross, single: ( parent: ProductRow ) => Promise< void >, maxChildren: number ): Promise< void >[] {
	const group: ProductRow[] = [];

	for ( const parent of parents ) {
		const narrowed = narrowing.key !== '' && ! showAllParents.has( parent.id );

		if ( parent._hasChildren && ! narrowed && ! inflight.has( parent.id ) && children.get( parent.id )?.status !== 'loaded' ) {
			group.push( parent );
		}
	}

	if ( group.length < 2 ) {
		return parents.map( single );
	}

	const grouped = new Set( group.map( ( parent ) => parent.id ) );
	const shared = new AbortController();
	const loads = new Map< number, AcrossLoad >();
	const promises = new Map< number, Promise< void > >();
	let open = group.length;

	for ( const parent of group ) {
		parentImages.set( parent.id, parent.images?.[ 0 ] );

		const controller = new AbortController();
		let resolve: () => void = () => {};
		const promise = new Promise< void >( ( done ) => {
			resolve = done;
		} );
		const entry: Inflight = { controller, promise, pending: [] };
		const previous = children.get( parent.id );

		controller.signal.addEventListener(
			'abort',
			() => {
				open -= 1;

				if ( open === 0 ) {
					shared.abort();
				}
			},
			{ once: true }
		);
		inflight.set( parent.id, entry );
		loads.set( parent.id, { entry, previous, resolve } );
		promises.set( parent.id, promise );
		putChildren( parent.id, { status: 'loading', items: previous?.items ?? [], total: previous?.total ?? 0 } );
	}

	// The loading rows show at once; during a bulk load the expanded ids already show every parent loading.
	if ( inBulkLoad() ) {
		pendingEmit = true;
	} else {
		emit();
	}

	const cap = maxChildren > 0 ? maxChildren : Infinity;
	const byId = new Map( group.map( ( parent ) => [ parent.id, parent ] ) );

	const finish = async ( parentId: number, rows: VariationRow[] | null, error?: unknown ): Promise< void > => {
		const load = loads.get( parentId );

		if ( ! load ) {
			return;
		}

		loads.delete( parentId );

		const { entry, previous, resolve } = load;
		const { signal } = entry.controller;

		try {
			if ( signal.aborted ) {
				await resetAborted( parentId, previous );

				return;
			}

			if ( rows === null ) {
				const partial = children.get( parentId );
				await setChildren( parentId, { status: 'error', items: partial?.items ?? [], total: partial?.total ?? 0, error: errorMessage( error ) }, false );

				return;
			}

			const commit = (): number => {
				if ( signal.aborted ) {
					return 0;
				}

				evict();
				const items = replayPending( rows, entry.pending, parentId );
				entry.pending = [];
				const shown = items.length > cap ? items.slice( 0, cap ) : items;
				putChildren( parentId, { status: 'loaded', items: shown, total: items.length } );

				return shown.length;
			};

			if ( inBulkLoad() ) {
				await stageCommit( commit );
			} else {
				commit();
				await scheduleEmit();
			}

			if ( signal.aborted ) {
				await resetAborted( parentId, previous );
			}
		} finally {
			if ( inflight.get( parentId ) === entry ) {
				inflight.delete( parentId );
			}

			resolve();
		}
	};

	// No such route: the parents not finished go one by one.
	const fallBack = ( ids: number[] ) => {
		for ( const id of ids ) {
			const load = loads.get( id );
			const parent = byId.get( id );

			if ( ! load || ! parent ) {
				continue;
			}

			loads.delete( id );

			if ( inflight.get( id ) === load.entry ) {
				inflight.delete( id );
			}

			if ( load.entry.controller.signal.aborted ) {
				void resetAborted( id, load.previous ).finally( load.resolve );
				continue;
			}

			// Back to what it was, so the single load starts from the same state.
			putChildren( id, load.previous ?? { status: 'idle', items: [], total: 0 } );
			single( parent ).finally( load.resolve );
		}
	};

	const perPage = VARIATIONS_PER_PAGE;
	const isCancelled = () => shared.signal.aborted;

	for ( const part of chunked( group, ACROSS_MAX_PARENTS ) ) {
		const ids = part.map( ( parent ) => parent.id );
		const inPart = new Set( ids );
		const request = ( page: number ) => limit( () => fetchAcross( ids, page, { perPage, fields, signal: shared.signal } ), { isCancelled } );
		const pages: Array< RawVariation[] | undefined > = [];
		const rowsOf = new Map< number, VariationRow[] >();
		let received = 0;
		let current: number | null = null;

		// Walk the pages received in order; a parent ends where the next one starts.
		const advance = () => {
			while ( pages[ received ] ) {
				for ( const raw of pages[ received ] as RawVariation[] ) {
					const parentId = parentIdOf( raw );
					const parent = byId.get( parentId );

					if ( ! parent || ! inPart.has( parentId ) ) {
						continue;
					}

					if ( current !== null && current !== parentId ) {
						void finish( current, rowsOf.get( current ) ?? [] );
					}

					current = parentId;
					const list = rowsOf.get( parentId ) ?? [];
					list.push( normalizeVariation( raw, parent ) as VariationRow );
					rowsOf.set( parentId, list );
				}

				received += 1;
			}
		};

		void ( async () => {
			try {
				const first = await request( 1 );

				if ( first === null ) {
					fallBack( ids );

					return;
				}

				pages[ 0 ] = first.items;
				advance();

				const lastPage = Math.max( 1, first.totalPages || Math.ceil( first.total / perPage ) );

				await Promise.all(
					Array.from( { length: lastPage - 1 }, ( _, index ) => index + 2 ).map( async ( page ) => {
						const result = await request( page );

						if ( result === null ) {
							throw new Error( __( 'The variations could not be loaded.', 'wp-woocommerce-products-list' ) );
						}

						pages[ page - 1 ] = result.items;
						advance();
					} )
				);

				// Every page is in: the rest are complete, parents without variations included.
				for ( const id of ids ) {
					void finish( id, rowsOf.get( id ) ?? [] );
				}
			} catch ( error ) {
				for ( const id of ids ) {
					void finish( id, null, error );
				}
			}
		} )();
	}

	return parents.map( ( parent ) => ( grouped.has( parent.id ) ? ( promises.get( parent.id ) as Promise< void > ) : single( parent ) ) );
}

/**
 * The variation ids of several parents through the cross-parent route
 * (`_fields=id,parent_id`), into the id cache. Parents the route did not
 * cover (no such route) are left to `loadVariationIds`.
 */
async function loadVariationIdsAcross( parentIds: number[], fetchAcross: FetchVariationsAcross ): Promise< void > {
	const perPage = VARIATIONS_PER_PAGE;
	const fields = [ 'id', 'parent_id' ];

	await Promise.all(
		chunked( parentIds, ACROSS_MAX_PARENTS ).map( async ( ids ) => {
			const first = await limit( () => fetchAcross( ids, 1, { perPage, fields } ) );

			if ( first === null ) {
				return;
			}

			const pages: RawVariation[][] = [ first.items ];
			const lastPage = Math.max( 1, first.totalPages || Math.ceil( first.total / perPage ) );

			await Promise.all(
				Array.from( { length: lastPage - 1 }, ( _, index ) => index + 2 ).map( async ( page ) => {
					const result = await limit( () => fetchAcross( ids, page, { perPage, fields } ) );

					if ( result === null ) {
						throw new Error( __( 'The variations could not be loaded.', 'wp-woocommerce-products-list' ) );
					}

					pages[ page - 1 ] = result.items;
				} )
			);

			const byParent = new Map< number, number[] >( ids.map( ( id ) => [ id, [] ] ) );

			for ( const raw of pages.flat() ) {
				byParent.get( parentIdOf( raw ) )?.push( raw.id );
			}

			byParent.forEach( ( list, parentId ) => idCache.set( parentId, list ) );
		} )
	);
}

/** A loaded variation by its DataViews id, wherever its parent is (expanded or not): the selection's lookup for rows it holds without showing them. */
let variationIndex: { source: ReadonlyMap< number, ChildrenState >; byId: Map< string, VariationRow > } | null = null;

export function findLoadedVariation( id: string ): VariationRow | undefined {
	if ( ! variationIndex || variationIndex.source !== children ) {
		const byId = new Map< string, VariationRow >();

		for ( const state of children.values() ) {
			for ( const item of state.items ) {
				byId.set( getItemId( item ), item );
			}
		}

		variationIndex = { source: children, byId };
	}

	return variationIndex.byId.get( id );
}

async function loadVariationIds( parentId: number, fetch: FetchVariations ): Promise< number[] > {
	const loaded = children.get( parentId );

	// Filtered rows are some of the variations; "every variation" asks the server.
	if ( loaded?.status === 'loaded' && ! loaded.filtered && loaded.items.length >= loaded.total ) {
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

function defaultConfirm( _rows: number, plan: ExpandAllPlan ): boolean {
	if ( typeof window === 'undefined' || typeof window.confirm !== 'function' ) {
		return true;
	}

	return window.confirm( expandAllConfirmMessage( plan ) );
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

/**
 * What "Expand next" opens: the collapsed variable products after the last
 * expanded one in page order (then the ones before it), as many as fit
 * under `maxRows`. Added to the open ones when at least one fits on top of
 * them; otherwise the open ones on the page collapse first (`replaces`).
 */
export function nextExpansion(
	parents: ProductRow[],
	expandedIds: readonly number[],
	children: ReadonlyMap< number, ChildrenState >,
	maxChildren: number,
	rowsNow: number,
	maxRows: number = EXPAND_ALL_MAX_ROWS
): { fit: ProductRow[]; replaces: number; rows: number } {
	const expanded = new Set( expandedIds );
	const expandable = parents.filter( ( parent ) => parent._hasChildren );
	let last = -1;

	expandable.forEach( ( parent, index ) => {
		if ( expanded.has( parent.id ) ) {
			last = index;
		}
	} );

	const collapsed = expandable.filter( ( parent ) => ! expanded.has( parent.id ) );

	if ( ! collapsed.length ) {
		return { fit: [], replaces: 0, rows: rowsNow };
	}

	const after = expandable.slice( last + 1 ).filter( ( parent ) => ! expanded.has( parent.id ) );
	const before = expandable.slice( 0, last + 1 ).filter( ( parent ) => ! expanded.has( parent.id ) );
	const ordered = [ ...after, ...before ];
	const onTop = parentsWithinRows( ordered, rowsNow, children, maxChildren, maxRows );

	if ( onTop.fit.length ) {
		return { fit: onTop.fit, replaces: 0, rows: onTop.rows };
	}

	const open = expandable.filter( ( parent ) => expanded.has( parent.id ) ).length;
	const instead = parentsWithinRows( ordered, parents.length, children, maxChildren, maxRows );

	return { fit: instead.fit, replaces: instead.fit.length ? open : 0, rows: instead.rows };
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
const defaultFetchAcross: FetchVariationsAcross = ( parentIds, page, options ) => getVariationsAcross( parentIds, page, options ) as unknown as Promise< VariationsResult | null >;

/** Selecting the variations of products left collapsed (row limit): say so, they are selected all the same. */
function notifySelectedCollapsed( collapsed: number ): void {
	notify.info(
		sprintf(
			/* translators: 1: number of products, 2: row limit */
			_n(
				'%1$d product stays collapsed so the page stays under %2$d rows; its variations are selected all the same.',
				'%1$d products stay collapsed so the page stays under %2$d rows; their variations are selected all the same.',
				collapsed,
				'wp-woocommerce-products-list'
			),
			collapsed,
			EXPAND_ALL_MAX_ROWS
		)
	);
}

export function useHierarchy( parents: ProductRow[], fields: ProductField[], options: HierarchyOptions = {} ): Hierarchy {
	const fetch = options.fetchVariations ?? ( getVariations as unknown as FetchVariations );
	// A test that injects the per-parent fetch alone keeps one request per parent.
	const fetchAcross = options.fetchVariationsAcross !== undefined ? options.fetchVariationsAcross : options.fetchVariations ? null : defaultFetchAcross;
	const maxChildren = options.maxChildren ?? getSettings().limits.maxChildrenPerParent;
	const confirmExpandAll = options.confirmExpandAll ?? defaultConfirm;
	const onExpandAllLimit = options.onExpandAllLimit ?? defaultOnExpandAllLimit;
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	const filterKey = options.variationFilter?.key ?? '';
	const filterParams = options.variationFilter?.params;

	// Before the load effect below: an expanded parent fetches with the filter in force.
	useLayoutEffect( () => {
		setVariationFilter( { key: filterKey, params: filterParams ?? {} } );
		// filterKey stands for filterParams.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ filterKey ] );

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
	const latestRef = useRef( { parentsById, fieldKeys, fetch, fetchAcross, maxChildren, expandedItemIds, rowCount: 0 } );
	useLayoutEffect( () => {
		latestRef.current = { parentsById, fieldKeys, fetch, fetchAcross, maxChildren, expandedItemIds, rowCount: latestRef.current.rowCount };
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
			// Seen at once by the next call in the same tick (several expands before a render must add up, not overwrite each other).
			latestRef.current = { ...latestRef.current, expandedItemIds: unique };
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

	// Several parents: across parents when the server can, one promise per id.
	const loadMany = useCallback(
		( ids: number[] ): Promise< void >[] => {
			const { parentsById: byId, fieldKeys: keys, fetch: fetcher, fetchAcross: across, maxChildren: cap } = latestRef.current;
			const found = ids.map( ( id ) => byId.get( id ) ).filter( ( parent ): parent is ProductRow => Boolean( parent?._hasChildren ) );

			if ( ! across ) {
				return found.map( ( parent ) => loadChildren( parent, keys, fetcher, cap ) );
			}

			return loadChildrenAcross( found, keys, across, ( parent ) => loadChildren( parent, keys, fetcher, cap ), cap );
		},
		[]
	);

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

		const toLoad: number[] = [];

		for ( const id of expandedItemIds ) {
			const parent = parentsById.get( id );
			const state = children.get( id );

			if ( parent?._hasChildren && ( ! state || state.status === 'idle' ) && ! inflight.has( id ) ) {
				toLoad.push( id );
			}
		}

		// A restored expansion of ten parents is one request, not ten.
		if ( toLoad.length ) {
			void Promise.all( loadMany( toLoad ) );
		}
	}, [ expandedItemIds, parentsById, childrenState, loadMany, pageKey, parents, maxChildren, setExpanded ] );

	const rows = useMemo(
		() => flattenHierarchy( parents, expandedSet, childrenState, maxChildren ),
		[ parents, expandedSet, childrenState, maxChildren ]
	);
	useLayoutEffect( () => {
		latestRef.current.rowCount = rows.length;
	} );

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

	/**
	 * Expand these parents in one go: one render now (every parent gets its
	 * loading row), the variations across parents, committed in slices of
	 * BULK_PUBLISH_ROWS rows, with the progress counter.
	 */
	const runBulkExpand = useCallback(
		async ( nextExpanded: number[], fit: ProductRow[] ): Promise< void > => {
			bulkLoads += 1;
			let done = 0;
			const total = fit.length;
			setExpandAllProgress( { done, total } );

			try {
				setExpanded( nextExpanded );
				await Promise.all(
					loadMany( fit.map( ( parent ) => parent.id ) ).map( ( promise ) =>
						promise.then( () => {
							done += 1;
							setExpandAllProgress( { done, total } );
						} )
					)
				);
			} finally {
				bulkLoads -= 1;

				if ( ! inBulkLoad() ) {
					setExpandAllProgress( null );

					if ( pendingEmit ) {
						emit();
					}
				}
			}
		},
		[ setExpanded, loadMany ]
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

			// Large, or partial: the user hears how many products open and how many stay collapsed before anything loads.
			const plan: ExpandAllPlan = { expanding: fit.length, skipped, rows: projected, maxRows: EXPAND_ALL_MAX_ROWS };

			if ( ! force && ( projected > EXPAND_ALL_WARN_ROWS || skipped > 0 ) && ! ( await confirmExpandAll( projected, plan ) ) ) {
				return false;
			}

			await runBulkExpand( [ ...current, ...fit.map( ( parent ) => parent.id ) ], fit );

			if ( skipped > 0 ) {
				onExpandAllLimit( { expanded: fit.length, skipped, rows: projected } );
			}

			return true;
		},
		[ parents, rows.length, maxChildren, confirmExpandAll, onExpandAllLimit, runBulkExpand ]
	);

	const nextPlan = useMemo( () => {
		const summary = expansionSummary( parents, expandedItemIds );

		if ( ! summary || summary.expanded === 0 || summary.expanded >= summary.total ) {
			return null;
		}

		return nextExpansion( parents, expandedItemIds, childrenState, maxChildren, rows.length );
	}, [ parents, expandedItemIds, childrenState, maxChildren, rows.length ] );

	const nextExpand = useMemo< NextExpandPlan | null >( () => ( nextPlan && nextPlan.fit.length ? { count: nextPlan.fit.length, replaces: nextPlan.replaces } : null ), [ nextPlan ] );

	const expandNext = useCallback( async (): Promise< boolean > => {
		if ( ! nextPlan || ! nextPlan.fit.length ) {
			return false;
		}

		const current = latestRef.current.expandedItemIds;
		const pageIds = new Set( parents.map( ( parent ) => parent.id ) );
		// Open ones stay when the next fit on top of them; otherwise the page's open ones make room (other pages' stay).
		const kept = nextPlan.replaces > 0 ? current.filter( ( id ) => ! pageIds.has( id ) ) : current;

		await runBulkExpand( [ ...kept, ...nextPlan.fit.map( ( parent ) => parent.id ) ], nextPlan.fit );

		return true;
	}, [ nextPlan, parents, runBulkExpand ] );

	const collapseAll = useCallback( () => setExpanded( [] ), [ setExpanded ] );

	const childrenOf = useCallback( ( parentId: number ) => childrenState.get( parentId ), [ childrenState ] );

	const variationIdsOf = useCallback( async ( parentIds: number[] ): Promise< number[] > => {
		const across = latestRef.current.fetchAcross;
		const unknown = parentIds.filter( ( id ) => {
			const loaded = children.get( id );

			return ! idCache.has( id ) && ! ( loaded?.status === 'loaded' && ! loaded.filtered && loaded.items.length >= loaded.total );
		} );

		// Many parents: their ids across parents first (a handful of requests), the per-parent reads below then hit the cache.
		if ( across && unknown.length > 1 ) {
			await loadVariationIdsAcross( unknown, across );
		}

		const lists = await Promise.all( parentIds.map( ( id ) => loadVariationIds( id, latestRef.current.fetch ) ) );

		return lists.flat();
	}, [] );

	const selectVariations = useCallback(
		async ( parentId: number | number[], current: string[] = [], where?: ( item: VariationRow ) => boolean ): Promise< string[] > => {
			const parentIds = Array.isArray( parentId ) ? parentId : [ parentId ];
			const { expandedItemIds: expanded, parentsById: byId, rowCount } = latestRef.current;
			const adding = parentIds
				.filter( ( id ) => ! expanded.includes( id ) )
				.map( ( id ) => byId.get( id ) )
				.filter( ( parent ): parent is ProductRow => Boolean( parent?._hasChildren ) );
			// Expanded only as far as the page stays under the row limit (2,500 rows froze every click for seconds); the rest are selected collapsed.
			const { fit } = parentsWithinRows( adding, rowCount, children, latestRef.current.maxChildren, EXPAND_ALL_MAX_ROWS );

			// One expand for all of them, the loads side by side (not one parent after the other).
			if ( fit.length ) {
				setExpanded( [ ...expanded, ...fit.map( ( parent ) => parent.id ) ] );
			}

			await Promise.all( loadMany( parentIds ) );

			if ( adding.length > fit.length ) {
				notifySelectedCollapsed( adding.length - fit.length );
			}

			const have = new Set( current );
			const next = [ ...current ];

			for ( const id of parentIds ) {
				const state = children.get( id );

				for ( const item of state?.items ?? [] ) {
					const itemId = getItemId( item );

					if ( ( ! where || where( item ) ) && ! have.has( itemId ) ) {
						have.add( itemId );
						next.push( itemId );
					}
				}
			}

			return next;
		},
		[ loadMany, setExpanded ]
	);

	const showAllVariations = useCallback( ( parentId: number ) => {
		if ( showAllParents.has( parentId ) ) {
			return;
		}

		showAllParents.add( parentId );
		invalidateVariations( [ parentId ] );
	}, [] );

	const showMatchingVariations = useCallback( ( parentId: number ) => {
		if ( ! showAllParents.delete( parentId ) ) {
			return;
		}

		invalidateVariations( [ parentId ] );
	}, [] );

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
		expandNext,
		nextExpand,
		collapseAll,
		getItemParentId,
		getItemHasChildren,
		getItemLevel,
		childrenOf,
		childrenState,
		variationIdsOf,
		selectVariations,
		variationFilterActive: filterKey !== '',
		showAllVariations,
		showMatchingVariations,
	};
}

/** Tests: reset the module store. */
export function resetHierarchyStore(): void {
	abortLoads();
	bulkLoads = 0;
	pendingEmit = false;
	staged.forEach( ( entry ) => entry.resolve() );
	staged = [];
	pumpScheduled = false;
	variationIndex = null;
	expandAllProgress = null;
	children = new Map();
	narrowing = { key: '', params: {} };
	showAllParents.clear();
	inflight.clear();
	idCache.clear();
	parentImages.clear();
	currentExpanded = new Set();
	currentParents = new Set();
	emit();
}
