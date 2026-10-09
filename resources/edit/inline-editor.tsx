/**
 * Quick edit (one row) and bulk edit (many rows) inline in the table, like
 * WooCommerce's classic list: the quick editor takes the place of the row
 * it edits, the bulk editor sits above the first row (edit/editor-rows.ts
 * places it, editor-context.tsx hosts it). Edits stay local until Update;
 * Cancel and Escape discard after a confirm when something was typed, and
 * the same confirm guards paging, sorting, filtering and opening another
 * editor (`host.setGuard`). Update goes variations first then parents,
 * with progress next to the buttons; a partial failure keeps the editor
 * open, on the rows it saved, with the failed rows listed and the next
 * Update retrying only those.
 *
 * The bulk editor follows the live selection until a save starts: ticking
 * a row adds it (its current values are fetched on their own), the x on an
 * item unticks it. From the first save on it works on the rows it had, so
 * a partial failure cannot turn a bulk edit of three into a quick edit of
 * the one that failed. Rows that turn out to be gone (deleted or trashed
 * since the list loaded, or rejected by the save as deleted) leave the
 * list when the editor closes, not while it is open.
 *
 * The current values are loaded per tab: the tab the editor opens on comes
 * with it, the others on their first visit (six languages of descriptions
 * for a page of 100 products is over a megabyte nobody looks at).
 */
import { Button, CheckboxControl, Notice, RadioControl, Spinner, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { addQueryArgs } from '@wordpress/url';
import { closeSmall, Icon } from '@wordpress/icons';
import type { KeyboardEvent } from 'react';
import { getVariations, logSkipped, newBatchId } from '../api/client';
import type { SkippedItem } from '../api/client';
import { DataForm, useFormValidity } from '../dataviews';
import { getSettings } from '../settings';
import { patchItems, removeItems } from '../store/products';
import { getCurrentRows } from '../store/rows';
import type { ProductListItem, QuickEditTab, Settings } from '../types';
import { rowFields } from '../actions/context';
import { runDeclarativeAction } from '../actions/index';
import { notify } from '../actions/notices';
import { fetchAllVariations, VARIATION_FETCH_CONCURRENCY, variationFetchFields } from './apply-to-variations';
import { withArrayOps } from './bulk-array';
import { changedSinceLoaded, editFetchFields, hydrateSelection, mergeHydrated, recheckStatuses, rootKeysOf, tabFetchFields } from './hydrate';
import { hasLoadRelativeOps, lowersPrice, parseNumeric, projectWarnings, validateBulkNumericEdits, validateNumericOps } from './bulk-numeric';
import { ChangeSummary, describeSiteDateTime } from './change-summary';
import { formatPrice } from '../fields/currency';
import type { EditorHost } from './editor-context';
import { fieldOfErrorCode, isGoneCode } from './errors';
import { itemLabel, parentNameOf, shortNameOf, skuOf } from './item-label';
import { LanguageTools, stagedToolIds, toolTargetsLabel } from './language-tools';
import type { StagedTool } from './language-tools';
import { editTypeOf, isVariableParent, isVariation } from './field-value';
import { captureFocusOrigin, focusWithin, restoreFocus } from './focus';
import { buildInlineForm, buildTabs, fieldsOfTab, GENERAL_TAB_ID, tabOf, withScheduleSale } from './form-layouts';
import { labelsOf, toFormFields } from './form-fields';
import type { FormData } from './form-fields';
import { EditErrors, SaveProgress } from './progress';
import type { EditError } from './progress';
import { canEnableStock, rowsWithExistingSale, saleIsActive, stockGatedRows } from './row-rules';
import type { RowEditOptions } from './row-rules';
import { saveEdits } from './save';
import type { SaveResult } from './save';
import { planSave } from './save-runner';
import type { SavePlan } from './save-runner';
import { undoBatch } from './undo';
import { canUndo } from './log-access';
import { selectRows } from '../list/selection';
import { useEditState } from './use-edit-state';
import { saleScheduleProblems } from './sale-schedule';
import { clearFlaggedControls, collectInvalidFields, controlForField, flagInvalidControls, focusControl, focusFirstInvalidControl, invalidMessageId, revealInvalidControls, validateFormData } from './validity';
import type { InvalidField, ValidatedField } from './validity';
import { isSellableField, visibleEditFields } from './visibility';

export interface InlineEditorProps {
	host: EditorHost;
}

type VariationLoad = { status: 'idle' | 'loading' | 'loaded' | 'error'; byParent: Map< number, ProductListItem[] >; count: number; error?: string };

const IDLE_LOAD: VariationLoad = { status: 'idle', byParent: new Map(), count: 0 };

const PANEL_ID = 'wc-pl-edit-panel';

/** The snackbar after a save: one at a time, a new save replaces the previous one's Undo. */
export const SAVED_NOTICE_ID = 'wc-pl-saved';

/**
 * The tab "Update & next" carries to the next row's editor (fixing the
 * Swedish names one after another stays on Svenska). Any other editor opens
 * on General, or on the language of the list's translation filter: a
 * restock after a translation session must not open on Svenska.
 */
let carriedTab: string | null = null;

/** Hand the open tab to the editor "Update & next" opens next. */
export function carryTabToNext( tab: string ): void {
	carriedTab = tab;
}

/** The tab a new editor opens on: the filter's language, else the tab carried by "Update & next", else General. */
export function openingTab( initialTab: string | undefined | null ): string {
	const carried = carriedTab;

	carriedTab = null;

	return initialTab ?? carried ?? GENERAL_TAB_ID;
}

/** On <html> while an editor is open: the snackbars keep clear of its buttons. */
export const EDITING_CLASS = 'wc-pl-editing';

/** How many item names a notice lists before "and N more". */
const NAMES_SHOWN = 5;

/** How many rows the bulk editor's list names before "and N more". */
export const ITEMS_LISTED = 200;

function pick( edits: Record< string, unknown >, ids: Set< string > ): Record< string, unknown > {
	return Object.fromEntries( Object.entries( edits ).filter( ( [ id ] ) => ids.has( id ) ) );
}

function nameOf( item: ProductListItem ): string {
	return itemLabel( item );
}

/** "A, B, C and 4 more" for a notice. */
export function listNames( items: ProductListItem[] ): string {
	const names = items.slice( 0, NAMES_SHOWN ).map( nameOf );
	const rest = items.length - names.length;

	if ( rest > 0 ) {
		/* translators: 1: a comma-separated list of names, 2: how many more there are */
		return sprintf( __( '%1$s and %2$d more', 'wp-woocommerce-products-list' ), names.join( ', ' ), rest );
	}

	return names.join( ', ' );
}

/** "3 products, 12 variations" under the bulk heading. */
export function breakdown( items: ProductListItem[] ): string {
	const products = items.filter( ( item ) => ! isVariation( item ) ).length;
	const variations = items.length - products;
	const parts: string[] = [];

	if ( products ) {
		/* translators: %d: number of products */
		parts.push( sprintf( _n( '%d product', '%d products', products, 'wp-woocommerce-products-list' ), products ) );
	}

	if ( variations ) {
		/* translators: %d: number of variations */
		parts.push( sprintf( _n( '%d variation', '%d variations', variations, 'wp-woocommerce-products-list' ), variations ) );
	}

	return parts.join( ', ' );
}

function focusFirstControl( root: HTMLElement | null, prefer?: string ): void {
	const preferred = prefer ? root?.querySelector< HTMLElement >( prefer ) : null;
	const first = preferred ?? root?.querySelector< HTMLElement >( 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])' );

	// The editor positions itself (scrollEditorIntoView); a focus scroll would push its title under the sticky chrome.
	first?.focus( { preventScroll: true } );
}

/** The Update button text for a plan: what will actually be written. */
export function saveLabelFor( plan: SavePlan ): string {
	const { products, variations } = plan;

	if ( products === 0 && variations === 0 ) {
		return __( 'Nothing to update', 'wp-woocommerce-products-list' );
	}

	if ( products > 0 && variations > 0 ) {
		return sprintf(
			/* translators: 1: "Update N products" or "Update 1 product", 2: "N variations" or "1 variation" */
			__( '%1$s, %2$s', 'wp-woocommerce-products-list' ),
			/* translators: %d: number of products */
			sprintf( _n( 'Update %d product', 'Update %d products', products, 'wp-woocommerce-products-list' ), products ),
			/* translators: %d: number of variations */
			sprintf( _n( '%d variation', '%d variations', variations, 'wp-woocommerce-products-list' ), variations )
		);
	}

	if ( variations > 0 ) {
		/* translators: %d: number of variations */
		return sprintf( _n( 'Update %d variation', 'Update %d variations', variations, 'wp-woocommerce-products-list' ), variations );
	}

	/* translators: %d: number of products */
	return sprintf( _n( 'Update %d product', 'Update %d products', products, 'wp-woocommerce-products-list' ), products );
}

/** The snackbar after a save without errors: what was written, and what the plan left out. */
export interface StatusSkips {
	/** Rows left out because they were moved to the Trash since the editor loaded them. */
	trashed: number;
	/** Rows left out because they were deleted since. */
	missing: number;
	/** Their names, for the message. */
	names?: string;
}

export function successMessage( result: SaveResult, skipped: StatusSkips = { trashed: 0, missing: 0 } ): string {
	const updated = result.updated.length;
	const extras: string[] = [];

	if ( skipped.trashed > 0 ) {
		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d skipped (moved to the Trash meanwhile)', '%d skipped (moved to the Trash meanwhile)', skipped.trashed, 'wp-woocommerce-products-list' ), skipped.trashed ) );
	}

	if ( skipped.missing > 0 ) {
		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d skipped (deleted meanwhile)', '%d skipped (deleted meanwhile)', skipped.missing, 'wp-woocommerce-products-list' ), skipped.missing ) );
	}

	if ( result.unchanged > 0 ) {
		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d unchanged', '%d unchanged', result.unchanged, 'wp-woocommerce-products-list' ), result.unchanged ) );
	}

	if ( result.stockSkipped > 0 ) {
		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d skipped (no stock management)', '%d skipped (no stock management)', result.stockSkipped, 'wp-woocommerce-products-list' ), result.stockSkipped ) );
	}

	if ( result.saleSkipped > 0 ) {
		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d skipped (already on sale)', '%d skipped (already on sale)', result.saleSkipped, 'wp-woocommerce-products-list' ), result.saleSkipped ) );
	}

	if ( ( result.notLowerSkipped ?? 0 ) > 0 ) {
		const count = result.notLowerSkipped ?? 0;

		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d skipped (the sale price would not be lower)', '%d skipped (the sale price would not be lower)', count, 'wp-woocommerce-products-list' ), count ) );
	}

	if ( result.replacedSales > 0 ) {
		/* translators: %d: number of rows */
		extras.push( sprintf( _n( '%d existing sale replaced', '%d existing sales replaced', result.replacedSales, 'wp-woocommerce-products-list' ), result.replacedSales ) );
	}

	if ( updated === 0 ) {
		return extras.length
			? /* translators: %s: e.g. "10 unchanged, 3 skipped (no stock management)" */
			  sprintf( __( 'Nothing changed: %s.', 'wp-woocommerce-products-list' ), extras.join( ', ' ) )
			: __( 'Nothing to change.', 'wp-woocommerce-products-list' );
	}

	/* translators: %d: number of rows saved */
	const base = sprintf( _n( '%d item updated', '%d items updated', updated, 'wp-woocommerce-products-list' ), updated );
	const message = `${ [ base, ...extras ].join( ', ' ) }.`;

	return skipped.names && skipped.trashed + skipped.missing > 0
		? /* translators: 1: the message, 2: names of the rows skipped */
		  sprintf( __( '%1$s Skipped: %2$s', 'wp-woocommerce-products-list' ), message, skipped.names )
		: message;
}

/**
 * The snackbar after a partial failure: the counts while the editor is up
 * to list the rows; who failed and why when it is not (unmounted by the
 * list mid-save).
 */
