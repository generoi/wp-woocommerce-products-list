/**
 * Quick edit (one row) and bulk edit (many rows) in a panel that slides in
 * beside the list, like the quick edit of WooCommerce's DataViews product
 * list (edit/editor-panel.tsx hosts it): the table stays in view with the
 * edited row marked and the selection ticked. Edits stay local until Update;
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
import { Button, Notice, ProgressBar, RadioControl, Spinner, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { CheckboxControl } from '../ui/checkbox-control';
import { outcomeNoticeId } from '../ui/notices';
import { createPortal, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { addQueryArgs } from '@wordpress/url';
import { closeSmall, Icon } from '@wordpress/icons';
import type { KeyboardEvent } from 'react';
import { batchProducts, closeBatch, getVariations, logSkipped, newBatchId, toRow } from '../api/client';
import type { SkippedItem } from '../api/client';
import { DataForm, useFormValidity } from '../dataviews';
import { getSettings } from '../settings';
import { patchItems, removeItems } from '../store/products';
import { getCurrentRows } from '../store/rows';
import { beginSaveJob, finishSaveJob } from '../store/save-activity';
import type { ProductField, ProductListItem, QuickEditTab, Settings } from '../types';
import { isBatchItemError } from '../types';
import { rowFields } from '../actions/context';
import { runDeclarativeAction } from '../actions/index';
import { notify } from '../actions/notices';
import { fetchAllVariations, VARIATION_FETCH_CONCURRENCY, variationFetchFields } from './apply-to-variations';
import { withArrayOps } from './bulk-array';
import { carriesViewText, EDIT_CONTEXT_KEYS, editFetchFields, hydrateSelection, mergeHydrated, recheckBases, recheckStatuses, rootKeysOf, tabFetchFields } from './hydrate';
import { changedSinceShown, pathsOfEdit, rowCarries, ShownValues } from './shown-values';
import type { ChangedField } from './shown-values';
import { getVariationsOfParents } from './variations-read';
import { DONT_CHANGE, hasLoadRelativeOps, isNumericOp, isPendingOp, lowersPrice, parseNumeric, projectWarnings, validateBulkNumericEdits, validateNumericOps } from './bulk-numeric';
import { ChangeSummary, describeSiteDateTime, describeValue } from './change-summary';
import { formatPrice } from '../fields/currency';
import type { EditorHost } from './editor-context';
import { measureEditorReady } from './editor-panel';
import { editorConflictMessage, fieldOfErrorCode, isConflictCode, isGoneCode, isServerLoggedCode } from './errors';
import { itemLabel, parentNameOf, shortNameOf, skuOf } from './item-label';
import { LanguageTools, stagedToolIds, toolTargetsLabel } from './language-tools';
import type { StagedTool } from './language-tools';
import { editTypeOf, isVariableParent, isVariation, parentIdOf } from './field-value';
import { captureFocusOrigin, focusWithin, restoreFocus } from './focus';
import { APPLY_TO_VARIATIONS_FIELD_ID, buildInlineForm, buildTabs, fieldsOfTab, formLabelOf, GENERAL_TAB_ID, layoutGroupOf, sectionNoteFieldId, tabOf, withScheduleSale } from './form-layouts';
import { ApplyControlContext, applyControlField, sectionNoteField, SectionNotesContext } from './apply-control';
import type { ApplyControlState } from './apply-control';
import { labelsOf, stockStatusTakers, toFormFields } from './form-fields';
import type { FormData } from './form-fields';
import { EditErrors, SaveProgress } from './progress';
import type { EditError } from './progress';
import { canEnableStock, managesStock, rowsWithExistingSale, saleIsActive, stockGatedRows } from './row-rules';
import type { RowEditOptions } from './row-rules';
import { saveEdits, saveFields } from './save';
import { resetHtmlEditorMode } from './html-text-control';
import { TranslationGrid, TranslationStore, translationWriteItem } from './translation-grid';
import type { SaveResult } from './save';
import { planSave, runConcurrently, UNCERTAIN_CODE } from './save-runner';
import type { SavePlan } from './save-runner';
import { undoBatch } from './undo';
import { canUndo } from './log-access';
import { selectRows } from '../list/selection';
import { useEditState } from './use-edit-state';
import { saleScheduleProblems } from './sale-schedule';
import { clearFlaggedControls, collectInvalidFields, controlForField, flagInvalidControls, focusControl, focusFirstInvalidControl, invalidMessageId, revealInvalidControls, validateFormData } from './validity';
import type { InvalidField, ValidatedField } from './validity';
import { isSellableField, visibleEditFields } from './visibility';
import { useFormColumns } from './use-form-columns';

export interface InlineEditorProps {
	host: EditorHost;
}

type VariationLoad = { status: 'idle' | 'loading' | 'loaded' | 'error'; byParent: Map< number, ProductListItem[] >; count: number; error?: string };

const IDLE_LOAD: VariationLoad = { status: 'idle', byParent: new Map(), count: 0 };

const PANEL_ID = 'wc-pl-edit-panel';

/**
 * The snackbar after a plain save: one at a time, a new save replaces the
 * previous one's Undo. A save that failed in part, or held rows back, with
 * its panel closed gets its own id instead (outcomeNoticeId): that notice is
 * all there is about its failed rows, and a later save must not replace it.
 */
export const SAVED_NOTICE_ID = 'wc-pl-saved';

/**
 * The tab a quick edit opens on is remembered: switching to another product
 * or reloading the page keeps the last tab the user was on (fixing Swedish
 * names product after product stays on Svenska). A bulk edit opens on
 * General (prices, stock, categories: what a bulk edit is for) and leaves
 * the quick edits' tab alone. A list filtered on a translation ("Missing in
 * Svenska") still opens on that language. "Update & next" hands its tab
 * over explicitly as well.
 */
const REMEMBERED_TAB_KEY = 'wcProductsList.editorTab';

let carriedTab: string | null = null;
let rememberedTab: string | null = null;

function readRememberedTab(): string | null {
	try {
		return window.sessionStorage.getItem( REMEMBERED_TAB_KEY );
	} catch {
		// Private mode or blocked storage: the in-memory value covers this page.
		return rememberedTab;
	}
}

/** Remember the tab the user is on, for the next editor (this page and reloads in this browser tab). */
export function rememberTab( tab: string ): void {
	rememberedTab = tab;

	try {
		window.sessionStorage.setItem( REMEMBERED_TAB_KEY, tab );
	} catch {
		// Private mode or blocked storage: the in-memory value still covers this page.
	}
}

/** Hand the open tab to the editor "Update & next" opens next. */
export function carryTabToNext( tab: string ): void {
	carriedTab = tab;
}

/**
 * The tab a new editor opens on: the filter's language, else the tab carried
 * by "Update & next", else (quick edit) the last tab used, else General. A
 * remembered tab the editor does not have (an extension tab) falls back to
 * the first tab.
 */
export function openingTab( initialTab: string | undefined | null, mode: 'quick' | 'bulk' = 'quick' ): string {
	const carried = carriedTab;

	carriedTab = null;

	if ( mode === 'bulk' ) {
		return initialTab ?? GENERAL_TAB_ID;
	}

	return initialTab ?? carried ?? readRememberedTab() ?? GENERAL_TAB_ID;
}

/** How many item names a notice lists before "and N more". */
const NAMES_SHOWN = 5;

/** Up to how many selected items the bulk editor's list starts open. */
export const ITEMS_OPEN_MAX = 5;

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

	// The panel's body brings the field into view (clear of its sticky footer, `scroll-padding`); the list behind it stays put.
	first?.focus();
}

/**
 * Run `then` with a control once it can take focus: a control in a
 * collapsed card (its content is `hidden="until-found"`) opens that card
 * first, which takes a render or two.
 */
function whenControlShown( find: () => HTMLElement | null, then: ( control: HTMLElement | null ) => void, tries = 10 ): void {
	const control = find();
	// The card's own toggle, so DataForm keeps track of it being open (the user can close it again).
	const toggle = control?.closest( '.dataforms-layouts-card__field' )?.querySelector< HTMLElement >( ':scope > [aria-expanded="false"], :scope > * > [aria-expanded="false"]' );

	if ( control && ( toggle || control.closest( '[hidden]' ) ) && tries > 0 ) {
		toggle?.click();
		setTimeout( () => whenControlShown( find, then, tries - 1 ), 30 );

		return;
	}

	then( control );
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
 * What the variations a price edit reaches cost now: "Regular price now
 * 119,00 €–139,00 €; 5 are on sale." (empty when none has a price), so a
 * campaign on all of a product's variations starts from their prices.
 */
export function variationPriceRange( rows: ProductListItem[], settings: Settings, now: number = Date.now() ): string {
	const regular = rows
		.filter( ( row ) => ! row._placeholder )
		.map( ( row ) => parseNumeric( ( row as { regular_price?: unknown } ).regular_price, settings ) )
		.filter( ( value ): value is number => value !== undefined );

	if ( regular.length === 0 ) {
		return '';
	}

	const low = Math.min( ...regular );
	const high = Math.max( ...regular );
	/* translators: 1: lowest price, 2: highest price */
	const span = low === high ? formatPrice( low, settings ) : sprintf( __( '%1$s–%2$s', 'wp-woocommerce-products-list' ), formatPrice( low, settings ), formatPrice( high, settings ) );
	const onSale = rows.filter( ( row ) => ! row._placeholder && saleIsActive( row, now ) ).length;

	return onSale
		? sprintf(
				/* translators: 1: a price or a price range, 2: number of variations on sale now */
				_n( 'Regular price now %1$s; %2$d is on sale.', 'Regular price now %1$s; %2$d are on sale.', onSale, 'wp-woocommerce-products-list' ),
				span,
				onSale
		  )
		: sprintf(
				/* translators: %s: a price or a price range */
				__( 'Regular price now %s.', 'wp-woocommerce-products-list' ),
				span
		  );
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
	const { session, fields: allFields, items: hostItems, close: onClose, advance: onAdvance, removeItem: onRemoveItem, setGuard, offPageCount, wholeList, headerSlot } = host;
	const settings = getSettings();
	// Each editor opens its HTML fields in Visual: Code stays only for the editor it was picked in (runs before the fields render).
	useState( () => {
		resetHtmlEditorMode();

		return null;
	} );
	const bulk = session.mode === 'bulk';
	const mode = bulk ? 'bulk' : 'quick';
	const initialTab = session.initialTab;
	// The rows to edit: the live selection (bulk) or the one row, until the first save: from then on the rows that save had.
	const liveRows = useMemo( () => hostItems.filter( ( item ) => ! item._placeholder ), [ hostItems ] );
	const [ frozenRows, setFrozenRows ] = useState< ProductListItem[] | null >( null );
	// Bulk: the list of selected items is a collapsible section at the top of the panel's body.
	// Open for a few items; a long list (all the variations of a product) would push the form below the fold.
	const [ itemsOpen, setItemsOpen ] = useState( () => liveRows.length <= ITEMS_OPEN_MAX );
	const selectedRows = frozenRows ?? liveRows;
	const selectionKey = selectedRows.map( ( item ) => item.id ).join( ',' );
	// The tab the editor opens on: the list's translation filter, else the one "Update & next" carried over, else the last one used, else General.
	const [ tabId, setTabId ] = useState( () => openingTab( initialTab, mode ) );

	// Remember the open tab for the next quick edit (another product, a reload).
	useEffect( () => {
		if ( ! bulk ) {
			rememberTab( tabId );
		}
	}, [ tabId, bulk ] );
	// The same rows reloaded with the editable fields of the open tabs (the list only carries the visible columns), by id.
	const [ hydrated, setHydrated ] = useState< ReadonlyMap< number, ProductListItem > >( () => new Map() );
	const [ loaded, setLoaded ] = useState( false );
	const [ excluded, setExcluded ] = useState< { missing: ProductListItem[]; trashed: ProductListItem[] } >( { missing: [], trashed: [] } );
	const [ loadedTabs, setLoadedTabs ] = useState< ReadonlySet< string > >( () => new Set() );
	const [ tabLoading, setTabLoading ] = useState< string | null >( null );
	const loadingIdsRef = useRef< Set< number > >( new Set() );
	// The stamp of each parent of a loaded variation when it loaded: the pre-save check's baseline for that variation.
	const parentStampsRef = useRef< Map< number, string > >( new Map() );
	const rememberParentStamps = ( stamps: ReadonlyMap< number, string > | undefined ) => {
		stamps?.forEach( ( stamp, id ) => parentStampsRef.current.set( id, stamp ) );
	};
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

		return () => {
			mountedRef.current = false;
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
			.then( ( { items: full, missing: gone, trashed, parentStamps } ) => {
				if ( ! mountedRef.current ) {
					return;
				}

				rememberParentStamps( parentStamps );

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
	// Rows the last Update was refused on because someone else changed them meanwhile (409 wc_products_list_conflict):
	// a retry writes the user's values over that change, so it waits for an explicit yes (`overwriteConfirmed`).
	const [ conflictIds, setConflictIds ] = useState< ReadonlySet< number > >( () => new Set() );
	const [ overwriteConfirmed, setOverwriteConfirmed ] = useState( false );
	// Rows an Update held back because someone else saved them meanwhile: a held-back variable parent retries with all its variations.
	const [ heldBack, setHeldBack ] = useState< ReadonlySet< number > >( () => new Set() );
	const [ saving, setSaving ] = useState( false );
	const [ submitRequested, setSubmitRequested ] = useState< false | 'save' | 'next' >( false );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	const [ variations, setVariations ] = useState< VariationLoad >( IDLE_LOAD );
	// Variations read so far while "apply to variations" loads them (the note counts up to the expected total).
	const [ variationsLoaded, setVariationsLoaded ] = useState( 0 );
	// Bumped when fetched variations are known to be stale (a save wrote some, someone else changed their parent): the forgotten parents load again.
	const [ variationEpoch, setVariationEpoch ] = useState( 0 );
	// Why the warning list is up: rows a decrease clamps at zero, or rows saved by someone else since the editor loaded them.
	const [ warningKind, setWarningKind ] = useState< 'clamp' | 'stale' | 'uncertain' >( 'clamp' );
	// Rows whose last write failed with an unknown outcome (it may have been stored): a relative op asks before it runs on them again.
	const [ uncertainIds, setUncertainIds ] = useState< ReadonlySet< number > >( () => new Set() );
	// The names of the rows a save failed on, as they were when it ran (a variation deleted meanwhile is in no list any more).
	const [ errorNames, setErrorNames ] = useState< ReadonlyMap< number, string > >( () => new Map() );
	// The names of the rows a warning is about, as they were when it was raised (a row taken out of the selection keeps its name).
	const [ warningNames, setWarningNames ] = useState< ReadonlyMap< number, string > >( () => new Map() );
	// The language tools' runs added to this Update (they save with it, in its History batch), in the order added.
	const [ staged, setStaged ] = useState< ReadonlyMap< string, StagedTool > >( () => new Map() );
	// Texts typed into a bulk language tab's "Translate product by product" grid: saved with Update like a staged tool run.
	const translationsRef = useRef< TranslationStore | null >( null );
	translationsRef.current ??= new TranslationStore();
	const translations = translationsRef.current;
	const [ translationCount, setTranslationCount ] = useState( 0 );
	useEffect( () => translations.subscribe( setTranslationCount ), [ translations ] );
	const stagedCount = staged.size + translationCount;
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
	// A quick edit setting the price of all of a variable product's variations is a campaign on those variations: the
	// price fields take the bulk operations ("regular price minus 20 %"), and the sale checks of a bulk edit apply.
	const sellableOps = ! bulk && applyToVariations && variableParents.length > 0;
	const priceOps = bulk || sellableOps;
	// The edits belong to this editor: ticking another row into a bulk edit keeps what was typed.
	const state = useEditState( items, editFields, mode );
	const editFieldsById = useMemo( () => new Map( editFields.map( ( field ) => [ field.id, field ] ) ), [ editFields ] );
	// What each field showed when the user started editing it: its writes' expected values come from there (shown-values.ts).
	const shownRef = useRef< ShownValues | null >( null );
	shownRef.current ??= new ShownValues();
	const shown = shownRef.current;
	// The value each field showed first (by field id), for "changed by someone else since the list loaded".
	const firstShownRef = useRef( new Map< string, string >() );
	// The rows as last rendered (the selection and the variations loaded for it): what a first change of a field was made on.
	const renderedRowsRef = useRef< ProductListItem[] >( [] );
	// Every row of the selection has had its own load (a row ticked in later has not, until its load lands).
	const allHydrated = items.every( ( row ) => hydrated.has( row.id ) );
	/**
	 * Whether a field's value on every row is the loaded one: its tab's load landed, or the rows carry it from the list
	 * (not the texts the editor loads raw: the list has them rendered). Until then the field is read-only, so nothing is
	 * typed over a value the form did not show.
	 */
	const fieldLoaded = useCallback(
		( field: ProductField ) => {
			if ( allHydrated && ! loading && loadedTabs.has( tabOf( field ) ) ) {
				return true;
			}

			const paths = pathsOfEdit( field.id, editFieldsById );

			return ! paths.some( ( path ) => EDIT_CONTEXT_KEYS.has( path.split( '.' )[ 0 ] ?? path ) ) && items.every( ( row ) => row._placeholder || rowCarries( row, paths ) );
		},
		[ allHydrated, loading, loadedTabs, editFieldsById, items ]
	);
	const pendingFieldIds = useMemo( () => new Set( visibleFields.filter( ( field ) => ! fieldLoaded( field ) ).map( ( field ) => field.id ) ), [ visibleFields, fieldLoaded ] );

	const tabs = useMemo( () => buildTabs( visibleFields, items, settings ), [ visibleFields, items, settings ] );
	const tab = useMemo< QuickEditTab >( () => tabs.find( ( entry ) => entry.id === tabId ) ?? tabs[ 0 ] ?? { id: GENERAL_TAB_ID, label: __( 'General', 'wp-woocommerce-products-list' ) }, [ tabs, tabId ] );
	// The labels inside the form ("Stock status"; "Name" on the Svenska tab): what a control is found by.
	const controlLabels = useMemo( () => Object.fromEntries( editFields.map( ( field ) => [ field.id, formLabelOf( field, settings ) ] ) ), [ editFields, settings ] );
	// What was typed on General for the texts a language tab shows as its "Default:" (a quick edit's name, say).
	const editedDefaultsKey = bulk || tab.id === GENERAL_TAB_ID ? '{}' : JSON.stringify( Object.fromEntries( Object.entries( state.edits ).filter( ( [ id, value ] ) => tabOf( editFieldsById.get( id ) ?? ( { id } as ProductField ) ) === GENERAL_TAB_ID && typeof value === 'string' ) ) );
	const formFields = useMemo(
		() => toFormFields( visibleFields, { bulk, items, base: state.data, mixed: state.mixed, settings, pending: pendingFieldIds, labels: controlLabels, sellableOps, editedDefaults: JSON.parse( editedDefaultsKey ) as Record< string, unknown > } ),
		// state.data changes on every keystroke; the placeholders only need the merged base, which state.mixed tracks.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ visibleFields, bulk, items, state.mixed, settings, pendingFieldIds, controlLabels, sellableOps, editedDefaultsKey ]
	);

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

	// The editor takes keyboard focus as soon as it is in the panel; the first input gets it once the form is there.
	useEffect( () => {
		const root = rootRef.current;

		if ( root && ! root.contains( document.activeElement ) ) {
			root.focus( { preventScroll: true } );
		}
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

		// Opening took this long, from the click (performance entry `wc-products-list:editor-ready`).
		measureEditorReady();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mode is fixed for the editor's life
	}, [ formShown ] );

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
		setVariationsLoaded( 0 );

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
				// Every parent's variations across parents (a handful of requests for a page of 100), else one parent at a time.
				// A failed cross-parent read falls back to the per-parent one (an older server, a proxy that blocks the route).
				const across = await getVariationsOfParents( [ ...queue ], { fields: fetchFields, signal: controller.signal, onProgress: setVariationsLoaded } ).catch( () => null );

				if ( across && ! controller.signal.aborted ) {
					across.forEach( ( rows, parentId ) => known.set( parentId, rows ) );
					queue.length = 0;
				}

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

	// The apply-to-variations checkbox leads Pricing (and a language's Prices) whenever a variable product is selected, so
	// the card is there before a price field is and ticking it never makes the form jump.
	const applyLabel = bulk
		? sprintf(
				/* translators: %d: number of variable products */
				_n( 'Also apply to the variations of the %d variable product', 'Also apply to the variations of the %d variable products', variableParents.length, 'wp-woocommerce-products-list' ),
				variableParents.length
		  )
		: __( 'Set the price of all its variations', 'wp-woocommerce-products-list' );
	const applyField = useMemo( () => applyControlField( applyLabel ), [ applyLabel ] );
	// A variable product selected together with every one of its variations needs no "apply to its variations": the
	// price fields reach those variations already, and the box would contradict the selection.
	const applyOffered = useMemo( () => variableParents.some( ( parent ) => {
		const total = Number( parent._childCount ) || 0;

		return total === 0 || items.filter( ( item ) => isVariation( item ) && parentIdOf( item ) === parent.id ).length < total;
	} ), [ variableParents, items ] );

	// Ticked, then the rest of the variations were selected too: the box is gone, and so is what it asked for.
	useEffect( () => {
		if ( ! applyOffered && applyToVariations ) {
			setApplyToVariations( false );
		}
	}, [ applyOffered, applyToVariations ] );

	const formLeads = useMemo< Record< string, string[] > | undefined >( () => {
		if ( ! applyOffered ) {
			return undefined;
		}

		const section = tab.id === GENERAL_TAB_ID ? 'pricing' : tab.id.startsWith( 'i18n:' ) && editFields.some( ( field ) => tabOf( field ) === tab.id && isSellableField( field ) ) ? 'prices' : null;

		return section ? { [ section ]: [ APPLY_TO_VARIATIONS_FIELD_ID ] } : undefined;
	}, [ applyOffered, tab.id, editFields ] );
	// Notes that end Pricing and Inventory (existing sales, "only lower", why a stock edit is skipped): next to the fields
	// they are about. A tab without that card (a language's) shows them below the form, as before.
	const noteSections = useMemo( () => {
		const present = new Set( visibleFields.filter( ( field ) => fieldsOfTab( [ field ], tab ).length > 0 ).map( ( field ) => layoutGroupOf( field, tab, bulk ) ) );

		return [ 'pricing', 'inventory' ].filter( ( group ) => present.has( group ) );
	}, [ visibleFields, tab, bulk ] );
	const formTrails = useMemo< Record< string, string[] > >( () => Object.fromEntries( noteSections.map( ( group ) => [ group, [ sectionNoteFieldId( group ) ] ] ) ), [ noteSections ] );
	const dataFormFields = useMemo(
		() => [ ...formFields, ...( formLeads ? [ applyField ] : [] ), ...noteSections.map( ( group ) => sectionNoteField( group ) ) ],
		[ formLeads, formFields, applyField, noteSections ]
	);

	// Collapsed cards open for a field with a pending edit or a problem, and that stays so for this selection: a card
	// never closes under the user because an edit was typed back or an error went away. (A field focused from the
	// problem list, or the first invalid one on Update, opens its card itself: whenControlShown.)
	const openedRef = useRef< { key: string; ids: string[] } >( { key: selectionKey, ids: [] } );

	if ( openedRef.current.key !== selectionKey ) {
		openedRef.current = { key: selectionKey, ids: [] };
	}

	const openTriggers = [ ...Object.keys( pendingEdits ), ...invalidFields.map( ( entry ) => entry.field ), ...errors.map( ( entry ) => entry.field ?? '' ) ].filter( Boolean );
	const openedIds = openedRef.current.ids;

	for ( const id of openTriggers ) {
		if ( ! openedIds.includes( id ) ) {
			openedIds.push( id );
		}
	}

	const openKey = [ ...openedIds ].sort().join( '|' );
	const pendingKey = Object.keys( pendingEdits ).sort().join( '|' );
	const formColumns = useFormColumns( formRef );
	// A narrow panel scrolls the tab strip sideways: the open tab (one picked from the problem list too) is kept in view.
	useEffect( () => {
		const button = typeof document === 'undefined' ? null : document.getElementById( `wc-pl-edit-tab-${ tab.id }` );
		const strip = button?.parentElement;

		if ( ! button || ! strip || strip.scrollWidth <= strip.clientWidth ) {
			return;
		}

		if ( button.offsetLeft < strip.scrollLeft ) {
			strip.scrollLeft = button.offsetLeft;
		} else if ( button.offsetLeft + button.offsetWidth > strip.scrollLeft + strip.clientWidth ) {
			strip.scrollLeft = button.offsetLeft + button.offsetWidth - strip.clientWidth;
		}
	}, [ tab.id ] );
	const form = useMemo(
		() =>
			buildInlineForm( visibleFields, tab, items, settings, {
				columns: formColumns.columns,
				open: new Set( openKey.split( '|' ) ),
				pending: new Set( pendingKey.split( '|' ) ),
				leads: formLeads,
				trails: formTrails,
				bulk,
			} ),
		[ visibleFields, tab, items, settings, formColumns.columns, openKey, pendingKey, formLeads, formTrails, bulk ]
	);
	const { validity, isValid } = useFormValidity< FormData >( state.data, dataFormFields, form );

	// The rows the user sees (committed render): a field's first change is made on these values.
	useLayoutEffect( () => {
		renderedRowsRef.current = applyToVariations && variations.status === 'loaded' ? [ ...items, ...Array.from( variations.byParent.values() ).flat() ] : items;
	} );

	const onChange = useCallback(
		( changes: Record< string, unknown > ) => {
			shown.record( Object.keys( changes ), renderedRowsRef.current );
			state.setFields( changes );
			setErrors( [] );
			setWarnings( [] );
			setAcknowledged( null );
			setInvalidFields( [] );
			clearFlaggedControls( formRef.current );
		},
		[ state, shown ]
	);

	// Fields whose value changed after the form first showed it (the fetch brought a newer value than the list's, or a reload).
	const changedFields = useMemo< ChangedField[] >(
		() => changedSinceShown( visibleFields, items, firstShownRef.current, shown, new Map( visibleFields.filter( ( field ) => shown.has( field.id ) ).map( ( field ) => [ field.id, state.data[ field.id ] ] ) ), fieldLoaded ),
		// state.edits: a field becomes "edited" with its first change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ visibleFields, items, fieldLoaded, state.edits ]
	);

	// The open tab's changed fields, and how each is said.
	const tabChanged = useMemo( () => {
		const onTab = new Set( fieldsOfTab( visibleFields, tab ).map( ( field ) => field.id ) );

		return changedFields.filter( ( entry ) => onTab.has( entry.id ) );
	}, [ changedFields, visibleFields, tab ] );
	const changedLine = ( entry: ChangedField ): string => {
		const field = editFieldsById.get( entry.id );
		const label = field?.label ?? entry.id;
		const now = Array.isArray( entry.now ) && items.length > 1 ? __( 'different on the selected rows', 'wp-woocommerce-products-list' ) : field ? describeValue( field, entry.now, settings ) : String( entry.now ?? '' );

		return entry.edited
			? sprintf(
					/* translators: 1: field label, 2: the value stored now */
					__( '%1$s: changed by someone else since you started editing it, now %2$s. Your value is kept; Update will not write over the other change without asking.', 'wp-woocommerce-products-list' ),
					label,
					now
			  )
			: sprintf(
					/* translators: 1: field label, 2: the value stored now */
					__( '%1$s: changed by someone else since the list loaded, now %2$s. The field shows the current value.', 'wp-woocommerce-products-list' ),
					label,
					now
			  );
	};

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
				heldBack.has( parentId ) ? rows : rows.filter( ( row ) => failedIds.has( row.id ) )
			);
		}

		const retried = items.filter( ( item ) => failedIds.has( item.id ) || ( isVariableParent( item ) && ( prefetched.get( item.id )?.length ?? 0 ) > 0 ) );

		return {
			items: retried,
			prefetched: prefetched as ReadonlyMap< number, ProductListItem[] >,
			carriersOnly: new Set( retried.filter( ( item ) => ! failedIds.has( item.id ) ).map( ( item ) => item.id ) ) as ReadonlySet< number >,
		};
	}, [ failedIds, heldBack, items, variations ] );

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
	// Rows whose current sale the edits replace (bulk, or all of a product's variations: a quick edit of one row shows the field itself).
	const existingSales = useMemo( () => ( priceOps && plannedCount ? rowsWithExistingSale( targetsForValidation, plannedEdits ) : { rows: [], active: 0 } ), [ priceOps, plannedCount, targetsForValidation, plannedEdits ] );
	// Sales running now that the edits would end: the user says replace or skip before anything is written.
	const runningSales = useMemo( () => describeRunningSales( existingSales.rows, plannedEdits, settings ), [ existingSales.rows, plannedEdits, settings ] );
	const saleChoiceNeeded = priceOps && runningSales.count > 0 && saleChoice === null;

	const nextRow = useMemo( () => ( bulk || ! selectedRows[ 0 ] ? null : nextRowOnScreen( selectedRows[ 0 ].id ) ), [ bulk, selectedRows ] );

	/** Focus a field from the problem list: its tab first, then its card opened, then its control. */
	const focusField = useCallback(
		( fieldId: string ) => {
			const field = fieldTab( fieldId );

			if ( field && tabOf( field ) !== tab.id ) {
				setTabId( tabOf( field ) );
			}

			setTimeout( () => {
				if ( mountedRef.current ) {
					whenControlShown( () => controlForField( formRef.current, controlLabels[ fieldId ] ?? fieldId ), ( control ) => mountedRef.current && focusControl( control ) );
				}
			}, 0 );
		},
		[ fieldTab, tab.id, controlLabels ]
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
			const control = controlForField( formRef.current, controlLabels[ entry.field ] ?? entry.field ) as HTMLInputElement | null;
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
				worded.map( ( entry ) => ( { field: entry.field, label: controlLabels[ entry.field ] ?? entry.field } ) )
			);

			// The first one may sit in a collapsed card that opens with this render (its content takes no focus until then).
			whenControlShown(
				() => controls[ 0 ] ?? null,
				( control ) => {
					if ( mountedRef.current && ! focusControl( control ) && ! focusFirstInvalidControl( formRef.current ) ) {
						focusWithin( rootRef.current, '.wc-pl-edit__errors' );
					}
				}
			);
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
					const label = controlLabels[ field ] ?? field;

					// A bulk numeric field is an operation select and a value input: the value is what is wrong.
					return { field, label: controlForField( root, `${ label }: value` ) ? `${ label }: value` : label };
				} )
			);
			revealNotice( rootRef.current, kind === 'errors' ? '.wc-pl-edit__errors' : '.wc-pl-edit__warnings' );
		}, 0 );
	};

	/** The rows the staged tools and the grid's translations write for `rows` (the planned header of a shared batch). */
	const stagedToolRows = ( rows: ProductListItem[] ): number =>
		Array.from( staged.values() ).reduce( ( sum, entry ) => sum + stagedToolIds( entry, rows, parentVariations ).length, 0 ) + translations.count();

	/**
	 * Run the staged tools under the Update's batch, one after the other in the order they were added. A tool
	 * that ran leaves the staged list; one that failed stays there (the next Update runs it again) and is reported.
	 */
	const runStagedTools = async ( rows: ProductListItem[], batchId: string, planned?: number ): Promise< { ran: number; errors: EditError[] } > => {
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
				await runDeclarativeAction( entry.def.id, entry.def.label || entry.def.id, ids, entry.args, rowFields( allFields ), { inlineErrors: true, batchId, silent: true, ...( planned ? { planned } : {} ) } );
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

		// The grid's per-product translations: one products/batch request per hundred products, three at a time.
		const typed = translations.entries();

		if ( typed.length ) {
			const byId = new Map( rows.map( ( row ) => [ row.id, row ] ) );
			const updates: Array< { id: number } & Record< string, unknown > > = [];
			const keys = new Set< string >();

			for ( const [ id, edits ] of typed ) {
				const row = byId.get( id );

				if ( ! row ) {
					continue;
				}

				Object.keys( edits ).forEach( ( key ) => {
					keys.add( key );
					ranTabs.add( key.slice( 0, key.indexOf( '.' ) ) );
				} );
				// With the values the grid loaded as `_wcpl_expect`: a translation saved meanwhile elsewhere is refused, not overwritten.
				updates.push( translationWriteItem( row, edits, translations.originalsOf( id ), allFields, settings ) );
			}

			const size = Math.max( 1, settings.limits.batchSize );
			const parts: Array< typeof updates > = [];

			for ( let index = 0; index < updates.length; index += size ) {
				parts.push( updates.slice( index, index + size ) );
			}

			const returned = saveFields( allFields, Object.fromEntries( Array.from( keys, ( key ) => [ key, true ] ) ) );

			await runConcurrently(
				parts.map( ( part ) => async () => {
					try {
						const response = await batchProducts( part, { batchId, source: 'bulk', fields: returned, ...( planned ? { planned } : {} ) } );
						const saved: number[] = [];
						const patches: ProductListItem[] = [];

						for ( const entry of response.update ?? [] ) {
							if ( isBatchItemError( entry ) ) {
								errors.push( { id: entry.id, message: entry.error.message } );
							} else {
								saved.push( entry.id );
								patches.push( toRow( entry ) );
							}
						}

						patchItems( patches );
						translations.clear( saved );
						ran += saved.length;
					} catch ( reason ) {
						part.forEach( ( update ) => errors.push( { id: update.id, message: reason instanceof Error ? reason.message : __( 'The translation could not be saved.', 'wp-woocommerce-products-list' ) } ) );
					}
				} ),
				3
			);
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
		const { items: full, parentStamps } = await hydrateSelection( rows, wanted );

		if ( ! mountedRef.current ) {
			return;
		}

		rememberParentStamps( parentStamps );
		patchItems( full );
		// The warning shows these rows' current values: the next Update's expected values are those.
		shown.rebase( full.map( ( row ) => {
			const known = items.find( ( item ) => item.id === row.id );

			return known ? ( mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown > ) as ProductListItem ) : row;
		} ) );
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

		// Someone else changed rows of the last Update meanwhile: a retry writes over that only after the explicit yes.
		if ( failedIds && ! overwriteConfirmed && Array.from( failedIds ).some( ( id ) => conflictIds.has( id ) ) ) {
			focusWithin( rootRef.current, '.wc-pl-edit__overwrite input' );

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

		// "Write over the other change": the values the form shows for those rows now (the notice names them) are what this Update replaces.
		if ( failedIds && overwriteConfirmed && conflictIds.size ) {
			shown.rebase( renderedRowsRef.current.filter( ( row ) => conflictIds.has( row.id ) && ( hydrated.has( row.id ) || isVariation( row ) ) ) );
		}

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

			// A retry of a relative change on rows whose last write may have been stored would apply it twice: ask once.
			const relative = Object.values( pendingEdits ).some( ( value ) => isNumericOp( value ) && isPendingOp( value ) && value.operation !== 'set' );
			const unsure = relative ? retryTargets.items.filter( ( item ) => uncertainIds.has( item.id ) ) : [];
			const unsureKey = `uncertain:${ unsure.map( ( item ) => item.id ).join( ',' ) }`;

			if ( unsure.length && ( acknowledged !== unsureKey || implicit ) ) {
				setWarningKind( 'uncertain' );
				setWarningNames( new Map( unsure.map( ( item ) => [ item.id, nameOf( item ) ] ) ) );
				reportProblems(
					unsure.map( ( item ) => ( {
						id: item.id,
						message: __( 'The last Update may have been saved on it before the connection failed. It now shows its stored values; a relative change applies to those again.', 'wp-woocommerce-products-list' ),
					} ) ),
					'warnings'
				);
				setAcknowledged( unsureKey );

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
		// The list's indicator, row locks and leave-page guard start with the re-checks, not with the first write (finished below on every path).
		let saveJob: number | undefined;
		// The shared batch of field edits and staged tools: running on the server until every write of the Update is done (closed below).
		let openBatch: string | undefined;

		try {
			// Rows trashed or deleted since the editor loaded them are left out and named, not written in the Trash as if nothing happened.
			// With a relative price op the same request also brings each row's last-modified stamp: a row saved by someone
			// else meanwhile would get the op applied to a value it no longer has.
			const checkBases = runFields && priceOps && hasLoadRelativeOps( pendingEdits );
			// The rows this Update writes: the field edits' (all, or the failed ones on a retry), and the staged tools' (every row).
			const checkItems = runFields ? ( stagedCount ? Array.from( new Map( [ ...retryTargets.items, ...items ].map( ( item ) => [ item.id, item ] ) ).values() ) : retryTargets.items ) : items;

			saveJob = beginSaveJob( checkItems );
			let changed: { trashed: number[]; missing: number[] } = { trashed: [], missing: [] };
			let stale: ProductListItem[] = [];

			if ( checkBases ) {
				// One light request per hundred products (the variations' parents included), never one per parent.
				const check = await recheckBases( checkItems, parentStampsRef.current );
				const writing = new Set( retryTargets.items.map( ( item ) => item.id ) );

				changed = { trashed: check.trashed, missing: check.missing };
				stale = check.stale.filter( ( item ) => writing.has( item.id ) );
			} else if ( bulk ) {
				changed = await recheckStatuses( checkItems );
			}

			const dropped = new Set( [ ...changed.trashed, ...changed.missing ] );
			const staleIds = new Set( stale.map( ( item ) => item.id ) );
			const writable = dropped.size ? retryTargets.items.filter( ( item ) => ! dropped.has( item.id ) ) : retryTargets.items;
			// Rows saved by someone else meanwhile are held back for a look; the others save now (with staged tools the Update stays whole).
			const holdBack = staleIds.size > 0 && stagedCount === 0 && writable.some( ( item ) => ! staleIds.has( item.id ) && ! retryTargets.carriersOnly?.has( item.id ) );
			const saveItems = holdBack ? writable.filter( ( item ) => ! staleIds.has( item.id ) ) : writable;
			const staleWarnings = stale.map( ( item ) => ( {
				id: item.id,
				message: holdBack
					? __( 'Saved by someone else since this editor loaded it, so it was not updated. The preview now uses its current values: check it, then press Update to apply the edits to it too, or Cancel to leave it.', 'wp-woocommerce-products-list' )
					: __( 'Saved by someone else since this editor loaded it. The preview now uses its current values: check it, then press Update again.', 'wp-woocommerce-products-list' ),
			} ) );

			if ( staleIds.size && mountedRef.current ) {
				setWarningNames( new Map( stale.map( ( item ) => [ item.id, nameOf( item ) ] ) ) );
			}
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

			if ( stale.length && ! holdBack ) {
				await refreshStale( stale );

				if ( mountedRef.current ) {
					// Nothing was written: the rows stay free to change until a save runs.
					setFrozenRows( frozenBefore );
					setWarningKind( 'stale' );
					reportProblems( staleWarnings, 'warnings' );
				}

				return;
			}

			// The held-back rows load their current values while the others save.
			const refreshing = holdBack ? refreshStale( stale ).catch( () => {} ) : null;

			// The field edits and the staged tool runs of one Update are one History batch: one Undo takes all of it back.
			// It stays `running` on the server (History will not plan, check or revert it) until the tools are done too.
			const sharedBatch = stagedCount ? newBatchId() : undefined;
			const toolRows = sharedBatch ? stagedToolRows( toolItems ) : 0;

			openBatch = sharedBatch;
			const result: SaveResult = runFields
				? await saveEdits( saveItems, pendingEdits, editFields, {
						applyToVariations,
						source: bulk ? 'bulk' : 'quick',
						prefetchedVariations: retryTargets.prefetched,
						...( retryTargets.carriersOnly?.size ? { carriersOnly: retryTargets.carriersOnly } : {} ),
						...( sharedBatch ? { batchId: sharedBatch, keepBatchOpen: true, plannedExtra: toolRows } : {} ),
						saveJob,
						// Each field's expected values are the ones it showed when the user started editing it.
						expectBase: ( item: ProductListItem ) => shown.baseRow( item, editFieldsById ),
						...rowOptions,
						onProgress: ( done, total ) => {
							if ( mountedRef.current ) {
								setProgress( { done, total } );
							}
						},
				  } )
				: { updated: [], errors: [], batchId: sharedBatch ?? '', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 };

			// Then the staged tools, in the order they were added, once the field edits all saved (a failed field edit keeps them for the retry).
			const tools = result.errors.length === 0 ? await runStagedTools( toolItems, result.batchId, sharedBatch ? result.updated.length + result.errors.length + toolRows : undefined ) : { ran: 0, errors: [] as EditError[] };

			// Every write of the Update is done: the batch can be planned and reverted (before any Undo is offered).
			if ( openBatch ) {
				const closing = openBatch;

				openBatch = undefined;
				await closeBatch( closing );
			}

			if ( tools.errors.length ) {
				failed = true;

				if ( mountedRef.current ) {
					// The field edits are saved: what is left is the tools that failed (Update retries them).
					setFailedIds( new Set() );
					setErrors( tools.errors );
				}

				const partial = result.updated.length > 0 || tools.ran > 0;

				notify.error( tools.errors.map( ( error ) => error.message ).join( ' ' ), {
					id: mountedRef.current ? SAVED_NOTICE_ID : outcomeNoticeId( result.batchId ),
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
				// The rows held back because someone else saved them meanwhile: History lists them as left out of the campaign.
				...( holdBack ? stale.map( ( item ): SkippedItem => ( { id: item.id, reason: 'conflict', fields: editKeys, message: __( 'Saved by someone else meanwhile; not updated.', 'wp-woocommerce-products-list' ) } ) ) : [] ),
				// The rows that did not save are recorded too: the batch in History then says which rows of the campaign are missing.
				// (Conflicts, locks and the Trash are refused and logged by the server itself.)
				...result.errors.filter( ( error ) => error.id > 0 && ! isServerLoggedCode( error.code ) ).map( ( error ): SkippedItem => ( { id: error.id, reason: isGoneCode( error.code ) ? 'deleted' : 'failed', fields: editKeys, message: error.message } ) ),
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
				const heldLine = holdBack
					? sprintf(
							/* translators: %d: number of rows held back */
							_n( '%d item saved by someone else meanwhile was left for you to check.', '%d items saved by someone else meanwhile were left for you to check.', staleIds.size, 'wp-woocommerce-products-list' ),
							staleIds.size
					  )
					: '';

				if ( holdBack && ! mountedRef.current ) {
					// The panel is closed: the held-back rows are only in this notice, so it stays and can select them for another look.
					const heldIds = Array.from( staleIds );

					notify.info( [ fieldsLine, toolsLine, heldLine ].filter( Boolean ).join( ' ' ), {
						id: outcomeNoticeId( result.batchId ),
						explicitDismiss: true,
						actions: [
							...savedActions,
							{
								label: sprintf(
									/* translators: %d: number of rows held back */
									_n( 'Select the %d held back', 'Select the %d held back', heldIds.length, 'wp-woocommerce-products-list' ),
									heldIds.length
								),
								onClick: () => void selectRows( heldIds ),
							},
						],
					} );

					return;
				}

				notify.success( [ fieldsLine, toolsLine, heldLine ].filter( Boolean ).join( ' ' ), {
					id: SAVED_NOTICE_ID,
					actions: savedActions.length ? savedActions : undefined,
				} );

				if ( holdBack ) {
					// The editor stays on the held-back rows: Update applies the same edits to them on their current values.
					await refreshing;

					if ( mountedRef.current ) {
						setFailedIds( new Set( staleIds ) );
						setHeldBack( new Set( staleIds ) );
						setHydrated( ( current ) => {
							const next = new Map( current );

							for ( const row of result.updated ) {
								const known = next.get( row.id );

								// A saved description comes back rendered (view context): the row is loaded again, raw.
								if ( known && carriesViewText( row as Record< string, unknown > ) ) {
									next.delete( row.id );
								} else if ( known ) {
									next.set( row.id, mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown > ) as ProductListItem );
								}
							}

							return next;
						} );
						setWarningKind( 'stale' );
						reportProblems( staleWarnings, 'warnings' );
					}

					return;
				}

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

			// With the panel closed the snackbar is all there is: it can select the rows that failed, to reopen the editor on them and retry.
			const retryIds = Array.from( new Set( [ ...result.errors.filter( ( error ) => error.id > 0 && ! isGoneCode( error.code ) ).map( ( error ) => error.id ), ...( holdBack ? staleIds : [] ) ] ) );
			const selectFailed =
				! mountedRef.current && bulk && retryIds.length
					? [
							{
								label: sprintf(
									/* translators: %d: number of items that failed to save */
									_n( 'Select the %d failed', 'Select the %d failed', retryIds.length, 'wp-woocommerce-products-list' ),
									retryIds.length
								),
								onClick: () => void selectRows( retryIds ),
							},
					  ]
					: [];
			const partialActions = [ ...( updated > 0 && canUndo() ? [ undoAction( result.batchId ) ] : [] ), ...( history ? [ history ] : [] ), ...selectFailed ];

			if ( mountedRef.current ) {
				// The editor lists who failed and why; the snackbar carries the counts and the Undo, and expires like any other.
				notify.info( partialFailureMessage( result, names, false ), { id: SAVED_NOTICE_ID, actions: partialActions.length ? partialActions : undefined } );
			} else {
				notify.error( partialFailureMessage( result, names ), { id: outcomeNoticeId( result.batchId ), actions: partialActions, explicitDismiss: true } );
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
						let message = error.message;

						if ( goneSet.has( error.id ) ) {
							message = __( 'It was deleted meanwhile and was left out.', 'wp-woocommerce-products-list' );
						} else if ( isConflictCode( error.code ) ) {
							// What the other change stored, next to the form that still holds the user's values.
							message = editorConflictMessage( error.data, ( path ) => fieldLabels[ path ] ?? path, bulk );
						}

						return {
							id: error.id,
							...( field && visibleIds.has( field ) ? { field } : {} ),
							message,
						};
					} )
				);
				setConflictIds( new Set( result.errors.filter( ( error ) => isConflictCode( error.code ) && ! goneSet.has( error.id ) ).map( ( error ) => error.id ) ) );
				setOverwriteConfirmed( false );

				if ( ! bulk && fieldErrors.length ) {
					const flagged = fieldErrors.map( ( entry ) => ( { field: entry.field, message: entry.error.message } ) );

					setInvalidFields( flagged );
					setTimeout( () => {
						if ( mountedRef.current ) {
							flagInvalidControls(
								formRef.current,
								flagged.map( ( entry ) => ( { field: entry.field, label: controlLabels[ entry.field ] ?? entry.field } ) )
							);
						}
					}, 0 );
				}
				const failedNow = new Set( [ ...result.errors.filter( ( error ) => ! goneSet.has( error.id ) ).map( ( error ) => error.id ), ...( holdBack ? staleIds : [] ) ] );

				setFailedIds( failedNow );
				setUncertainIds( new Set( result.errors.filter( ( error ) => error.code === UNCERTAIN_CODE ).map( ( error ) => error.id ) ) );
				setHeldBack( holdBack ? new Set( staleIds ) : new Set() );

				if ( holdBack ) {
					await refreshing;
					setWarningKind( 'stale' );
					setWarnings( staleWarnings );
				}

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

						// A saved description comes back rendered (view context): the row is loaded again, raw.
						if ( known && carriesViewText( row as Record< string, unknown > ) ) {
							next.delete( row.id );
						} else if ( known ) {
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
			// A failure before the tools ran: the shared batch is over all the same.
			if ( openBatch ) {
				await closeBatch( openBatch );
			}

			if ( saveJob !== undefined ) {
				finishSaveJob( saveJob );
			}

			if ( mountedRef.current ) {
				setSaving( false );
				// The rows now hold this save's values: "changed by someone else" counts from here.
				firstShownRef.current.clear();

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
		// A save in flight keeps running without the panel: the list shows its progress and locks the rows it has not
		// written yet, and the result arrives as a snackbar.
		if ( saving ) {
			return Promise.resolve( true );
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

		// Bulk: plain Enter in a numeric value box ("-5", "+10%") never saves every selected item; Cmd/Ctrl+Enter or Update does.
		if ( priceOps && ! modifier && event.target instanceof HTMLElement && event.target.closest( '.wc-pl-bulk-numeric' ) ) {
			event.preventDefault();

			return;
		}

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
			if ( ! bulk ) {
				const count = variableParents.reduce( ( sum, parent ) => sum + ( Number( parent._childCount ) || 0 ), 0 );

				return (
					<span className="wc-pl-edit__note">
						{ count > 0
							? sprintf(
									/* translators: %d: number of variations */
									_n(
										'Variable products are priced per variation. Tick to set one price for its %d variation, or quick edit a single variation.',
										'Variable products are priced per variation. Tick to set one price for all %d variations, or quick edit a single variation.',
										count,
										'wp-woocommerce-products-list'
									),
									count
							  )
							: __( 'Variable products are priced per variation. Tick to set one price for all its variations, or quick edit a single variation.', 'wp-woocommerce-products-list' ) }
					</span>
				);
			}

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
			) : (
				<span className="wc-pl-edit__note">
					{ __( 'Variable products are priced per variation. Tick to set the price and sale fields on all their variations.', 'wp-woocommerce-products-list' ) }
				</span>
			);
		}

		if ( variations.status === 'loading' ) {
			const expected = variableParents.reduce( ( sum, parent ) => sum + ( Number( parent._childCount ) || 0 ), 0 );

			return (
				<span className="wc-pl-edit__note wc-pl-edit__variation-loading" role="status" aria-live="polite">
					<Spinner />{ ' ' }
					{ variationsLoaded > 0 && expected > 0
						? sprintf(
								/* translators: 1: variations loaded so far, 2: variations expected */
								__( 'Loading variations… %1$s of %2$s', 'wp-woocommerce-products-list' ),
								variationsLoaded.toLocaleString(),
								expected.toLocaleString()
						  )
						: __( 'Loading variations…', 'wp-woocommerce-products-list' ) }
					{ variationsLoaded > 0 && expected > 0 ? <ProgressBar value={ Math.min( 100, Math.round( ( variationsLoaded / expected ) * 100 ) ) } /> : null }
				</span>
			);
		}

		if ( variations.status === 'error' ) {
			return <span className="wc-pl-edit__note">{ variations.error }</span>;
		}

		if ( variations.status === 'loaded' ) {
			const range = variationPriceRange( Array.from( variations.byParent.values() ).flat(), settings );

			return (
				<span className="wc-pl-edit__note">
					{ range ? `${ range } ` : '' }
					{ sprintf(
						/* translators: 1: "N variations", 2: "N variable products" */
						__( 'Prices will change on %1$s of %2$s.', 'wp-woocommerce-products-list' ),
						sprintf(
							/* translators: %d: number of variations */
							_n( '%d variation', '%d variations', variations.count, 'wp-woocommerce-products-list' ),
							variations.count
						),
						sprintf(
							/* translators: %d: number of variable products */
							_n( '%d variable product', '%d variable products', variableParents.length, 'wp-woocommerce-products-list' ),
							variableParents.length
						)
					) }
				</span>
			);
		}

		return null;
	} )();

	const applyControl = useMemo< ApplyControlState >(
		() => ( {
			checked: applyToVariations,
			label: applyLabel,
			note: variationNote,
			disabled: saving,
			onToggle: ( checked: boolean ) => {
				setApplyToVariations( checked );
				setErrors( [] );
				setWarnings( [] );
				setAcknowledged( null );
			},
		} ),
		// The note is rebuilt every render; what it shows follows these.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ applyToVariations, applyLabel, saving, variations, variationsLoaded, sellableShown, variableParents, bulk ]
	);

	// wc/v3's batch routes need edit_others_products (woocommerce_rest_cannot_batch);
	// one row goes through POST products/{id} instead (api/client.ts), several cannot.
	const needsEditOthers = ! settings.caps.editOthers && ( items.length > 1 || applyToVariations );
	const retryable = failedIds ? failedIds.size : 0;
	// A warning about a row taken out of the selection meanwhile goes with it.
	const shownWarnings = useMemo( () => {
		const present = new Set( targetsForValidation.map( ( item ) => item.id ) );

		return warnings.filter( ( warning ) => ! warning.id || present.has( warning.id ) );
	}, [ warnings, targetsForValidation ] );
	// Staged tools a failed Update left are still to run: Update retries them.
	const failedButNothingToRetry = failedIds !== null && retryable === 0 && stagedCount === 0;
	// The retry would write over another user's change: it needs the confirmation below the problem list.
	const conflictCount = failedIds ? Array.from( failedIds ).filter( ( id ) => conflictIds.has( id ) ).length : 0;
	const awaitingOverwrite = conflictCount > 0 && ! overwriteConfirmed;
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

		if ( failedIds && heldBack.size && Array.from( failedIds ).every( ( id ) => heldBack.has( id ) ) ) {
			/* translators: %d: number of rows saved by someone else meanwhile */
			return sprintf( _n( 'Update the %d changed item too', 'Update the %d changed items too', retryable, 'wp-woocommerce-products-list' ), retryable );
		}

		if ( failedIds && conflictCount === retryable && ! bulk ) {
			return __( 'Overwrite with my values', 'wp-woocommerce-products-list' );
		}

		if ( failedIds && conflictCount === retryable ) {
			/* translators: %d: number of rows someone else changed meanwhile */
			return sprintf( _n( 'Apply the edits to the %d changed item', 'Apply the edits to the %d changed items', retryable, 'wp-woocommerce-products-list' ), retryable );
		}

		if ( failedIds ) {
			/* translators: %d: number of rows that failed */
			return sprintf( _n( 'Retry %d failed', 'Retry %d failed', retryable, 'wp-woocommerce-products-list' ), retryable );
		}

		if ( shownWarnings.length && ( warningKind === 'clamp' || warningKind === 'uncertain' ) ) {
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
	const saveBlocked = saving || loading || needsEditOthers || awaitingOverwrite || ( ! failedButNothingToRetry && stagedCount === 0 && ( ( pendingCount === 0 && ! state.hasInput ) || nothingToWrite ) );
	const showNext = ! bulk && nextRow !== null && ! failedIds;
	// "Save & next" with nothing typed just moves on; with edits it saves them first.
	const nextBlocked = saving || loading || needsEditOthers || nothingToWrite;
	// Edits typed, yet nothing reaches any row: why, next to the greyed-out Update, not only in a note up the form.
	const nothingReason =
		! saving && ! loading && nothingToWrite && pendingCount > 0 && stagedCount === 0 && ! failedIds
			? stockGated.length > 0 && stockGated.length === targetsForValidation.filter( ( item ) => ! item._placeholder ).length
				? stockGated.length === 1
					? __( 'Nothing to update: the stock changes need "Manage stock" on (see Inventory).', 'wp-woocommerce-products-list' )
					: __( 'Nothing to update: none of these items manages stock, so the stock changes are skipped (see Inventory).', 'wp-woocommerce-products-list' )
				: __( 'Nothing to update: every change is skipped for these items (see the notes in the form).', 'wp-woocommerce-products-list' )
			: null;

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

	// The heading (title, the bulk breakdown, the loading line): in the panel's pinned header when hosted there.
	const head = (
		<div className={ `wc-pl-inline-edit__head is-${ mode }` }>
			<h2 className="wc-pl-inline-edit__title">
				{ title }
				{ ! bulk && items[ 0 ] ? <span className="wc-pl-inline-edit__name">{ nameOf( items[ 0 ] ) }</span> : null }
			</h2>
			{ bulk && items.length > 1 ? <p className="wc-pl-edit__summary">{ breakdown( items ) }</p> : null }
			{ loadingLine }
		</div>
	);


	const stockGatedTotal = targetsForValidation.filter( ( item ) => ! item._placeholder ).length;
	// A bulk stock status that no selected row would take (they manage stock, or are variable products): say why, and
	// what does it instead, rather than a field that ends in "Nothing to update".
	const statusField = editFields.find( ( field ) => field.id === 'stock_status' );
	const statusRows = items.filter( ( item ) => ! item._placeholder );
	const statusDeadEnd =
		bulk && statusField !== undefined && visibleFields.some( ( field ) => field.id === 'manage_stock' ) && stockStatusTakers( statusRows, state.data.manage_stock ) === 0
			? statusRows.every( isVariableParent )
				? 'parents'
				: statusRows.some( ( item ) => ! isVariableParent( item ) && managesStock( item ) ) || state.data.manage_stock === true
				? 'managed'
				: null
			: null;
	const quantityShown = visibleFields.some( ( field ) => field.id === 'stock_quantity' );
	const quantityOp = isNumericOp( state.data.stock_quantity ) ? state.data.stock_quantity : undefined;
	const canZeroStock = quantityShown && ! isPendingOp( quantityOp );
	const zeroedStock = quantityShown && quantityOp?.operation === 'set' && quantityOp.value === '0';
	// The value box of Stock quantity, where "Set Stock quantity to 0" puts focus: what changed, and where to keep typing.
	const focusQuantity = () => {
		const label = controlLabels.stock_quantity ?? 'stock_quantity';

		setTimeout( () => {
			if ( mountedRef.current ) {
				whenControlShown( () => controlForField( formRef.current, `${ label }: ${ __( 'value', 'wp-woocommerce-products-list' ) }` ) ?? controlForField( formRef.current, label ), ( control ) => mountedRef.current && focusControl( control ) );
			}
		}, 0 );
	};
	// One button that turns into its own Undo: focus never drops to the page when it is pressed.
	const zeroButton =
		canZeroStock || zeroedStock ? (
			<Button
				variant="secondary"
				size="compact"
				disabled={ saving }
				accessibleWhenDisabled
				onClick={ () => {
					if ( zeroedStock ) {
						onChange( { stock_quantity: { ...DONT_CHANGE } } );

						return;
					}

					onChange( { stock_quantity: { operation: 'set', value: '0' } } );
					focusQuantity();
				} }
			>
				{ zeroedStock ? __( 'Undo', 'wp-woocommerce-products-list' ) : __( 'Set Stock quantity to 0', 'wp-woocommerce-products-list' ) }
			</Button>
		) : null;
	const statusNote =
		statusDeadEnd === 'parents' ? (
			<Notice status="info" isDismissible={ false } className="wc-pl-edit__notice wc-pl-edit__status-note">
				{ __( 'Stock status: a variable product takes it from its variations. To mark sizes in or out of stock, use Select all variations in the selection bar, then Bulk edit.', 'wp-woocommerce-products-list' ) }
			</Notice>
		) : statusDeadEnd === 'managed' ? (
			<Notice status="info" isDismissible={ false } className="wc-pl-edit__notice wc-pl-edit__status-note">
				<p>
					{ statusRows.some( isVariableParent )
						? __( 'Stock status follows the stock quantity (a variable product’s follows its variations). To mark these items out of stock, set Stock quantity to 0.', 'wp-woocommerce-products-list' )
						: __( 'Stock status follows the stock quantity. To mark these items out of stock, set Stock quantity to 0.', 'wp-woocommerce-products-list' ) }
				</p>
				{ zeroButton ? (
					<p className="wc-pl-edit__status-note-action">
						{ zeroButton }{ ' ' }
						<span role="status">{ zeroedStock ? __( 'Stock quantity is set to 0 above.', 'wp-woocommerce-products-list' ) : '' }</span>
					</p>
				) : null }
			</Notice>
		) : null;
	const stockNotice =
		stockGated.length > 0 && ! loading ? (
				<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice wc-pl-edit__stock-warning">
					{ stockGatedTotal === 1
						? __( 'This item does not manage stock, so WooCommerce ignores Quantity, Low stock threshold and Backorders for it: tick Manage stock to set them.', 'wp-woocommerce-products-list' )
						: sprintf(
						/* translators: 1: number of rows, 2: number of rows in total, 3: their names */
						_n(
							'%1$d of the %2$d rows does not manage stock, so WooCommerce ignores Quantity, Low stock threshold and Backorders for it; it will be skipped: %3$s',
							'%1$d of the %2$d rows do not manage stock, so WooCommerce ignores Quantity, Low stock threshold and Backorders for them; they will be skipped: %3$s',
							stockGated.length,
							'wp-woocommerce-products-list'
						),
						stockGated.length,
						stockGatedTotal,
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
		) : null;
	const inventoryNote =
		stockNotice || statusNote ? (
			<>
				{ statusNote }
				{ stockNotice }
			</>
		) : null;
	const saleNotice =
		existingSales.rows.length > 0 && ! loading ? (
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
		) : null;
	const lowerOption =
		priceOps && plannedEdits.sale_price !== undefined && ! loading ? (
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
		) : null;
	const pricingNote =
		saleNotice || lowerOption ? (
			<>
				{ saleNotice }
				{ lowerOption }
			</>
		) : null;
	const sectionNotes = { inventory: inventoryNote, pricing: pricingNote };

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
			{ headerSlot ? createPortal( head, headerSlot ) : head }

			{ bulk ? (
				<div className="wc-pl-inline-edit__items">
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
							<details className="wc-pl-inline-edit__selection" open={ itemsOpen } onToggle={ ( event ) => setItemsOpen( event.currentTarget.open ) }>
								<summary className="wc-pl-inline-edit__selection-toggle">
									{ sprintf(
										/* translators: %d: number of selected rows */
										__( 'Selected items (%d)', 'wp-woocommerce-products-list' ),
										items.length
									) }
								</summary>
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
							</details>
						</>
					) }
				</div>
			) : null }

			<div className="wc-pl-inline-edit__main">
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

				{ tabs.length > 1 ? (
					<div className={ `wc-pl-edit__tabs${ formColumns.narrow ? ' is-narrow' : '' }` } role="tablist" aria-label={ __( 'Edit sections', 'wp-woocommerce-products-list' ) } onKeyDown={ onTabKeyDown }>
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

				{ /* Per-product names and short descriptions in this language, saved with Update. */ }
				{ bulk && tab.id.includes( ':' ) && ! loading ? (
					<TranslationGrid key={ tab.id } tabId={ tab.id } tabLabel={ tab.label } items={ items } fields={ allFields } settings={ settings } store={ translations } disabled={ saving } />
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
					className={ `wc-pl-edit__form is-${ formColumns.columns === 2 ? 'wide' : 'single' }${ formColumns.narrow ? ' is-narrow' : '' }` }
					role={ tabs.length > 1 ? 'tabpanel' : undefined }
					aria-labelledby={ tabs.length > 1 ? `wc-pl-edit-tab-${ tab.id }` : undefined }
					aria-busy={ ! tabReady }
				>
					{ tabChanged.length ? (
						<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice wc-pl-edit__changed">
							<ul>
								{ tabChanged.map( ( entry ) => (
									<li key={ entry.id }>{ changedLine( entry ) }</li>
								) ) }
							</ul>
						</Notice>
					) : null }
					{ ! formShown ? (
						<p>{ __( 'The selected rows share no editable fields.', 'wp-woocommerce-products-list' ) }</p>
					) : (
						<ApplyControlContext.Provider value={ applyControl }>
							<SectionNotesContext.Provider value={ sectionNotes }>
								<DataForm< FormData > data={ state.data } fields={ dataFormFields } form={ form } onChange={ onChange } validity={ validity } />
							</SectionNotesContext.Provider>
						</ApplyControlContext.Provider>
					) }
				</div>

				{ noteSections.includes( 'inventory' ) ? null : inventoryNote }
				{ noteSections.includes( 'pricing' ) ? null : pricingNote }

				{ priceOps && plannedCount > 0 && ! loading ? (
					<ChangeSummary edits={ plannedEdits } fields={ editFields } targets={ targetsForValidation } settings={ settings } applyToVariations={ applyToVariations } options={ rowOptions } unchanged={ plan?.unchanged ?? 0 } />
				) : null }

				{ shownWarnings.length > 0 ? (
					<EditErrors
						errors={ shownWarnings }
						items={ targetsForValidation }
						names={ warningNames }
						fieldLabels={ fieldLabels }
						status="warning"
						className="wc-pl-edit__warnings"
						title={
							warningKind === 'uncertain'
								? sprintf(
										/* translators: %d: number of rows */
										_n( '%d item may already have this change. Update anyway?', '%d items may already have this change. Update anyway?', shownWarnings.length, 'wp-woocommerce-products-list' ),
										shownWarnings.length
								  )
								: warningKind === 'stale'
								? sprintf(
										/* translators: %d: number of rows */
										_n( '%d row changed since this editor loaded it', '%d rows changed since this editor loaded them', shownWarnings.length, 'wp-woocommerce-products-list' ),
										shownWarnings.length
								  )
								: sprintf(
										/* translators: %d: number of rows */
										_n( '%d row would go below zero. Update anyway?', '%d rows would go below zero. Update anyway?', shownWarnings.length, 'wp-woocommerce-products-list' ),
										shownWarnings.length
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
				{ conflictCount > 0 && ! saving ? (
					<CheckboxControl
						className="wc-pl-edit__overwrite"
						label={
							bulk
								? sprintf(
										/* translators: %d: number of rows someone else changed meanwhile */
										_n(
											'Apply my edits to the %d item someone else changed, on the values stored now',
											'Apply my edits to the %d items someone else changed, on the values stored now',
											conflictCount,
											'wp-woocommerce-products-list'
										),
										conflictCount
								  )
								: __( 'Write my values over the other change', 'wp-woocommerce-products-list' )
						}
						checked={ overwriteConfirmed }
						onChange={ ( checked: boolean ) => setOverwriteConfirmed( checked ) }
						__nextHasNoMarginBottom
					/>
				) : null }
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
					<Button type="button" variant="tertiary" onClick={ requestClose } __next40pxDefaultSize>
						{ saving ? __( 'Close, keep updating in the background', 'wp-woocommerce-products-list' ) : __( 'Cancel', 'wp-woocommerce-products-list' ) }
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
					{ nothingReason ? <p className="wc-pl-edit__footer-reason">{ nothingReason }</p> : null }
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