export function partialFailureMessage( result: Pick< SaveResult, 'updated' | 'errors' >, names: Map< number, string >, detailed = true ): string {
	const head = sprintf(
		/* translators: 1: rows saved, 2: rows that failed */
		__( '%1$d updated, %2$d failed.', 'wp-woocommerce-products-list' ),
		result.updated.length,
		result.errors.length
	);

	if ( ! detailed ) {
		return head;
	}

	const shown = result.errors.slice( 0, NAMES_SHOWN ).map( ( error ) => `${ names.get( error.id ) ?? `#${ error.id }` }: ${ error.message }` );
	const rest = result.errors.length - shown.length;

	if ( rest > 0 ) {
		/* translators: %d: number of further rows */
		shown.push( sprintf( __( '…and %d more', 'wp-woocommerce-products-list' ), rest ) );
	}

	return `${ head } ${ shown.join( ' ' ) }`;
}

/** The row after `id` on screen, of the same kind (a product's next product, a variation's next variation). */
export function nextRowOnScreen( id: number, rows: ProductListItem[] = getCurrentRows() ): ProductListItem | null {
	const index = rows.findIndex( ( row ) => row.id === id );

	if ( index === -1 ) {
		return null;
	}

	const current = rows[ index ]!;

	return rows.slice( index + 1 ).find( ( row ) => ! row._placeholder && isVariation( row ) === isVariation( current ) && row.wc_products_list?.can_edit !== false ) ?? null;
}

/**
 * Whether an Escape belongs to the control it was pressed in: a native
 * select (Chrome hands the Escape that closes its dropdown to the page), a
 * combobox or an open popup. It closes that control, never the editor.
 */
export function escapeBelongsToControl( target: EventTarget | null, openSelect: Element | null = null ): boolean {
	if ( ! ( target instanceof Element ) ) {
		return false;
	}

	// A native select keeps the Escape only while its dropdown is open (a press or a key opened it):
	// focus sitting on a closed select, as right after a bulk editor opens, lets Escape cancel.
	if ( target instanceof HTMLSelectElement ) {
		return target === openSelect;
	}

	if ( target.getAttribute( 'aria-expanded' ) === 'true' ) {
		return true;
	}

	return target.closest( '[role="combobox"][aria-expanded="true"], [role="listbox"], [role="menu"], .components-popover' ) !== null;
}

function isTextEntry( target: EventTarget | null ): target is HTMLInputElement {
	if ( ! ( target instanceof HTMLInputElement ) ) {
		return false;
	}

	if ( [ 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color' ].includes( target.type ) ) {
		return false;
	}

	// Token and combobox inputs use Enter to pick a suggestion.
	return ! target.getAttribute( 'aria-autocomplete' ) && ! target.closest( '[role="combobox"], .components-form-token-field, [aria-haspopup="listbox"]' );
}

/** The keys that open a native select's dropdown (Alt+Arrow everywhere, Space, and plain arrows on macOS). */
function opensSelect( event: KeyboardEvent< HTMLFormElement > ): boolean {
	return event.key === ' ' || event.key === 'F4' || ( ( event.key === 'ArrowDown' || event.key === 'ArrowUp' ) && ( event.altKey || /Mac/i.test( navigator.platform ) ) );
}

/**
 * Whether Enter in `target` must not reach the browser's implicit form
 * submission: every form control except a button, a textarea and a link
 * (they keep their own Enter). A select, a checkbox or a radio would
 * otherwise submit the editor.
 */
export function blocksImplicitSubmit( target: EventTarget | null ): boolean {
	if ( ! ( target instanceof Element ) ) {
		return false;
	}

	if ( target instanceof HTMLButtonElement || target instanceof HTMLTextAreaElement || target instanceof HTMLAnchorElement ) {
		return false;
	}

	if ( target instanceof HTMLInputElement ) {
		return ! [ 'button', 'submit', 'reset', 'image' ].includes( target.type );
	}

	return target instanceof HTMLSelectElement;
}

/**
 * Bring a notice of the editor (its problem list, its "Update anyway?")
 * into view and give it the keyboard focus, so it is read out and the next
 * Tab walks its field links. Returns whether it was found.
 */
export function revealNotice( root: HTMLElement | null, selector: string ): boolean {
	const notice = root?.querySelector< HTMLElement >( selector );

	if ( ! notice ) {
		return false;
	}

	if ( ! notice.hasAttribute( 'tabindex' ) ) {
		notice.setAttribute( 'tabindex', '-1' );
	}

	notice.focus( { preventScroll: true } );

	if ( typeof notice.scrollIntoView === 'function' ) {
		notice.scrollIntoView( { block: 'center', inline: 'nearest' } );
	}

	return notice.ownerDocument.activeElement === notice;
}

/** The sticky chrome above the table (the admin bar, the table header when it sticks): what a scrolled-to editor must clear. */
function stickyOffset( root: HTMLElement ): number {
	const adminBar = document.getElementById( 'wpadminbar' );
	const head = root.closest( 'table' )?.querySelector( 'thead' );
	const headHeight = head && window.getComputedStyle( head ).position === 'sticky' ? head.offsetHeight : 0;

	return ( adminBar?.offsetHeight ?? 0 ) + headHeight + 8;
}

/**
 * Bring the editor into view: the bulk editor to the top of the viewport
 * (under the sticky chrome); a quick editor stays where it is when it
 * already fits, else moves the least that shows it, its top first when it
 * is taller than the viewport.
 */
/** Room kept under a quick editor's buttons when it is scrolled into view. */
const EDITOR_BOTTOM_MARGIN = 16;

export function scrollEditorIntoView( root: HTMLElement, mode: 'quick' | 'bulk' ): void {
	if ( typeof root.getBoundingClientRect !== 'function' ) {
		return;
	}

	const rect = root.closest( 'tr' )?.getBoundingClientRect() ?? root.getBoundingClientRect();

	// Not laid out (a test DOM): nothing to scroll to.
	if ( rect.width === 0 && rect.height === 0 ) {
		return;
	}

	const offset = stickyOffset( root );
	const viewport = window.innerHeight;

	if ( mode === 'bulk' ) {
		if ( rect.top < offset || rect.top > viewport / 2 ) {
			window.scrollBy( { top: rect.top - offset, behavior: 'auto' } );
		}

		return;
	}

	if ( rect.top < offset ) {
		window.scrollBy( { top: rect.top - offset, behavior: 'auto' } );
	} else if ( rect.bottom > viewport - EDITOR_BOTTOM_MARGIN ) {
		// The buttons at the editor's foot stay on screen (with a margin), unless that would push its top under the sticky header.
		window.scrollBy( { top: Math.min( rect.bottom - viewport + EDITOR_BOTTOM_MARGIN, rect.top - offset ), behavior: 'auto' } );
	}
}

/** The badge after an item in the bulk list: "Variation", or the product type when not simple. */
function kindLabel( item: ProductListItem, types: Array< { value: string; label: string } > ): string | null {
	const type = editTypeOf( item );

	if ( type === 'variation' ) {
		return __( 'Variation', 'wp-woocommerce-products-list' );
	}

	if ( type === 'simple' ) {
		return null;
	}

	return types.find( ( entry ) => entry.value === type )?.label ?? type;
}

/**
 * The sales a bulk edit would end right now: how many rows are on sale at
 * this moment, the lowest price they sell at, and when the new sale starts.
 * A sale scheduled for later still replaces the running one on save (a
 * WooCommerce product has one sale window), so those rows sell at their
 * regular price until the new one starts; the message says so before Update.
 */
export function describeRunningSales( rows: ProductListItem[], edits: Record< string, unknown >, settings: Settings, now: number = Date.now() ): { count: number; message: string } {
	const running = rows.filter( ( item ) => saleIsActive( item, now ) );

	if ( running.length === 0 ) {
		return { count: 0, message: '' };
	}

	const prices = running.map( ( item ) => parseNumeric( ( item as { sale_price?: unknown } ).sale_price, settings ) ).filter( ( value ): value is number => value !== undefined );
	const lowest = prices.length ? formatPrice( Math.min( ...prices ), settings ) : '';
	const from = edits.date_on_sale_from;
	const startsLater = typeof from === 'string' && from !== '' && Number.isFinite( Date.parse( from ) ) && Date.parse( from ) > now;
	const head = lowest
		? sprintf(
				/* translators: 1: number of rows, 2: the lowest price among them */
				_n( '%1$d of them is on sale right now (at %2$s).', '%1$d of them are on sale right now (lowest %2$s).', running.length, 'wp-woocommerce-products-list' ),
				running.length,
				lowest
		  )
		: sprintf(
				/* translators: %d: number of rows */
				_n( '%d of them is on sale right now.', '%d of them are on sale right now.', running.length, 'wp-woocommerce-products-list' ),
				running.length
		  );
	const tail = startsLater
		? sprintf(
				/* translators: %s: when the new sale starts */
				__( 'A product has one sale at a time: replacing ends the current sale when you update, and these rows sell at their regular price until the new sale starts on %s.', 'wp-woocommerce-products-list' ),
				describeSiteDateTime( from, settings )
		  )
		: __( 'Replacing changes the price customers pay as soon as you update.', 'wp-woocommerce-products-list' );

	return { count: running.length, message: `${ head } ${ tail }` };
}

export function InlineEditor( { host }: InlineEditorProps ) {
	const { session, fields: allFields, items: hostItems, close: onClose, advance: onAdvance, removeItem: onRemoveItem, setGuard, offPageCount, wholeList } = host;
	const settings = getSettings();
	const bulk = session.mode === 'bulk';
	const mode = bulk ? 'bulk' : 'quick';
	const initialTab = session.initialTab;
	// The rows to edit: the live selection (bulk) or the one row, until the first save: from then on the rows that save had.
	const liveRows = useMemo( () => hostItems.filter( ( item ) => ! item._placeholder ), [ hostItems ] );
	const [ frozenRows, setFrozenRows ] = useState< ProductListItem[] | null >( null );
	const selectedRows = frozenRows ?? liveRows;
	const selectionKey = selectedRows.map( ( item ) => item.id ).join( ',' );
	// The tab the editor opens on: the list's translation filter, else the one "Update & next" carried over, else General.
	const [ tabId, setTabId ] = useState( () => openingTab( initialTab ) );
	// The same rows reloaded with the editable fields of the open tabs (the list only carries the visible columns), by id.
	const [ hydrated, setHydrated ] = useState< ReadonlyMap< number, ProductListItem > >( () => new Map() );
	const [ loaded, setLoaded ] = useState( false );
	const [ excluded, setExcluded ] = useState< { missing: ProductListItem[]; trashed: ProductListItem[] } >( { missing: [], trashed: [] } );
	const [ loadedTabs, setLoadedTabs ] = useState< ReadonlySet< string > >( () => new Set() );
	const [ tabLoading, setTabLoading ] = useState< string | null >( null );
	const loadingIdsRef = useRef< Set< number > >( new Set() );
	// Rows to drop from the list once the editor closes (gone or trashed since the list loaded, or rejected as deleted by a save).
	const pendingRemovalRef = useRef< Set< number > >( new Set() );
	const mountedRef = useRef( true );
	// A "may I close?" waiting on the discard confirm (Cancel, Escape, or the screen's guard); mirrored in a ref for the unmount cleanup.
	const [ leaveRequest, setLeaveRequest ] = useState< { resolve: ( ok: boolean ) => void } | null >( null );
	const leaveRequestRef = useRef( leaveRequest );

	useEffect( () => {
		leaveRequestRef.current = leaveRequest;
	}, [ leaveRequest ] );

	useEffect( () => {
		mountedRef.current = true;
		// While an editor is open the snackbars move to the other side, off its Update / Cancel buttons (edit/style.scss).
		document.documentElement.classList.add( EDITING_CLASS );

		return () => {
			mountedRef.current = false;
			document.documentElement.classList.remove( EDITING_CLASS );
		};
	}, [] );

	const excludedIds = useMemo( () => new Set( [ ...excluded.missing, ...excluded.trashed ].map( ( row ) => row.id ) ), [ excluded ] );
	const items = useMemo( () => selectedRows.filter( ( row ) => ! excludedIds.has( row.id ) ).map( ( row ) => hydrated.get( row.id ) ?? row ), [ selectedRows, excludedIds, hydrated ] );

	// Rows without their current values are fetched: all of them when the
	// editor opens (the open tab's fields), a newly ticked row on its own
	// (every tab visited so far). Rows gone meanwhile are left out with a notice.
	useEffect( () => {
		const missing = selectedRows.filter( ( row ) => ! hydrated.has( row.id ) && ! excludedIds.has( row.id ) && ! loadingIdsRef.current.has( row.id ) );

		if ( missing.length === 0 ) {
			return;
		}

		const tabs = loaded ? Array.from( loadedTabs ) : [ tabId ];
		const wanted = Array.from( new Set( tabs.flatMap( ( tab ) => editFetchFields( allFields, missing, mode, { tab } ) ) ) ).sort();

		missing.forEach( ( row ) => loadingIdsRef.current.add( row.id ) );

		hydrateSelection( missing, wanted )
			.then( ( { items: full, missing: gone, trashed } ) => {
				if ( ! mountedRef.current ) {
					return;
				}

				const goneSet = new Set( [ ...gone, ...trashed ] );
				const trashedSet = new Set( trashed );

				patchItems( full.filter( ( row ) => ! goneSet.has( row.id ) ) );
				// Rows deleted or trashed since the list loaded leave the edit now and the list when the editor closes.
				goneSet.forEach( ( id ) => pendingRemovalRef.current.add( id ) );

				setHydrated( ( current ) => {
					const next = new Map( current );

					// A tab's load may have landed first: its values stay, the full row goes on top.
					full.forEach( ( row ) => {
						const known = next.get( row.id );

						next.set( row.id, known ? ( mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown > ) as ProductListItem ) : row );
					} );

					return next;
				} );

				if ( goneSet.size ) {
					setExcluded( ( current ) => ( {
						missing: [ ...current.missing, ...full.filter( ( row ) => goneSet.has( row.id ) && ! trashedSet.has( row.id ) ) ],
						trashed: [ ...current.trashed, ...full.filter( ( row ) => trashedSet.has( row.id ) ) ],
					} ) );
				}

				if ( ! loaded ) {
					setLoaded( true );
					setLoadedTabs( new Set( tabs ) );
				}
			} )
			.catch( ( error: unknown ) => {
				if ( ! mountedRef.current ) {
					return;
				}

				notify.error( error instanceof Error ? error.message : __( 'The current values could not be loaded.', 'wp-woocommerce-products-list' ) );
				// The rows as the list had them, so the editor still opens.
				setHydrated( ( current ) => {
					const next = new Map( current );

					missing.forEach( ( row ) => next.set( row.id, row ) );

					return next;
				} );

				if ( ! loaded ) {
					setLoaded( true );
					setLoadedTabs( new Set( tabs ) );
				}
			} )
			.finally( () => {
				missing.forEach( ( row ) => loadingIdsRef.current.delete( row.id ) );
			} );
		// The tab only matters for the first load; later loads cover the tabs visited.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ selectionKey, hydrated, excludedIds, loaded, loadedTabs, allFields, mode ] );

	// What the editor closes with: rows it learned are gone leave every cached page; keyboard focus goes back to the row.
	const origin = session.origin;
	useEffect(
		() => () => {
			const pending = Array.from( pendingRemovalRef.current );

			pendingRemovalRef.current = new Set();

			if ( pending.length ) {
				removeItems( pending );
			}

			// A guard still waiting on the discard confirm: the editor is gone, so leaving is fine.
			leaveRequestRef.current?.resolve( true );

			// After the list has re-rendered the row the editor stood in for.
			setTimeout( () => restoreFocus( origin ), 0 );
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the session the editor opened with
		[]
	);

	const loading = ! loaded;
	const variableParents = useMemo( () => items.filter( isVariableParent ), [ items ] );
	const trashedRows = useMemo( () => items.filter( ( item ) => item.status === 'trash' ), [ items ] );

	const [ applyToVariations, setApplyToVariations ] = useState( false );
	const [ enableManageStock, setEnableManageStock ] = useState( false );
	// What happens to the sales the edits replace: chosen explicitly when some run right now (null: not chosen yet).
	const [ saleChoice, setSaleChoice ] = useState< 'replace' | 'skip' | null >( null );
	const skipExistingSales = saleChoice === 'skip';
	// "Only where it gets cheaper": a sale price op never raises what a row sells at.
	const [ onlyLowerSale, setOnlyLowerSale ] = useState( false );
	const [ errors, setErrors ] = useState< EditError[] >( [] );
	const [ warnings, setWarnings ] = useState< EditError[] >( [] );
	/** The fields whose problem is listed, in the order the editor shows them (tabs, then the form's order). */
	const [ invalidFields, setInvalidFields ] = useState< Array< { field: string; message: string } > >( [] );
	const [ acknowledged, setAcknowledged ] = useState< string | null >( null );
	const [ failedIds, setFailedIds ] = useState< Set< number > | null >( null );
	const [ saving, setSaving ] = useState( false );
	const [ submitRequested, setSubmitRequested ] = useState< false | 'save' | 'next' >( false );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	const [ variations, setVariations ] = useState< VariationLoad >( IDLE_LOAD );
	// Bumped when fetched variations are known to be stale (a save wrote some, someone else changed their parent): the forgotten parents load again.
	const [ variationEpoch, setVariationEpoch ] = useState( 0 );
	// Why the warning list is up: rows a decrease clamps at zero, or rows saved by someone else since the editor loaded them.
	const [ warningKind, setWarningKind ] = useState< 'clamp' | 'stale' >( 'clamp' );
	// The names of the rows a save failed on, as they were when it ran (a variation deleted meanwhile is in no list any more).
	const [ errorNames, setErrorNames ] = useState< ReadonlyMap< number, string > >( () => new Map() );
	// The language tools' runs added to this Update (they save with it, in its History batch), in the order added.
	const [ staged, setStaged ] = useState< ReadonlyMap< string, StagedTool > >( () => new Map() );
	const stagedCount = staged.size;
	const stageTool = useCallback( ( key: string, entry: StagedTool | null ) => {
		setStaged( ( current ) => {
			if ( ! entry && ! current.has( key ) ) {
				return current;
			}

			const next = new Map( current );

			if ( entry ) {
				next.set( key, entry );
			} else {
				next.delete( key );
			}

			return next;
		} );
		setErrors( [] );
	}, [] );
	const rootRef = useRef< HTMLFormElement >( null );
	const formRef = useRef< HTMLDivElement >( null );
	// The bulk list's x buttons: after one removes its item, focus moves to the x now at the same place (or the last one).
	const itemListRef = useRef< HTMLUListElement >( null );
	const removedIndexRef = useRef< number | null >( null );
	const focusedRef = useRef( false );
	const openSelectRef = useRef< HTMLSelectElement | null >( null );
	const saveRef = useRef< ( advance?: boolean, implicit?: boolean ) => Promise< void > >( async () => {} );

	const fieldsWithToggle = useMemo( () => withScheduleSale( allFields ), [ allFields ] );
	// Bulk mode adds the add/remove/replace select in front of the list fields.
	const editFields = useMemo( () => ( bulk ? withArrayOps( fieldsWithToggle ) : fieldsWithToggle ), [ fieldsWithToggle, bulk ] );
	const rowOptions = useMemo< RowEditOptions >(
		() => ( {
			enableManageStock,
			skipExistingSales,
			...( onlyLowerSale ? { keepSale: ( item: ProductListItem, rowEdits: Record< string, unknown > ) => lowersPrice( item, rowEdits, editFields, settings ) } : {} ),
		} ),
		[ enableManageStock, skipExistingSales, onlyLowerSale, editFields, settings ]
	);
	const visibleFields = useMemo( () => visibleEditFields( editFields, items, { mode, applyToVariations } ), [ editFields, items, mode, applyToVariations ] );
	// The edits belong to this editor: ticking another row into a bulk edit keeps what was typed.
	const state = useEditState( items, editFields, mode );

	const tabs = useMemo( () => buildTabs( visibleFields, items, settings ), [ visibleFields, items, settings ] );
	const tab = useMemo< QuickEditTab >( () => tabs.find( ( entry ) => entry.id === tabId ) ?? tabs[ 0 ] ?? { id: GENERAL_TAB_ID, label: __( 'General', 'wp-woocommerce-products-list' ) }, [ tabs, tabId ] );
	const form = useMemo( () => buildInlineForm( visibleFields, tab, items, settings ), [ visibleFields, tab, items, settings ] );
	const formFields = useMemo(
		() => toFormFields( visibleFields, { bulk, items, base: state.data, mixed: state.mixed, settings } ),
		// state.data changes on every keystroke; the placeholders only need the merged base, which state.mixed tracks.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ visibleFields, bulk, items, state.mixed, settings ]
	);
	const { validity, isValid } = useFormValidity< FormData >( state.data, formFields, form );

	// A tab visited for the first time loads its fields; the rows merge in object by object.
	useEffect( () => {
		if ( loading || loadedTabs.has( tab.id ) || tabLoading === tab.id ) {
			return;
		}

		const wanted = tabFetchFields( editFields, items, mode, tab );

		if ( wanted.length === 0 ) {
			setLoadedTabs( ( previous ) => new Set( [ ...previous, tab.id ] ) );

			return;
		}

		let cancelled = false;
		// Only what the tab asked for merges in: a partial row normalised by the client says `type: 'simple'` and `name: '#id'`.
		const only = rootKeysOf( [ ...wanted, 'status' ] );

		setTabLoading( tab.id );

		hydrateSelection( items, wanted )
			.then( ( { items: full } ) => {
				if ( cancelled ) {
					return;
				}

				setHydrated( ( current ) => {
					const next = new Map( current );

					for ( const row of full ) {
						const known = next.get( row.id ) ?? items.find( ( item ) => item.id === row.id );

						if ( known ) {
							next.set( row.id, mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown >, only ) as ProductListItem );
						}
					}

					return next;
				} );
				setLoadedTabs( ( previous ) => new Set( [ ...previous, tab.id ] ) );
			} )
			.catch( ( error: unknown ) => {
				if ( ! cancelled ) {
					notify.error( error instanceof Error ? error.message : __( 'The current values could not be loaded.', 'wp-woocommerce-products-list' ) );
					setLoadedTabs( ( previous ) => new Set( [ ...previous, tab.id ] ) );
				}
			} )
			.finally( () => {
				if ( ! cancelled ) {
					setTabLoading( ( current ) => ( current === tab.id ? null : current ) );
				}
			} );

		return () => {
			cancelled = true;
		};
		// `items` changes with every merge; the load is keyed by the tab and the selection.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ loading, loadedTabs, tab.id, selectionKey, editFields, mode ] );

	const tabReady = ! loading && loadedTabs.has( tab.id );
	// The form renders at once from what the rows carry (the list's columns) and the fetched values merge in: the first input is there before the request answers.
	const formShown = visibleFields.length > 0;

	// The editor comes into view and takes keyboard focus as soon as it is in the table; the first input gets it once the form is there.
	useEffect( () => {
		const root = rootRef.current;

		if ( root ) {
			scrollEditorIntoView( root, mode );

			if ( ! root.contains( document.activeElement ) ) {
				root.focus( { preventScroll: true } );
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- on mount
	}, [] );

	useEffect( () => {
		if ( ! formShown || focusedRef.current ) {
			return;
		}

		focusedRef.current = true;

		const root = rootRef.current;

		if ( root && ( ! root.contains( document.activeElement ) || document.activeElement === root ) ) {
			// A variation is quick-edited for its price (its status is a toggle seldom touched): the regular price first.
			const variationQuick = mode === 'quick' && items.length === 1 && isVariation( items[ 0 ]! );

			focusFirstControl( formRef.current, variationQuick ? 'input[id^="wc-pl-price-regular_price-"]:not([disabled])' : undefined );
		}

		// The form is in the row now: its height is known.
		if ( root ) {
			scrollEditorIntoView( root, mode );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mode is fixed for the editor's life
	}, [ formShown ] );

	// The open tab's values arrive after the form is shown and can make it taller: once they are in, the
	// editor is brought into view again so its buttons ("Update & next" walking down the list) stay on screen.
	const scrolledOnLoadRef = useRef( false );

	useEffect( () => {
		if ( ! tabReady || scrolledOnLoadRef.current ) {
			return;
		}

		scrolledOnLoadRef.current = true;

		const root = rootRef.current;

		if ( root && mode === 'quick' ) {
			scrollEditorIntoView( root, mode );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mode is fixed for the editor's life
	}, [ tabReady ] );

	useEffect( () => {
		const index = removedIndexRef.current;

		if ( index === null ) {
			return;
		}

		removedIndexRef.current = null;

		const buttons = Array.from( itemListRef.current?.querySelectorAll< HTMLButtonElement >( '.wc-pl-inline-edit__item-remove' ) ?? [] );
		const target = buttons[ Math.min( index, buttons.length - 1 ) ];

		if ( target ) {
			target.focus();
		} else if ( rootRef.current && ! rootRef.current.contains( document.activeElement ) ) {
			rootRef.current.focus( { preventScroll: true } );
		}
	}, [ items ] );

	// Load the variations of the selected variable parents once the option is on,
	// so relative price ops, the sale < regular check and the plan see their current values.
	// Keyed on the parent ids and the fetched keys, not on the rows' identity: a tab load,
	// a hydration merge or a list patch rebuilds `items` without changing what to fetch.
	// Parents already fetched (with the same keys) are kept; only new ones are loaded.
	const variableParentKey = variableParents.map( ( parent ) => parent.id ).join( ',' );
	const variationFieldKey = useMemo( () => {
		const sellableIds = Object.fromEntries( visibleFields.filter( isSellableField ).map( ( field ) => [ field.id, true ] ) );

		const keys = new Set( variationFetchFields( fieldsWithToggle, sellableIds ) );

		// On a language tab the market prices load too, so "Adjust market prices" previews the variations it reaches.
		if ( tab.id.includes( ':' ) ) {
			for ( const price of [ 'regular_price', 'sale_price' ] ) {
				allFields.find( ( field ) => field.id === `${ tab.id }.${ price }` )?.rest?.fields.forEach( ( key ) => keys.add( key ) );
			}
		}

		return Array.from( keys ).sort().join( ',' );
	}, [ visibleFields, fieldsWithToggle, tab.id, allFields ] );
	const variationCacheRef = useRef< { fieldKey: string; byParent: Map< number, ProductListItem[] > } >( { fieldKey: '', byParent: new Map() } );

	useEffect( () => {
		const parentIds = variableParentKey ? variableParentKey.split( ',' ).map( Number ) : [];

		if ( ! applyToVariations || parentIds.length === 0 ) {
			setVariations( IDLE_LOAD );

			return;
		}

		const cache = variationCacheRef.current;

		if ( cache.fieldKey !== variationFieldKey ) {
			variationCacheRef.current = { fieldKey: variationFieldKey, byParent: new Map() };
		}

		const known = variationCacheRef.current.byParent;
		const pick = () => {
			const byParent = new Map< number, ProductListItem[] >();
			let count = 0;

			for ( const id of parentIds ) {
				const rows = known.get( id );

				if ( rows ) {
					byParent.set( id, rows );
					count += rows.length;
				}
			}

			return { byParent, count };
		};
		const queue = parentIds.filter( ( id ) => ! known.has( id ) );

		if ( queue.length === 0 ) {
			setVariations( { status: 'loaded', ...pick() } );

			return;
		}

		const controller = new AbortController();
		const fetchFields = variationFieldKey.split( ',' );
		const getPage = ( parentId: number, page: number, fieldList: string[] ) =>
			getVariations( parentId, page, { perPage: settings.limits.perPageMax, fields: fieldList, signal: controller.signal } );

		setVariations( { status: 'loading', ...pick() } );

		( async () => {
			const worker = async () => {
				while ( queue.length && ! controller.signal.aborted ) {
					const parentId = queue.shift()!;
					const rows = await fetchAllVariations( parentId, fetchFields, getPage );

					if ( ! controller.signal.aborted ) {
						known.set( parentId, rows );
					}
				}
			};

			try {
				await Promise.all( Array.from( { length: Math.min( VARIATION_FETCH_CONCURRENCY, queue.length ) }, worker ) );

				if ( ! controller.signal.aborted ) {
					setVariations( { status: 'loaded', ...pick() } );
				}
			} catch ( error ) {
				if ( ! controller.signal.aborted ) {
					setVariations( { status: 'error', ...pick(), error: error instanceof Error ? error.message : String( error ) } );
				}
			}
		} )();

		return () => {
			controller.abort();
		};
	}, [ applyToVariations, variableParentKey, variationFieldKey, settings.limits.perPageMax, variationEpoch ] );

	/** After a save the fetched variations are stale: the next load (a retry, a further edit) fetches them again. */
	const forgetVariations = useCallback( ( ids?: Iterable< number > ) => {
		const known = variationCacheRef.current.byParent;

		if ( ! ids ) {
			known.clear();

			return;
		}

		for ( const id of ids ) {
			known.delete( id );
		}
	}, [] );

	const visibleIds = useMemo( () => new Set( visibleFields.map( ( field ) => field.id ) ), [ visibleFields ] );
	const pendingEdits = useMemo( () => pick( state.edits, visibleIds ), [ state.edits, visibleIds ] );
	const pendingCount = Object.keys( pendingEdits ).length;
	const fieldLabels = useMemo( () => labelsOf( editFields ), [ editFields ] );
	const tabLabels = useMemo( () => Object.fromEntries( tabs.map( ( entry ) => [ entry.id, entry.label ] ) ), [ tabs ] );
	const fieldTab = useCallback( ( fieldId: string ) => editFields.find( ( field ) => field.id === fieldId ), [ editFields ] );

	const onChange = useCallback(
		( changes: Record< string, unknown > ) => {
			state.setFields( changes );
			setErrors( [] );
			setWarnings( [] );
			setAcknowledged( null );
			setInvalidFields( [] );
			clearFlaggedControls( formRef.current );
		},
		[ state ]
	);

	/** The variations a price tool reaches when "Apply price and sale fields to all variations" is ticked. */
	const parentVariations = useMemo(
		() => ( applyToVariations && variations.status === 'loaded' ? Array.from( variations.byParent.values() ).flat() : undefined ),
		[ applyToVariations, variations ]
	);

	const variationsReady = ! applyToVariations || variableParents.length === 0 || variations.status === 'loaded';

	/**
	 * After a partial failure only the failed rows are sent again: a parent
	 * whose variations failed comes along to carry them, without its own
	 * edits (they saved) unless the parent itself failed.
	 */
	const retryTargets = useMemo( () => {
		if ( ! failedIds ) {
			return { items, prefetched: variations.byParent as ReadonlyMap< number, ProductListItem[] >, carriersOnly: undefined };
		}

		const prefetched = new Map< number, ProductListItem[] >();

		for ( const [ parentId, rows ] of variations.byParent ) {
			prefetched.set(
				parentId,
				rows.filter( ( row ) => failedIds.has( row.id ) )
			);
		}

		const retried = items.filter( ( item ) => failedIds.has( item.id ) || ( isVariableParent( item ) && ( prefetched.get( item.id )?.length ?? 0 ) > 0 ) );

		return {
			items: retried,
			prefetched: prefetched as ReadonlyMap< number, ProductListItem[] >,
			carriersOnly: new Set( retried.filter( ( item ) => ! failedIds.has( item.id ) ).map( ( item ) => item.id ) ) as ReadonlySet< number >,
		};
	}, [ failedIds, items, variations ] );

	// What the checks, the preview and the guards look at: every row, or after a partial failure only the rows
	// the retry sends (the saved ones are done: their new sale is not "a sale running now" to replace).
	const targetsForValidation = useMemo( () => {
		const base = failedIds ? retryTargets.items.filter( ( item ) => ! retryTargets.carriersOnly?.has( item.id ) ) : items;

		if ( ! applyToVariations ) {
			return base;
		}

		// A variation both selected and reached through its parent is one row, not two.
		const selected = new Set( base.map( ( item ) => item.id ) );

		return [ ...base, ...Array.from( retryTargets.prefetched.values() ).flat().filter( ( row ) => ! selected.has( row.id ) ) ];
	}, [ applyToVariations, items, failedIds, retryTargets ] );

	// The plan and the warnings walk every target row; on a large selection they
	// follow the keystroke a frame later rather than slowing the input down.
	const plannedEdits = useDeferredValue( pendingEdits );
	const plannedCount = Object.keys( plannedEdits ).length;

	/** What the save will write, skip and leave alone, for the labels and the summary. */
	const plan = useMemo< SavePlan | null >( () => {
		if ( loading || plannedCount === 0 || ! variationsReady ) {
			return null;
		}

		return planSave( retryTargets.items, plannedEdits, editFields, settings, {
			applyToVariations,
			variationsByParent: retryTargets.prefetched,
			...( retryTargets.carriersOnly?.size ? { carriersOnly: retryTargets.carriersOnly } : {} ),
			...rowOptions,
		} );
	}, [ loading, plannedCount, variationsReady, retryTargets, plannedEdits, editFields, settings, applyToVariations, rowOptions ] );

	// Rows a stock edit would be dropped for, before the "turn on Manage stock" option is applied.
	const stockGated = useMemo( () => ( plannedCount ? stockGatedRows( targetsForValidation, plannedEdits ) : [] ), [ plannedCount, targetsForValidation, plannedEdits ] );
	const stockEnableable = useMemo( () => stockGated.filter( canEnableStock ), [ stockGated ] );
	// Rows whose current sale the edits replace (bulk only: quick edit shows the field itself).
	const existingSales = useMemo( () => ( bulk && plannedCount ? rowsWithExistingSale( targetsForValidation, plannedEdits ) : { rows: [], active: 0 } ), [ bulk, plannedCount, targetsForValidation, plannedEdits ] );
	// Sales running now that the edits would end: the user says replace or skip before anything is written.
	const runningSales = useMemo( () => describeRunningSales( existingSales.rows, plannedEdits, settings ), [ existingSales.rows, plannedEdits, settings ] );
	const saleChoiceNeeded = bulk && runningSales.count > 0 && saleChoice === null;

	const nextRow = useMemo( () => ( bulk || ! selectedRows[ 0 ] ? null : nextRowOnScreen( selectedRows[ 0 ].id ) ), [ bulk, selectedRows ] );

	/** Focus a field from the problem list: its tab first, then its control. */
	const focusField = useCallback(
		( fieldId: string ) => {
			const field = fieldTab( fieldId );

			if ( field && tabOf( field ) !== tab.id ) {
				setTabId( tabOf( field ) );
			}

			setTimeout( () => {
				if ( mountedRef.current ) {
					focusControl( controlForField( formRef.current, fieldLabels[ fieldId ] ?? fieldId ) );
				}
			}, 0 );
		},
		[ fieldTab, tab.id, fieldLabels ]
	);

	/**
	 * Block the save on the form's own rules: the sale dates (quick and bulk:
	 * a half-typed date must never become "no date") and, in quick edit, every
	 * field's rules against the values as they are now (DataForm's tree lags a
	 * change by a render and only re-checks the fields that changed), on the
	 * tabs whose values are loaded. Every problem is listed, every invalid
	 * control is flagged, and focus goes to the first one.
	 */
	const blockOnValidity = (): boolean => {
		let invalid: InvalidField[] = saleScheduleProblems( state.data, visibleIds );

		if ( ! bulk ) {
			const checked = formFields.filter( ( field ) => {
				const source = fieldTab( field.id );

				return ! source || loadedTabs.has( tabOf( source ) );
			} );
			const known = new Set( invalid.map( ( entry ) => entry.field ) );
			let rules = validateFormData( state.data, checked as unknown as ValidatedField[] ).filter( ( entry ) => ! known.has( entry.field ) );

			if ( rules.length === 0 && invalid.length === 0 && ! isValid ) {
				rules = collectInvalidFields( validity as Parameters< typeof collectInvalidFields >[ 0 ] );
			}

			invalid = [ ...invalid, ...rules ];
		}

		if ( invalid.length === 0 ) {
			return false;
		}

		// The form's order (the General tab's columns, then the other tabs), so "first" is the first on screen.
		const order = new Map( visibleFields.map( ( field, index ) => [ field.id, index ] ) );
		const tabOrder = new Map( tabs.map( ( entry, index ) => [ entry.id, index ] ) );
		const rank = ( id: string ) => {
			const field = fieldTab( id );

			return ( field ? tabOrder.get( tabOf( field ) ) ?? 0 : 0 ) * 10000 + ( order.get( id ) ?? 9999 );
		};

		invalid = [ ...invalid ].sort( ( a, b ) => rank( a.field ) - rank( b.field ) );

		// The browser's wording when the control has one, so the list says what the field says.
		const worded = invalid.map( ( entry ) => {
			const control = controlForField( formRef.current, fieldLabels[ entry.field ] ?? entry.field ) as HTMLInputElement | null;
			const native = control && typeof control.validationMessage === 'string' ? control.validationMessage : '';

			return native ? { ...entry, message: native } : entry;
		} );

		const list: EditError[] = worded.map( ( entry ) => {
			const field = fieldTab( entry.field );
			const tabName = field ? tabLabels[ tabOf( field ) ] : undefined;

			return {
				id: 0,
				field: entry.field,
				message: tabName && tabs.length > 1 && field && tabOf( field ) !== tab.id ? `${ entry.message } (${ tabName })` : entry.message,
			};
		} );

		setErrors( list );
		setInvalidFields( worded );

		const first = worded[ 0 ] ? fieldTab( worded[ 0 ].field ) : undefined;

		if ( first && tabOf( first ) !== tab.id ) {
			setTabId( tabOf( first ) );
		}

		revealInvalidControls( formRef.current );
		// After the tab (and the error state) rendered: every invalid control is flagged, the first one gets the keyboard focus.
		setTimeout( () => {
			if ( ! mountedRef.current ) {
				return;
			}

			const controls = flagInvalidControls(
				formRef.current,
				worded.map( ( entry ) => ( { field: entry.field, label: fieldLabels[ entry.field ] ?? entry.field } ) )
			);

			if ( ! focusControl( controls[ 0 ] ?? null ) && ! focusFirstInvalidControl( formRef.current ) ) {
				focusWithin( rootRef.current, '.wc-pl-edit__errors' );
			}
		}, 0 );

		return true;
	};

	const finish = () => {
		if ( mountedRef.current ) {
			onClose();
		}
	};

	const historyAction = ( batchId: string ) =>
		settings.links.history ? { label: __( 'View in History', 'wp-woocommerce-products-list' ), url: addQueryArgs( settings.links.history, { batch: batchId } ) } : null;

	const undoAction = ( batchId: string ) => ( {
		label: __( 'Undo', 'wp-woocommerce-products-list' ),
		onClick: () => void undoBatch( batchId, { focus: captureFocusOrigin() } ),
	} );

	/**
	 * Show what blocks (or needs a yes before) this Update next to the
	 * buttons, flag the fields it names, and bring it into view with the
	 * keyboard focus on it: a bulk editor is taller than the screen and the
	 * list would otherwise appear below the fold with nothing moving.
	 */
	const reportProblems = ( list: EditError[], kind: 'errors' | 'warnings' ) => {
		if ( kind === 'errors' ) {
			setErrors( list );
		} else {
			setWarnings( list );
		}

		const flagged = new Map< string, string >();

		for ( const entry of list ) {
			if ( entry.field && ! flagged.has( entry.field ) ) {
				flagged.set( entry.field, entry.message );
			}
		}

		// A warning is a question, not a broken field: only errors flag their controls.
		if ( kind === 'warnings' ) {
			flagged.clear();
		}

		setInvalidFields( Array.from( flagged, ( [ field, message ] ) => ( { field, message } ) ) );

		setTimeout( () => {
			if ( ! mountedRef.current ) {
				return;
			}

			const root = formRef.current;

			flagInvalidControls(
				root,
				Array.from( flagged.keys() ).map( ( field ) => {
					const label = fieldLabels[ field ] ?? field;

					// A bulk numeric field is an operation select and a value input: the value is what is wrong.
					return { field, label: controlForField( root, `${ label }: value` ) ? `${ label }: value` : label };
				} )
			);
			revealNotice( rootRef.current, kind === 'errors' ? '.wc-pl-edit__errors' : '.wc-pl-edit__warnings' );
		}, 0 );
	};

	/**
	 * Run the staged tools under the Update's batch, one after the other in the order they were added. A tool
	 * that ran leaves the staged list; one that failed stays there (the next Update runs it again) and is reported.
	 */
	const runStagedTools = async ( rows: ProductListItem[], batchId: string ): Promise< { ran: number; errors: EditError[] } > => {
		const errors: EditError[] = [];
		let ran = 0;
		const ranTabs = new Set< string >();
		let reachedVariations = false;

		for ( const entry of Array.from( staged.values() ) ) {
			const ids = stagedToolIds( entry, rows, parentVariations );

			if ( ids.length === 0 ) {
				stageTool( entry.key, null );
				continue;
			}

			try {
				await runDeclarativeAction( entry.def.id, entry.def.label || entry.def.id, ids, entry.args, rowFields( allFields ), { inlineErrors: true, batchId, silent: true } );
				ran++;
				ranTabs.add( entry.tabId );
				reachedVariations ||= Boolean( parentVariations?.length ) && ids.some( ( id ) => parentVariations!.some( ( variation ) => variation.id === id ) );
				stageTool( entry.key, null );
			} catch ( reason ) {
				errors.push( {
					id: 0,
					message: `${ entry.def.label } (${ entry.tabLabel }): ${ reason instanceof Error ? reason.message : __( 'The action failed.', 'wp-woocommerce-products-list' ) }`,
				} );
			}
		}

		// The tabs whose values a tool changed load again if the editor stays open.
		if ( ranTabs.size && mountedRef.current ) {
			setLoadedTabs( ( previous ) => new Set( Array.from( previous ).filter( ( id ) => ! ranTabs.has( id ) ) ) );
		}

		// A price tool that ran on the variations left the fetched ones stale.
		if ( reachedVariations ) {
			forgetVariations( rows.filter( isVariableParent ).map( ( row ) => row.id ) );

			if ( mountedRef.current ) {
				setVariationEpoch( ( epoch ) => epoch + 1 );
			}
		}

		return { ran, errors };
	};

	/**
	 * Load again the rows someone else saved since the editor loaded them (every tab visited so far), and the
	 * variations of such variable parents, so the preview and the next Update work on the values stored now.
	 */
	const refreshStale = async ( rows: ProductListItem[] ) => {
		const wanted = Array.from( new Set( Array.from( loadedTabs ).flatMap( ( entry ) => editFetchFields( allFields, rows, mode, { tab: entry } ) ) ) ).sort();
		const { items: full } = await hydrateSelection( rows, wanted );

		if ( ! mountedRef.current ) {
			return;
		}

		patchItems( full );
		setHydrated( ( current ) => {
			const next = new Map( current );

			for ( const row of full ) {
				const known = next.get( row.id );

				next.set( row.id, known ? ( mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown > ) as ProductListItem ) : row );
			}

			return next;
		} );

		const parents = rows.filter( isVariableParent ).map( ( row ) => row.id );

		if ( applyToVariations && parents.length ) {
			forgetVariations( parents );
			setVariationEpoch( ( epoch ) => epoch + 1 );
		}
	};

	const save = async ( advance = false, implicit = false ) => {
		if ( saving || loading ) {
			return;
		}

		if ( pendingCount === 0 && stagedCount === 0 ) {
			if ( state.hasInput ) {
				notify.info( __( 'Nothing changed: the values equal the current ones.', 'wp-woocommerce-products-list' ) );
			}

			if ( advance && nextRow ) {
				carryTabToNext( tab.id );
				onAdvance( nextRow );
			} else {
				onClose();
			}

			return;
		}

		setErrors( [] );

		// A previous Update saved every field edit (only rows deleted meanwhile failed): what is left are the staged tool runs.
		const fieldsDone = failedIds !== null && failedIds.size === 0;
		const runFields = pendingCount > 0 && ! fieldsDone;

		if ( runFields ) {
			const opErrors = validateNumericOps( pendingEdits, visibleFields, settings ).map( ( error ) => ( { id: 0, ...error } ) );

			if ( opErrors.length ) {
				reportProblems( opErrors, 'errors' );

				return;
			}

			if ( blockOnValidity() ) {
				return;
			}

			if ( ! variationsReady ) {
				reportProblems( [ { id: 0, message: variations.error ?? __( 'The variations are still loading.', 'wp-woocommerce-products-list' ) } ], 'errors' );

				return;
			}

			const projected = validateBulkNumericEdits( targetsForValidation, pendingEdits, editFields, settings, rowOptions );

			if ( projected.length ) {
				reportProblems( projected, 'errors' );

				return;
			}

			if ( saleChoiceNeeded ) {
				setErrors( [
					{
						id: 0,
						message: sprintf(
							/* translators: %d: number of rows on sale now */
							_n( 'Choose what happens to the %d sale running now: replace it or skip that row.', 'Choose what happens to the %d sales running now: replace them or skip those rows.', runningSales.count, 'wp-woocommerce-products-list' ),
							runningSales.count
						),
					},
				] );
				setTimeout( () => {
					if ( mountedRef.current ) {
						focusWithin( rootRef.current, '.wc-pl-edit__sale-warning input[type="radio"]' );
					}
				}, 0 );

				return;
			}

			// Rows a decrease would push below zero are clamped; say so and ask once.
			const clamped = projectWarnings( targetsForValidation, pendingEdits, editFields, settings, rowOptions );
			const warningKey = clamped.map( ( warning ) => `${ warning.id }:${ warning.field }` ).join( '|' );

			// The yes is a press of "Update anyway" itself: an Enter in a field (or a select) shows the question again instead.
			if ( clamped.length && ( acknowledged !== warningKey || implicit ) ) {
				setWarningKind( 'clamp' );
				reportProblems(
					clamped.map( ( warning ) => ( { id: warning.id, field: warning.field, message: warning.message } ) ),
					'warnings'
				);
				setAcknowledged( warningKey );

				return;
			}
		}

		// From here on the editor works on these rows, whatever the selection does meanwhile.
		const frozenBefore = frozenRows;

		setFrozenRows( selectedRows );
		setSaving( true );
		setErrors( [] );
		setWarnings( [] );
		setProgress( { done: 0, total: 0 } );

		const names = new Map( targetsForValidation.map( ( item ) => [ item.id, nameOf( item ) ] ) );
		let failed = false;

		try {
			// Rows trashed or deleted since the editor loaded them are left out and named, not written in the Trash as if nothing happened.
			// With a relative price op the same request also brings each row's last-modified stamp: a row saved by someone
			// else meanwhile would get the op applied to a value it no longer has.
			const checkBases = runFields && bulk && hasLoadRelativeOps( pendingEdits );
			// The rows this Update writes: the field edits' (all, or the failed ones on a retry), and the staged tools' (every row).
			const checkItems = runFields ? ( stagedCount ? Array.from( new Map( [ ...retryTargets.items, ...items ].map( ( item ) => [ item.id, item ] ) ).values() ) : retryTargets.items ) : items;
			let changed: { trashed: number[]; missing: number[] } = { trashed: [], missing: [] };
			let stale: ProductListItem[] = [];

			if ( checkBases ) {
				const check = await hydrateSelection( checkItems, [ 'id', 'status', 'date_modified_gmt' ] );
				const goneNow = new Set( [ ...check.trashed, ...check.missing ] );

				changed = { trashed: check.trashed, missing: check.missing };
				stale = changedSinceLoaded(
					retryTargets.items.filter( ( item ) => ! goneNow.has( item.id ) ),
					new Map( check.items.map( ( row ) => [ row.id, row ] ) )
				);
			} else if ( bulk ) {
				changed = await recheckStatuses( checkItems );
			}

			const dropped = new Set( [ ...changed.trashed, ...changed.missing ] );
			const saveItems = dropped.size ? retryTargets.items.filter( ( item ) => ! dropped.has( item.id ) ) : retryTargets.items;
			const toolItems = dropped.size ? items.filter( ( item ) => ! dropped.has( item.id ) ) : items;

			if ( dropped.size ) {
				dropped.forEach( ( id ) => pendingRemovalRef.current.add( id ) );

				if ( mountedRef.current ) {
					const trashedSet = new Set( changed.trashed );
					const rows = checkItems.filter( ( item ) => dropped.has( item.id ) );

					setExcluded( ( current ) => ( {
						missing: [ ...current.missing, ...rows.filter( ( item ) => ! trashedSet.has( item.id ) ) ],
						trashed: [ ...current.trashed, ...rows.filter( ( item ) => trashedSet.has( item.id ) ) ],
					} ) );
				}
			}

			if ( stale.length ) {
				await refreshStale( stale );

				if ( mountedRef.current ) {
					// Nothing was written: the rows stay free to change until a save runs.
					setFrozenRows( frozenBefore );
					setWarningKind( 'stale' );
					reportProblems(
						stale.map( ( item ) => ( {
							id: item.id,
							message: __( 'Saved by someone else since this editor loaded it. The preview now uses its current values: check it, then press Update again.', 'wp-woocommerce-products-list' ),
						} ) ),
						'warnings'
					);
				}

				return;
			}

			// The field edits and the staged tool runs of one Update are one History batch: one Undo takes all of it back.
			const sharedBatch = stagedCount ? newBatchId() : undefined;
			const result: SaveResult = runFields
				? await saveEdits( saveItems, pendingEdits, editFields, {
						applyToVariations,
						source: bulk ? 'bulk' : 'quick',
						prefetchedVariations: retryTargets.prefetched,
						...( retryTargets.carriersOnly?.size ? { carriersOnly: retryTargets.carriersOnly } : {} ),
						...( sharedBatch ? { batchId: sharedBatch } : {} ),
						...rowOptions,
						onProgress: ( done, total ) => {
							if ( mountedRef.current ) {
								setProgress( { done, total } );
							}
						},
				  } )
				: { updated: [], errors: [], batchId: sharedBatch ?? '', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 };

			// Then the staged tools, in the order they were added, once the field edits all saved (a failed field edit keeps them for the retry).
			const tools = result.errors.length === 0 ? await runStagedTools( toolItems, result.batchId ) : { ran: 0, errors: [] as EditError[] };

			if ( tools.errors.length ) {
				failed = true;

				if ( mountedRef.current ) {
					// The field edits are saved: what is left is the tools that failed (Update retries them).
					setFailedIds( new Set() );
					setErrors( tools.errors );
				}

				const partial = result.updated.length > 0 || tools.ran > 0;

				notify.error( tools.errors.map( ( error ) => error.message ).join( ' ' ), {
					id: SAVED_NOTICE_ID,
					actions: partial && canUndo() ? [ undoAction( result.batchId ) ] : undefined,
				} );

				return;
			}

			const updated = result.updated.length + tools.ran;

			// What the save left out goes into the batch's audit trail as `skipped` rows (fire and forget).
			const editKeys = Object.keys( pendingEdits );
			const leftOut: SkippedItem[] = [
				...changed.trashed.map( ( id ): SkippedItem => ( { id, reason: 'trashed', fields: editKeys } ) ),
				...changed.missing.map( ( id ): SkippedItem => ( { id, reason: 'deleted', fields: editKeys } ) ),
				...( result.skippedItems ?? [] ),
			];

			if ( leftOut.length ) {
				void logSkipped( result.batchId, bulk ? 'bulk' : 'quick', leftOut );
			}

			// Rows that no longer exist cannot be retried; they leave the list once the editor closes.
			const gone = result.errors.filter( ( error ) => isGoneCode( error.code ) ).map( ( error ) => error.id );

			gone.forEach( ( id ) => pendingRemovalRef.current.add( id ) );

			// The outcome is reported even when the editor was unmounted mid-save.
			const skippedNames = dropped.size ? listNames( retryTargets.items.filter( ( item ) => dropped.has( item.id ) ) ) : '';

			if ( result.errors.length === 0 ) {
				// The rows a bulk save left out (no stock management, already on sale…) are still selected: narrow the selection to them.
				const skippedIds = bulk ? Array.from( new Set( ( result.skippedItems ?? [] ).map( ( item ) => item.id ) ) ) : [];
				const selectSkipped = skippedIds.length
					? [
							{
								label: sprintf(
									/* translators: %d: number of items the save left out */
									_n( 'Select the %d skipped', 'Select the %d skipped', skippedIds.length, 'wp-woocommerce-products-list' ),
									skippedIds.length
								),
								onClick: () => void selectRows( skippedIds ),
							},
					  ]
					: [];
				const savedActions = [
					...( updated > 0 && canUndo() ? [ undoAction( result.batchId ) ] : [] ),
					// A bulk save also links to its batch in History (what changed, revert later).
					...( updated > 0 && bulk && historyAction( result.batchId ) ? [ historyAction( result.batchId )! ] : [] ),
					...selectSkipped,
				];

				const toolsLine = tools.ran
					? sprintf(
							/* translators: %d: number of language changes (tool runs) */
							_n( '%d language change applied.', '%d language changes applied.', tools.ran, 'wp-woocommerce-products-list' ),
							tools.ran
					  )
					: '';
				const fieldsLine = runFields ? successMessage( result, { trashed: changed.trashed.length, missing: changed.missing.length, names: skippedNames } ) : '';

				notify.success( [ fieldsLine, toolsLine ].filter( Boolean ).join( ' ' ), {
					id: SAVED_NOTICE_ID,
					actions: savedActions.length ? savedActions : undefined,
				} );

				if ( advance && nextRow ) {
					if ( mountedRef.current ) {
						carryTabToNext( tab.id );
						onAdvance( nextRow );
					}
				} else {
					finish();
				}

				return;
			}

			failed = true;

			// The rows that did save can still be undone; the editor (when still up) lists the rest.
			// Who failed and why, always: the editor may be gone by now (its rows left the list mid-save), and the snackbar is then all there is.
			const history = historyAction( result.batchId );

			const partialActions = [ ...( updated > 0 && canUndo() ? [ undoAction( result.batchId ) ] : [] ), ...( history ? [ history ] : [] ) ];

			if ( mountedRef.current ) {
				// The editor lists who failed and why; the snackbar carries the counts and the Undo, and expires like any other.
				notify.info( partialFailureMessage( result, names, false ), { id: SAVED_NOTICE_ID, actions: partialActions.length ? partialActions : undefined } );
			} else {
				notify.error( partialFailureMessage( result, names ), { id: SAVED_NOTICE_ID, actions: partialActions, explicitDismiss: true } );
			}

			if ( mountedRef.current ) {
				const goneSet = new Set( gone );

				setErrorNames( names );

				// A row error about one field (a taken SKU) names that field and, in quick edit, flags its control.
				const fieldErrors = result.errors
					.filter( ( error ) => ! goneSet.has( error.id ) )
					.map( ( error ) => ( { error, field: fieldOfErrorCode( error.code ) } ) )
					.filter( ( entry ): entry is { error: ( typeof result.errors )[ number ]; field: string } => !! entry.field && visibleIds.has( entry.field ) );

				setErrors(
					result.errors.map( ( error ) => {
						const field = goneSet.has( error.id ) ? undefined : fieldOfErrorCode( error.code );

						return {
							id: error.id,
							...( field && visibleIds.has( field ) ? { field } : {} ),
							message: goneSet.has( error.id ) ? __( 'It was deleted meanwhile and was left out.', 'wp-woocommerce-products-list' ) : error.message,
						};
					} )
				);

				if ( ! bulk && fieldErrors.length ) {
					const flagged = fieldErrors.map( ( entry ) => ( { field: entry.field, message: entry.error.message } ) );

					setInvalidFields( flagged );
					setTimeout( () => {
						if ( mountedRef.current ) {
							flagInvalidControls(
								formRef.current,
								flagged.map( ( entry ) => ( { field: entry.field, label: fieldLabels[ entry.field ] ?? entry.field } ) )
							);
						}
					}, 0 );
				}
				const failedNow = new Set( result.errors.filter( ( error ) => ! goneSet.has( error.id ) ).map( ( error ) => error.id ) );

				setFailedIds( failedNow );

				// The variations fetched for the plan are stale where this save wrote some: the parents of the failed ones load
				// again (a retry resolves its relative ops on what they hold now), and so does each such parent's row (its stamp
				// moved with the save, and the retry's "changed by someone else" check compares against it).
				const carriers = new Set< number >();

				for ( const [ parentId, rows ] of variations.byParent ) {
					if ( rows.some( ( row ) => failedNow.has( row.id ) || goneSet.has( row.id ) ) ) {
						carriers.add( parentId );
					}
				}

				if ( carriers.size ) {
					forgetVariations( carriers );
					setVariationEpoch( ( epoch ) => epoch + 1 );
				}

				// A retry works on the values the rows have now, not on the ones the editor opened with: the saved rows
				// take what the server returned, and the failed rows are fetched again (a relative op resolves on that).
				setHydrated( ( current ) => {
					const next = new Map( current );

					for ( const row of result.updated ) {
						const known = next.get( row.id );

						if ( known ) {
							next.set( row.id, mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown > ) as ProductListItem );
						}
					}

					failedNow.forEach( ( id ) => next.delete( id ) );
					carriers.forEach( ( id ) => next.delete( id ) );

					return next;
				} );
			}
		} catch ( error ) {
			failed = true;

			// The open editor lists the failure next to its buttons; a snackbar only when the editor is gone (it would otherwise sit over Update until dismissed).
			if ( mountedRef.current ) {
				setErrors( [ { id: 0, message: error instanceof Error ? error.message : String( error ) } ] );
			} else {
				notify.error( error instanceof Error ? error.message : String( error ) );
			}
		} finally {
			if ( mountedRef.current ) {
				setSaving( false );

				// A failure leaves the editor open: keyboard focus goes to its report (never to <body>).
				if ( failed ) {
					setTimeout( () => {
						const root = rootRef.current;

						if ( mountedRef.current && root && ! focusWithin( root, '.wc-pl-edit__errors' ) && ! root.contains( document.activeElement ) ) {
							focusFirstControl( formRef.current );
						}
					}, 0 );
				}
			}
		}
	};

	useEffect( () => {
		saveRef.current = save;
	} );

	// Enter / Cmd+Enter asks for a save; it runs after the keystroke's own value change has rendered.
	useEffect( () => {
		if ( submitRequested ) {
			const advance = submitRequested === 'next';

			setSubmitRequested( false );
			// From the keyboard in a field: never the answer to "Update anyway?".
			void saveRef.current( advance, true );
		}
	}, [ submitRequested ] );

	// Settings typed into a language tool and not run yet count as unsaved too.
	const [ toolsDirty, setToolsDirty ] = useState( 0 );
	// After a save whose only failures were rows deleted meanwhile, what was typed is saved: nothing is left to discard.
	const savedAll = failedIds !== null && failedIds.size === 0;
	const unsavedCount = ( savedAll ? 0 : pendingCount ) + toolsDirty + stagedCount;
	const dirty = ( ! savedAll && state.hasInput && pendingCount > 0 ) || toolsDirty > 0 || stagedCount > 0;

	// A running save keeps the editor mounted: the screen does not close it when the selection or the rows change meanwhile.
	const setBusy = host.setBusy;
	useEffect( () => {
		setBusy?.( saving );
	}, [ saving, setBusy ] );

	// Leaving the page (a product link, History, Add new, a reload) with typed changes asks the browser's own question first.
	useEffect( () => {
		if ( ! dirty && ! saving ) {
			return;
		}

		const onBeforeUnload = ( event: BeforeUnloadEvent ) => {
			event.preventDefault();
			// Older browsers need a return value to show the prompt.
			event.returnValue = '';
		};

		window.addEventListener( 'beforeunload', onBeforeUnload );

		return () => window.removeEventListener( 'beforeunload', onBeforeUnload );
	}, [ dirty, saving ] );

	/**
	 * May the editor close? At once when nothing was typed; after the
	 * discard confirm otherwise; never while a save runs. Cancel, Escape,
	 * paging, sorting, filtering and another editor all go through here.
	 */
	const requestLeave = (): Promise< boolean > => {
		if ( saving ) {
			return Promise.resolve( false );
		}

		if ( ! dirty ) {
			return Promise.resolve( true );
		}

		return new Promise< boolean >( ( resolve ) => {
			// A request already waiting is answered "stay": the newer one owns the confirm.
			setLeaveRequest( ( current ) => {
				current?.resolve( false );

				return { resolve };
			} );
		} );
	};

	const leaveRef = useRef< () => Promise< boolean > >( () => Promise.resolve( true ) );

	useEffect( () => {
		leaveRef.current = requestLeave;
	} );

	useEffect( () => {
		setGuard( () => leaveRef.current() );

		return () => setGuard( null );
	}, [ setGuard ] );

	const settleLeave = ( ok: boolean ) => {
		setLeaveRequest( ( current ) => {
			current?.resolve( ok );

			return null;
		} );
	};

	const requestClose = () => {
		void requestLeave().then( ( ok ) => {
			if ( ok && mountedRef.current ) {
				onClose();
			}
		} );
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLFormElement > ) => {
		if ( event.target instanceof HTMLSelectElement && opensSelect( event ) ) {
			openSelectRef.current = event.target;
		}

		if ( event.key === 'Escape' ) {
			const openSelect = openSelectRef.current;

			// The Escape that closes a select's dropdown closes only that.
			openSelectRef.current = null;

			// A control that used Escape itself (a closed picker, a native select's dropdown) keeps it; otherwise the editor closes, after a confirm when dirty.
			if ( event.defaultPrevented || escapeBelongsToControl( event.target, openSelect ) ) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			requestClose();

			return;
		}

		if ( event.key !== 'Enter' || event.altKey ) {
			return;
		}

		const modifier = event.metaKey || event.ctrlKey;

		// Plain Enter in a single-line field updates, as in the classic quick edit; Cmd/Ctrl+Enter from anywhere (a textarea too).
		// Shift+Enter (or Shift+Cmd+Enter) updates and moves on to the next row.
		if ( ! modifier && ! isTextEntry( event.target ) ) {
			// Chrome submits the form on Enter in a closed <select>, a checkbox or a radio (implicit submission); here that
			// would save the whole edit, and answer a pending "Update anyway?" with yes. Only a button (and a textarea, a
			// link) keeps its own Enter.
			if ( blocksImplicitSubmit( event.target ) ) {
				event.preventDefault();
			}

			return;
		}

		event.preventDefault();

		if ( event.shiftKey && ! nextRow ) {
			return;
		}

		setSubmitRequested( event.shiftKey ? 'next' : 'save' );
	};

	const onTabKeyDown = ( event: KeyboardEvent< HTMLDivElement > ) => {
		const index = tabs.findIndex( ( entry ) => entry.id === tab.id );
		let next = index;

		switch ( event.key ) {
			case 'ArrowRight':
				next = ( index + 1 ) % tabs.length;
				break;
			case 'ArrowLeft':
				next = ( index - 1 + tabs.length ) % tabs.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = tabs.length - 1;
				break;
			default:
				return;
		}

		event.preventDefault();

		const target = tabs[ next ];

		if ( target ) {
			setTabId( target.id );
			( event.currentTarget.querySelector( `[data-tab="${ target.id }"]` ) as HTMLElement | null )?.focus();
		}
	};

	const sellableShown = visibleFields.some( isSellableField );

	const variationNote = ( () => {
		if ( ! applyToVariations ) {
			// Prices show for the rest of the selection; say who they skip and how to include them.
			return sellableShown ? (
				<span className="wc-pl-edit__note">
					{ sprintf(
						/* translators: %d: number of variable products */
						_n(
							'Price and sale fields apply to the other selected items and skip the %d variable product (its variations hold the prices). Tick the box to include all its variations.',
							'Price and sale fields apply to the other selected items and skip the %d variable products (their variations hold the prices). Tick the box to include all their variations.',
							variableParents.length,
							'wp-woocommerce-products-list'
						),
						variableParents.length
					) }
				</span>
			) : null;
		}

		if ( variations.status === 'loading' ) {
			return (
				<span className="wc-pl-edit__note">
					<Spinner /> { __( 'Loading variations…', 'wp-woocommerce-products-list' ) }
				</span>
			);
		}

		if ( variations.status === 'error' ) {
			return <span className="wc-pl-edit__note">{ variations.error }</span>;
		}

		if ( variations.status === 'loaded' ) {
			return (
				<span className="wc-pl-edit__note">
					{ sprintf(
						/* translators: 1: number of variations, 2: number of variable products */
						__( 'Price and sale fields will apply to %1$d variations of %2$d variable products.', 'wp-woocommerce-products-list' ),
						variations.count,
						variableParents.length
					) }
				</span>
			);
		}

		return null;
	} )();

	// wc/v3's batch routes need edit_others_products (woocommerce_rest_cannot_batch);
	// one row goes through POST products/{id} instead (api/client.ts), several cannot.
	const needsEditOthers = ! settings.caps.editOthers && ( items.length > 1 || applyToVariations );
	const retryable = failedIds ? failedIds.size : 0;
	// Staged tools a failed Update left are still to run: Update retries them.
	const failedButNothingToRetry = failedIds !== null && retryable === 0 && stagedCount === 0;
	const nothingToWrite = plan !== null && plan.writes.length === 0;
	// The list of rows is fixed once a save has run.
	const listFrozen = frozenRows !== null;

	const saveLabel = ( () => {
		if ( saving ) {
			return __( 'Updating…', 'wp-woocommerce-products-list' );
		}

		if ( failedButNothingToRetry ) {
			return __( 'Close', 'wp-woocommerce-products-list' );
		}

		if ( failedIds && retryable === 0 ) {
			/* translators: %d: number of language changes still to run */
			return sprintf( _n( 'Retry %d language change', 'Retry %d language changes', stagedCount, 'wp-woocommerce-products-list' ), stagedCount );
		}

		if ( failedIds ) {
			/* translators: %d: number of rows that failed */
			return sprintf( _n( 'Retry %d failed', 'Retry %d failed', retryable, 'wp-woocommerce-products-list' ), retryable );
		}

		if ( warnings.length && warningKind === 'clamp' ) {
			return __( 'Update anyway', 'wp-woocommerce-products-list' );
		}

		if ( ! bulk ) {
			return __( 'Update', 'wp-woocommerce-products-list' );
		}

		// The staged tool runs go with the Update and say so on its button.
		const withTools = ( label: string ) =>
			stagedCount
				? sprintf(
						/* translators: 1: "Update N items", 2: number of language changes (tool runs) */
						_n( '%1$s + %2$d language change', '%1$s + %2$d language changes', stagedCount, 'wp-woocommerce-products-list' ),
						label,
						stagedCount
				  )
				: label;

		if ( pendingCount === 0 && stagedCount > 0 ) {
			/* translators: %d: number of language changes (tool runs) */
			return sprintf( _n( 'Apply %d language change', 'Apply %d language changes', stagedCount, 'wp-woocommerce-products-list' ), stagedCount );
		}

		if ( plan ) {
			const base = withTools( saveLabelFor( plan ) );

			// Replacing sales that run now ends them on save: the button says how many, counted on the rows the plan really writes
			// (the "only where it gets cheaper" guard and the other skip rules leave some running).
			const ending = plan.endedRunningSales ?? 0;

			return saleChoice === 'replace' && ending > 0 && plan.writes.length > 0
				? sprintf(
						/* translators: 1: "Update N items", 2: number of sales running now */
						_n( '%1$s, ending %2$d running sale', '%1$s, ending %2$d running sales', ending, 'wp-woocommerce-products-list' ),
						base,
						ending
				  )
				: base;
		}

		/* translators: %d: number of rows */
		return withTools( sprintf( _n( 'Update %d item', 'Update %d items', items.length, 'wp-woocommerce-products-list' ), items.length ) );
	} )();

	// Busy buttons stay focusable (a disabled button drops keyboard focus to <body>); the handlers ignore the extra press.
	const saveBlocked = saving || loading || needsEditOthers || ( ! failedButNothingToRetry && stagedCount === 0 && ( ( pendingCount === 0 && ! state.hasInput ) || nothingToWrite ) );
	const showNext = ! bulk && nextRow !== null && ! failedIds;
	// "Save & next" with nothing typed just moves on; with edits it saves them first.
	const nextBlocked = saving || loading || needsEditOthers || nothingToWrite;

	const title = bulk
		? sprintf(
				/* translators: %d: number of rows */
				_n( 'Bulk edit %d item', 'Bulk edit %d items', items.length, 'wp-woocommerce-products-list' ),
				items.length
		  )
		: __( 'Quick edit', 'wp-woocommerce-products-list' );

	const listed = items.slice( 0, ITEMS_LISTED );

	// Always in the layout (hidden once loaded) and beside the title, never above the fields: the form does not move when the values arrive, so a fast first click lands where it was aimed.
	const loadingLine = (
		<span className={ `wc-pl-inline-edit__loading${ tabReady ? ' is-done' : '' }` } role="status" aria-hidden={ tabReady || undefined }>
			{ tabReady ? null : (
				<>
					<Spinner /> { __( 'Loading current values…', 'wp-woocommerce-products-list' ) }
				</>
			) }
		</span>
	);

	return (
		<form
			ref={ rootRef }
			className={ `wc-pl-edit wc-pl-inline-edit is-${ mode }` }
			aria-busy={ saving }
			tabIndex={ -1 }
			// The browser's own constraint check would swallow the submit while a control is
			// invalid (and leave the previous attempt's problem list standing); Update runs the
			// rules itself on every attempt, names each problem and moves focus to the first.
			noValidate
			onKeyDown={ onKeyDown }
			// Which native select has its dropdown open: pressed open, closed again by a pick or by leaving it.
			onMouseDown={ ( event ) => {
				openSelectRef.current = event.target instanceof HTMLSelectElement && openSelectRef.current !== event.target ? event.target : null;
			} }
			onChange={ ( event ) => {
				if ( event.target === openSelectRef.current ) {
					openSelectRef.current = null;
				}
			} }
			onBlur={ ( event ) => {
				if ( ( event.target as EventTarget ) === openSelectRef.current ) {
					openSelectRef.current = null;
				}
			} }
			onSubmit={ ( event ) => {
				event.preventDefault();

				if ( saving ) {
					return;
				}

				if ( failedButNothingToRetry ) {
					finish();

					return;
				}

				// The submit button itself (a click, or Enter / Space on it): implicit submission from the fields is stopped in onKeyDown.
				void save();
			} }
		>
			{ bulk ? (
				<div className="wc-pl-inline-edit__items">
					<h2 className="wc-pl-inline-edit__title">{ title }</h2>
					{ loadingLine }
					{ items.length > 1 ? <p className="wc-pl-edit__summary">{ breakdown( items ) }</p> : null }
					{ wholeList ? (
						<p className="wc-pl-inline-edit__whole">
							{ sprintf(
								/* translators: %d: number of products */
								_n( 'Every product in the list (%d) is selected.', 'Every product in the list (%d) is selected.', items.length, 'wp-woocommerce-products-list' ),
								items.length
							) }
						</p>
					) : (
						<>
							{ offPageCount > 0 ? (
								<p className="wc-pl-inline-edit__whole">
									{ sprintf(
										/* translators: %d: number of selected rows not shown in the current list view */
										_n( '%d of them is not in this view.', '%d of them are not in this view.', offPageCount, 'wp-woocommerce-products-list' ),
										offPageCount
									) }
								</p>
							) : null }
							<ul ref={ itemListRef } className="wc-pl-inline-edit__list" aria-label={ __( 'Selected items', 'wp-woocommerce-products-list' ) }>
								{ listed.map( ( item, index ) => {
									const kind = kindLabel( item, settings.productTypes );
									const parentName = parentNameOf( item );
									const sku = skuOf( item );
									const label = nameOf( item );

									return (
										<li key={ item.id } className="wc-pl-inline-edit__item">
											<span className="wc-pl-inline-edit__item-text" title={ sku ? `${ label } · ${ sku }` : label }>
												{ parentName ? <span className="wc-pl-inline-edit__item-parent">{ parentName }</span> : null }
												<span className="wc-pl-inline-edit__item-name">{ parentName ? shortNameOf( item ) : label }</span>
												{ sku ? <span className="wc-pl-inline-edit__item-sku">{ sku }</span> : null }
											</span>
											{ kind ? <span className="wc-pl-inline-edit__item-kind">{ kind }</span> : null }
											{ ! listFrozen ? (
												<button
													type="button"
													className="wc-pl-inline-edit__item-remove"
													aria-label={ sprintf(
														/* translators: %s: product name */
														__( 'Remove %s from the selection', 'wp-woocommerce-products-list' ),
														nameOf( item )
													) }
													disabled={ saving }
													onClick={ () => {
														removedIndexRef.current = index;
														onRemoveItem( item.id );
													} }
												>
													<Icon icon={ closeSmall } size={ 20 } />
												</button>
											) : null }
										</li>
									);
								} ) }
							</ul>
							{ items.length > listed.length ? (
								<p className="wc-pl-inline-edit__more">
									{ sprintf(
										/* translators: %d: number of rows not listed */
										__( '…and %d more', 'wp-woocommerce-products-list' ),
										items.length - listed.length
									) }
								</p>
							) : null }
						</>
					) }
				</div>
			) : null }

			<div className="wc-pl-inline-edit__main">
				{ ! bulk ? (
					<div className="wc-pl-inline-edit__head">
						<h2 className="wc-pl-inline-edit__title">
							{ title }
							{ items[ 0 ] ? <span className="wc-pl-inline-edit__name">{ nameOf( items[ 0 ] ) }</span> : null }
						</h2>
						{ loadingLine }
					</div>
				) : null }

				{ needsEditOthers ? (
					<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice">
						{ __( 'Saving several items at once needs the "edit others\' products" capability. Edit one item at a time, or ask an administrator.', 'wp-woocommerce-products-list' ) }
					</Notice>
				) : null }

				{ excluded.missing.length > 0 ? (
					<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice">
						{ sprintf(
							/* translators: 1: number of rows, 2: their names */
							_n( '%1$d of the selected items no longer exists and was left out: %2$s', '%1$d of the selected items no longer exist and were left out: %2$s', excluded.missing.length, 'wp-woocommerce-products-list' ),
							excluded.missing.length,
							listNames( excluded.missing )
						) }
					</Notice>
				) : null }

				{ excluded.trashed.length > 0 ? (
					<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice">
						{ sprintf(
							/* translators: 1: number of rows, 2: their names */
							_n( '%1$d of the selected items was moved to the Trash meanwhile and was left out: %2$s', '%1$d of the selected items were moved to the Trash meanwhile and were left out: %2$s', excluded.trashed.length, 'wp-woocommerce-products-list' ),
							excluded.trashed.length,
							listNames( excluded.trashed )
						) }
					</Notice>
				) : null }

				{ trashedRows.length > 0 ? (
					<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice">
						{ sprintf(
							/* translators: 1: number of rows in the trash, 2: their names */
							_n( '%1$d of the selected items is in the trash and will be updated too: %2$s', '%1$d of the selected items are in the trash and will be updated too: %2$s', trashedRows.length, 'wp-woocommerce-products-list' ),
							trashedRows.length,
							listNames( trashedRows )
						) }
					</Notice>
				) : null }

				{ variableParents.length > 0 ? (
					<div className="wc-pl-edit__options">
						<CheckboxControl
							__nextHasNoMarginBottom
							label={ __( 'Apply price and sale fields to all variations of the selected variable products', 'wp-woocommerce-products-list' ) }
							checked={ applyToVariations }
							disabled={ saving }
							onChange={ ( checked ) => {
								setApplyToVariations( checked );
								setErrors( [] );
								setWarnings( [] );
								setAcknowledged( null );
							} }
						/>
						{ variationNote }
					</div>
				) : null }

				{ tabs.length > 1 ? (
					<div className="wc-pl-edit__tabs" role="tablist" aria-label={ __( 'Edit sections', 'wp-woocommerce-products-list' ) } onKeyDown={ onTabKeyDown }>
						{ tabs.map( ( entry ) => {
							const selectedTab = entry.id === tab.id;

							return (
								<button
									key={ entry.id }
									type="button"
									role="tab"
									id={ `wc-pl-edit-tab-${ entry.id }` }
									data-tab={ entry.id }
									aria-selected={ selectedTab }
									aria-controls={ PANEL_ID }
									tabIndex={ selectedTab ? 0 : -1 }
									className={ `components-button is-tertiary wc-pl-edit__tab${ selectedTab ? ' is-active' : '' }` }
									onClick={ () => setTabId( entry.id ) }
								>
									{ entry.label }
									{ fieldsOfTab( visibleFields, entry ).some( ( field ) => field.id in pendingEdits ) ? ' •' : '' }
								</button>
							);
						} ) }
					</div>
				) : null }

				{ /* Mounted through the tab's reload after a run, so what was typed into a tool stays. */ }
				{ tab.id.includes( ':' ) && ! loading ? (
					<LanguageTools
						tabId={ tab.id }
						tabLabel={ tab.label }
						items={ items }
						settings={ settings }
						fields={ allFields }
						disabled={ saving }
						onDirtyChange={ setToolsDirty }
						applyToVariations={ applyToVariations }
						parentVariations={ parentVariations }
						defaultOpen={ bulk }
						// The tools run with Update, in its batch: one save model, one Undo.
						stage={ stageTool }
						staged={ staged }
						// A failure shows inline under the tool, not as a snackbar that outlives it.
						run={ ( def, ids, args ) => runDeclarativeAction( def.id, def.label || def.id, ids, args, rowFields( allFields ), { inlineErrors: true } ) }
						onDone={ () => {
							if ( mountedRef.current ) {
								// The tab's values reload: the copied (or cleared) texts show in the form.
								setLoadedTabs( ( previous ) => new Set( Array.from( previous ).filter( ( id ) => id !== tab.id ) ) );
							}
						} }
					/>
				) : null }

				<div
					ref={ formRef }
					id={ PANEL_ID }
					className="wc-pl-edit__form"
					role={ tabs.length > 1 ? 'tabpanel' : undefined }
					aria-labelledby={ tabs.length > 1 ? `wc-pl-edit-tab-${ tab.id }` : undefined }
					aria-busy={ ! tabReady }
				>
					{ ! formShown ? (
						<p>{ __( 'The selected rows share no editable fields.', 'wp-woocommerce-products-list' ) }</p>
					) : (
						<DataForm< FormData > data={ state.data } fields={ formFields } form={ form } onChange={ onChange } validity={ validity } />
					) }
				</div>

				{ stockGated.length > 0 && ! loading ? (
					<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice wc-pl-edit__stock-warning">
						{ sprintf(
							/* translators: 1: number of rows, 2: number of rows in total, 3: their names */
							_n(
								'%1$d of the %2$d rows does not manage stock, so WooCommerce ignores Quantity, Low stock threshold and Backorders for it; it will be skipped: %3$s',
								'%1$d of the %2$d rows do not manage stock, so WooCommerce ignores Quantity, Low stock threshold and Backorders for them; they will be skipped: %3$s',
								stockGated.length,
								'wp-woocommerce-products-list'
							),
							stockGated.length,
							targetsForValidation.filter( ( item ) => ! item._placeholder ).length,
							listNames( stockGated )
						) }
						{ stockEnableable.length > 0 ? (
							<CheckboxControl
								__nextHasNoMarginBottom
								label={
									stockEnableable.length === stockGated.length
										? sprintf(
												/* translators: %d: number of rows */
												_n( 'Turn on "Manage stock" for that row and write the values', 'Turn on "Manage stock" for those %d rows and write the values', stockEnableable.length, 'wp-woocommerce-products-list' ),
												stockEnableable.length
										  )
										: sprintf(
												/* translators: %d: number of rows */
												_n( 'Turn on "Manage stock" for %d of them and write the values (variable products stay skipped: their variations hold the stock)', 'Turn on "Manage stock" for %d of them and write the values (variable products stay skipped: their variations hold the stock)', stockEnableable.length, 'wp-woocommerce-products-list' ),
												stockEnableable.length
										  )
								}
								checked={ enableManageStock }
								disabled={ saving }
								onChange={ ( checked ) => {
									setEnableManageStock( checked );
									setErrors( [] );
									setWarnings( [] );
									setAcknowledged( null );
								} }
							/>
						) : null }
					</Notice>
				) : null }

				{ existingSales.rows.length > 0 && ! loading ? (
					<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice wc-pl-edit__sale-warning">
						<p>
							{ sprintf(
								/* translators: 1: number of rows with a sale, 2: number of rows in total */
								_n( '%1$d of the %2$d rows already has a sale price.', '%1$d of the %2$d rows already have a sale price.', existingSales.rows.length, 'wp-woocommerce-products-list' ),
								existingSales.rows.length,
								targetsForValidation.filter( ( item ) => ! item._placeholder && ! isVariableParent( item ) ).length
							) }{ ' ' }
							{ runningSales.count > 0 ? runningSales.message : null }
						</p>
						<RadioControl
							className="wc-pl-edit__sale-choice"
							label={ __( 'Existing sales', 'wp-woocommerce-products-list' ) }
							selected={ saleChoice ?? ( runningSales.count > 0 ? '' : 'replace' ) }
							options={ [
								{
									value: 'replace',
									label:
										runningSales.count > 0
											? sprintf(
													/* translators: %d: number of rows on sale now */
													_n( 'Replace them (the %d sale running now ends when you update)', 'Replace them (the %d sales running now end when you update)', runningSales.count, 'wp-woocommerce-products-list' ),
													runningSales.count
											  )
											: __( 'Replace them', 'wp-woocommerce-products-list' ),
								},
								{
									value: 'skip',
									label: sprintf(
										/* translators: %d: number of rows */
										_n( 'Skip the %d row that already has a sale', 'Skip the %d rows that already have a sale', existingSales.rows.length, 'wp-woocommerce-products-list' ),
										existingSales.rows.length
									),
								},
							] }
							onChange={ ( value: string ) => {
								setSaleChoice( value === 'skip' ? 'skip' : 'replace' );
								setErrors( [] );
								setWarnings( [] );
								setAcknowledged( null );
							} }
							disabled={ saving }
						/>
					</Notice>
				) : null }

				{ bulk && plannedEdits.sale_price !== undefined && ! loading ? (
					<div className="wc-pl-edit__options">
						<CheckboxControl
							__nextHasNoMarginBottom
							label={ __( 'Only where the new sale price is lower than the price the item sells at now', 'wp-woocommerce-products-list' ) }
							checked={ onlyLowerSale }
							disabled={ saving }
							onChange={ ( checked ) => {
								setOnlyLowerSale( checked );
								setErrors( [] );
								setWarnings( [] );
								setAcknowledged( null );
							} }
						/>
					</div>
				) : null }

				{ bulk && plannedCount > 0 && ! loading ? (
					<ChangeSummary edits={ plannedEdits } fields={ editFields } targets={ targetsForValidation } settings={ settings } applyToVariations={ applyToVariations } options={ rowOptions } unchanged={ plan?.unchanged ?? 0 } />
				) : null }

				{ warnings.length > 0 ? (
					<EditErrors
						errors={ warnings }
						items={ targetsForValidation }
						fieldLabels={ fieldLabels }
						status="warning"
						className="wc-pl-edit__warnings"
						title={
							warningKind === 'stale'
								? sprintf(
										/* translators: %d: number of rows */
										_n( '%d row changed since this editor loaded it', '%d rows changed since this editor loaded them', warnings.length, 'wp-woocommerce-products-list' ),
										warnings.length
								  )
								: sprintf(
										/* translators: %d: number of rows */
										_n( '%d row would go below zero. Update anyway?', '%d rows would go below zero. Update anyway?', warnings.length, 'wp-woocommerce-products-list' ),
										warnings.length
								  )
						}
					/>
				) : null }

				{ stagedCount ? (
					<div className="wc-pl-edit__staged">
						<strong>{ __( 'Also saved with Update:', 'wp-woocommerce-products-list' ) }</strong>
						<ul>
							{ Array.from( staged.values() ).map( ( entry ) => {
								const count = stagedToolIds( entry, items, parentVariations ).length;

								return (
									<li key={ entry.key }>
										{ parentVariations?.length
											? sprintf(
													/* translators: 1: tool label, 2: language, 3: what it runs on, e.g. "606 variations of 28 products" */
													__( '%1$s (%2$s) on %3$s', 'wp-woocommerce-products-list' ),
													entry.def.label,
													entry.tabLabel,
													toolTargetsLabel( entry.def, items, parentVariations )
											  )
											: sprintf(
													/* translators: 1: tool label, 2: language, 3: number of items */
													_n( '%1$s (%2$s) on %3$d item', '%1$s (%2$s) on %3$d items', count, 'wp-woocommerce-products-list' ),
													entry.def.label,
													entry.tabLabel,
													count
											  ) }{ ' ' }
										<Button variant="link" disabled={ saving } onClick={ () => stageTool( entry.key, null ) }>
											{ __( 'Take it out', 'wp-woocommerce-products-list' ) }
										</Button>
									</li>
								);
							} ) }
						</ul>
					</div>
				) : null }
				<EditErrors errors={ errors } items={ targetsForValidation } names={ errorNames } fieldLabels={ fieldLabels } onFocusField={ focusField } />
				<div hidden>
					{ invalidFields.map( ( entry ) => (
						<span key={ entry.field } id={ invalidMessageId( entry.field ) }>
							{ entry.message }
						</span>
					) ) }
				</div>

				<div className="wc-pl-edit__footer">
					<Button type="submit" variant="primary" isBusy={ saving } aria-disabled={ saveBlocked } disabled={ saveBlocked && ! saving } __next40pxDefaultSize>
						{ saveLabel }
					</Button>
					<Button type="button" variant="tertiary" onClick={ requestClose } aria-disabled={ saving } __next40pxDefaultSize>
						{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
					</Button>
					{ showNext ? (
						<Button
							type="button"
							variant="secondary"
							aria-disabled={ nextBlocked }
							onClick={ () => {
								if ( ! nextBlocked ) {
									void save( true );
								}
							} }
							aria-keyshortcuts="Shift+Enter"
							__next40pxDefaultSize
						>
							{ __( 'Update & next', 'wp-woocommerce-products-list' ) }
							<kbd className="wc-pl-edit__shortcut" aria-hidden="true">
								{
									/* translators: keyboard shortcut for "Update & next" */
									__( 'Shift+Enter', 'wp-woocommerce-products-list' )
								}
							</kbd>
						</Button>
					) : null }
					<SaveProgress done={ progress.done } total={ progress.total } saving={ saving } />
				</div>
			</div>

			{ leaveRequest ? (
				<ConfirmDialog
					isOpen
					confirmButtonText={ __( 'Discard changes', 'wp-woocommerce-products-list' ) }
					cancelButtonText={ __( 'Keep editing', 'wp-woocommerce-products-list' ) }
					onConfirm={ () => settleLeave( true ) }
					onCancel={ () => settleLeave( false ) }
				>
					{ sprintf(
						/* translators: %d: number of changed fields */
						_n( 'Discard %d unsaved change?', 'Discard %d unsaved changes?', unsavedCount, 'wp-woocommerce-products-list' ),
						unsavedCount
					) }
				</ConfirmDialog>
			) : null }
		</form>
	);
}

export default InlineEditor;
