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
import { Button, CheckboxControl, Notice, Spinner, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { closeSmall, Icon } from '@wordpress/icons';
import type { KeyboardEvent } from 'react';
import { getVariations } from '../api/client';
import { DataForm, useFormValidity } from '../dataviews';
import { getSettings } from '../settings';
import { patchItems, removeItems } from '../store/products';
import { getCurrentRows } from '../store/rows';
import type { ProductListItem, QuickEditTab } from '../types';
import { notify } from '../actions/notices';
import { fetchAllVariations, variationFetchFields } from './apply-to-variations';
import { withArrayOps } from './bulk-array';
import { editFetchFields, hydrateSelection, mergeHydrated, tabFetchFields } from './hydrate';
import { projectWarnings, validateBulkNumericEdits, validateNumericOps } from './bulk-numeric';
import { ChangeSummary } from './change-summary';
import type { EditorHost } from './editor-context';
import { isGoneCode } from './errors';
import { editTypeOf, isVariableParent, isVariation } from './field-value';
import { captureFocusOrigin, focusWithin, restoreFocus } from './focus';
import { buildInlineForm, buildTabs, fieldsOfTab, GENERAL_TAB_ID, tabOf, withScheduleSale } from './form-layouts';
import { labelsOf, toFormFields } from './form-fields';
import type { FormData } from './form-fields';
import { EditErrors, SaveProgress } from './progress';
import type { EditError } from './progress';
import { canEnableStock, rowsWithExistingSale, stockGatedRows } from './row-rules';
import type { RowEditOptions } from './row-rules';
import { saveEdits } from './save';
import type { SaveResult } from './save';
import { planSave } from './save-runner';
import type { SavePlan } from './save-runner';
import { undoBatch } from './undo';
import { useEditState } from './use-edit-state';
import { collectInvalidFields, focusFirstInvalidControl, revealInvalidControls, validateFormData } from './validity';
import type { ValidatedField } from './validity';
import { isSellableField, visibleEditFields } from './visibility';

export interface InlineEditorProps {
	host: EditorHost;
}

type VariationLoad = { status: 'idle' | 'loading' | 'loaded' | 'error'; byParent: Map< number, ProductListItem[] >; count: number; error?: string };

const IDLE_LOAD: VariationLoad = { status: 'idle', byParent: new Map(), count: 0 };

const PANEL_ID = 'wc-pl-edit-panel';

/** The snackbar after a save: one at a time, a new save replaces the previous one's Undo. */
export const SAVED_NOTICE_ID = 'wc-pl-saved';

/** Where the last tab used is kept across editors (and reloads) in this browser tab. */
export const LAST_TAB_KEY = 'wc-products-list:edit-tab';

/** How many item names a notice lists before "and N more". */
const NAMES_SHOWN = 5;

/** How many rows the bulk editor's list names before "and N more". */
export const ITEMS_LISTED = 200;

function pick( edits: Record< string, unknown >, ids: Set< string > ): Record< string, unknown > {
	return Object.fromEntries( Object.entries( edits ).filter( ( [ id ] ) => ids.has( id ) ) );
}

function nameOf( item: ProductListItem ): string {
	return ( item as { name?: string } ).name || `#${ item.id }`;
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

function focusFirstControl( root: HTMLElement | null ): void {
	const first = root?.querySelector< HTMLElement >( 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])' );

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
export function successMessage( result: SaveResult ): string {
	const updated = result.updated.length;
	const extras: string[] = [];

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

	return `${ [ base, ...extras ].join( ', ' ) }.`;
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

function readLastTab(): string | null {
	try {
		return window.sessionStorage.getItem( LAST_TAB_KEY );
	} catch {
		return null;
	}
}

function writeLastTab( tab: string ): void {
	try {
		window.sessionStorage.setItem( LAST_TAB_KEY, tab );
	} catch {
		// Private mode or blocked storage: the tab is simply not remembered.
	}
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
function scrollEditorIntoView( root: HTMLElement, mode: 'quick' | 'bulk' ): void {
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
	} else if ( rect.bottom > viewport ) {
		window.scrollBy( { top: Math.min( rect.bottom - viewport, rect.top - offset ), behavior: 'auto' } );
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
	// The tab the editor opens on: the list's translation filter, else the last one used.
	const [ tabId, setTabIdState ] = useState( () => initialTab ?? readLastTab() ?? GENERAL_TAB_ID );
	const setTabId = useCallback( ( id: string ) => {
		setTabIdState( id );
		writeLastTab( id );
	}, [] );
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

					full.forEach( ( row ) => next.set( row.id, row ) );

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
	const [ skipExistingSales, setSkipExistingSales ] = useState( false );
	const [ errors, setErrors ] = useState< EditError[] >( [] );
	const [ warnings, setWarnings ] = useState< EditError[] >( [] );
	const [ acknowledged, setAcknowledged ] = useState< string | null >( null );
	const [ failedIds, setFailedIds ] = useState< Set< number > | null >( null );
	const [ saving, setSaving ] = useState( false );
	const [ submitRequested, setSubmitRequested ] = useState< false | 'save' | 'next' >( false );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	const [ variations, setVariations ] = useState< VariationLoad >( IDLE_LOAD );
	const rootRef = useRef< HTMLFormElement >( null );
	const formRef = useRef< HTMLDivElement >( null );
	const focusedRef = useRef( false );
	const saveRef = useRef< ( advance?: boolean ) => Promise< void > >( async () => {} );

	const rowOptions = useMemo< RowEditOptions >( () => ( { enableManageStock, skipExistingSales } ), [ enableManageStock, skipExistingSales ] );
	const fieldsWithToggle = useMemo( () => withScheduleSale( allFields ), [ allFields ] );
	// Bulk mode adds the add/remove/replace select in front of the list fields.
	const editFields = useMemo( () => ( bulk ? withArrayOps( fieldsWithToggle ) : fieldsWithToggle ), [ fieldsWithToggle, bulk ] );
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

		setTabLoading( tab.id );

		hydrateSelection( items, wanted )
			.then( ( { items: full } ) => {
				if ( cancelled ) {
					return;
				}

				setHydrated( ( current ) => {
					const next = new Map( current );

					for ( const row of full ) {
						const known = next.get( row.id );

						next.set( row.id, known ? ( mergeHydrated( known as Record< string, unknown >, row as Record< string, unknown > ) as ProductListItem ) : row );
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
			focusFirstControl( formRef.current );
		}

		// The form is in the row now: its height is known.
		if ( root ) {
			scrollEditorIntoView( root, mode );
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mode is fixed for the editor's life
	}, [ formShown ] );

	// Load the variations of the selected variable parents once the option is on,
	// so relative price ops, the sale < regular check and the plan see their current values.
	useEffect( () => {
		if ( ! applyToVariations || variableParents.length === 0 ) {
			setVariations( IDLE_LOAD );

			return;
		}

		let cancelled = false;
		const sellableIds = Object.fromEntries( visibleFields.filter( isSellableField ).map( ( field ) => [ field.id, true ] ) );
		const fetchFields = variationFetchFields( fieldsWithToggle, sellableIds );
		const getPage = ( parentId: number, page: number, fieldList: string[] ) => getVariations( parentId, page, { perPage: settings.limits.perPageMax, fields: fieldList } );

		setVariations( { status: 'loading', byParent: new Map(), count: 0 } );

		( async () => {
			const byParent = new Map< number, ProductListItem[] >();
			let count = 0;
			const queue = [ ...variableParents ];

			const worker = async () => {
				while ( queue.length ) {
					const parent = queue.shift()!;
					const rows = await fetchAllVariations( parent.id, fetchFields, getPage );

					byParent.set( parent.id, rows );
					count += rows.length;
				}
			};

			try {
				await Promise.all( Array.from( { length: Math.min( 4, queue.length ) }, worker ) );

				if ( ! cancelled ) {
					setVariations( { status: 'loaded', byParent, count } );
				}
			} catch ( error ) {
				if ( ! cancelled ) {
					setVariations( { status: 'error', byParent, count, error: error instanceof Error ? error.message : String( error ) } );
				}
			}
		} )();

		return () => {
			cancelled = true;
		};
		// The fetched keys depend only on which sellable fields exist, not on edits.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ applyToVariations, variableParents, settings.limits.perPageMax ] );

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
		},
		[ state ]
	);

	const variationsReady = ! applyToVariations || variableParents.length === 0 || variations.status === 'loaded';

	const targetsForValidation = useMemo( () => {
		if ( ! applyToVariations ) {
			return items;
		}

		return [ ...items, ...Array.from( variations.byParent.values() ).flat() ];
	}, [ applyToVariations, items, variations ] );

	// The plan and the warnings walk every target row; on a large selection they
	// follow the keystroke a frame later rather than slowing the input down.
	const plannedEdits = useDeferredValue( pendingEdits );
	const plannedCount = Object.keys( plannedEdits ).length;

	/** What the save will write, skip and leave alone, for the labels and the summary. */
	const plan = useMemo< SavePlan | null >( () => {
		if ( loading || plannedCount === 0 || ! variationsReady ) {
			return null;
		}

		return planSave( items, plannedEdits, editFields, settings, { applyToVariations, variationsByParent: variations.byParent, ...rowOptions } );
	}, [ loading, plannedCount, variationsReady, items, plannedEdits, editFields, settings, applyToVariations, variations.byParent, rowOptions ] );

	// Rows a stock edit would be dropped for, before the "turn on Manage stock" option is applied.
	const stockGated = useMemo( () => ( plannedCount ? stockGatedRows( targetsForValidation, plannedEdits ) : [] ), [ plannedCount, targetsForValidation, plannedEdits ] );
	const stockEnableable = useMemo( () => stockGated.filter( canEnableStock ), [ stockGated ] );
	// Rows whose current sale the edits replace (bulk only: quick edit shows the field itself).
	const existingSales = useMemo( () => ( bulk && plannedCount ? rowsWithExistingSale( targetsForValidation, plannedEdits ) : { rows: [], active: 0 } ), [ bulk, plannedCount, targetsForValidation, plannedEdits ] );

	/** After a partial failure only the failed rows (and the parents whose variations failed) are sent again. */
	const retryTargets = useMemo( () => {
		if ( ! failedIds ) {
			return { items, prefetched: variations.byParent as ReadonlyMap< number, ProductListItem[] > };
		}

		const prefetched = new Map< number, ProductListItem[] >();

		for ( const [ parentId, rows ] of variations.byParent ) {
			prefetched.set(
				parentId,
				rows.filter( ( row ) => failedIds.has( row.id ) )
			);
		}

		return {
			items: items.filter( ( item ) => failedIds.has( item.id ) || ( isVariableParent( item ) && ( prefetched.get( item.id )?.length ?? 0 ) > 0 ) ),
			prefetched: prefetched as ReadonlyMap< number, ProductListItem[] >,
		};
	}, [ failedIds, items, variations ] );

	const nextRow = useMemo( () => ( bulk || ! selectedRows[ 0 ] ? null : nextRowOnScreen( selectedRows[ 0 ].id ) ), [ bulk, selectedRows ] );

	const blockOnValidity = (): boolean => {
		if ( bulk ) {
			return false;
		}

		// The rules against the values as they are now (DataForm's tree lags a change by a render
		// and only re-checks the fields that changed), on the tabs whose values are loaded.
		const checked = formFields.filter( ( field ) => {
			const source = fieldTab( field.id );

			return ! source || loadedTabs.has( tabOf( source ) );
		} );
		let invalid = validateFormData( state.data, checked as unknown as ValidatedField[] );

		if ( invalid.length === 0 && ! isValid ) {
			invalid = collectInvalidFields( validity as Parameters< typeof collectInvalidFields >[ 0 ] );
		}

		if ( invalid.length === 0 ) {
			return false;
		}

		const list: EditError[] = invalid.map( ( entry ) => {
			const field = fieldTab( entry.field );
			const tabName = field ? tabLabels[ tabOf( field ) ] : undefined;

			return {
				id: 0,
				field: entry.field,
				message: tabName && tabs.length > 1 ? `${ entry.message } (${ tabName })` : entry.message,
			};
		} );

		setErrors( list );

		const first = invalid[ 0 ] ? fieldTab( invalid[ 0 ].field ) : undefined;

		if ( first && tabOf( first ) !== tab.id ) {
			setTabId( tabOf( first ) );
		}

		revealInvalidControls( formRef.current );
		// After the tab (and the error state) rendered: the first invalid control gets the keyboard focus.
		setTimeout( () => {
			if ( mountedRef.current && ! focusFirstInvalidControl( formRef.current ) ) {
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

	const undoAction = ( batchId: string ) => ( {
		label: __( 'Undo', 'wp-woocommerce-products-list' ),
		onClick: () => void undoBatch( batchId, { focus: captureFocusOrigin() } ),
	} );

	const save = async ( advance = false ) => {
		if ( saving || loading ) {
			return;
		}

		if ( pendingCount === 0 ) {
			if ( state.hasInput ) {
				notify.info( __( 'Nothing changed: the values equal the current ones.', 'wp-woocommerce-products-list' ) );
			}

			if ( advance && nextRow ) {
				onAdvance( nextRow );
			} else {
				onClose();
			}

			return;
		}

		setErrors( [] );

		const opErrors = validateNumericOps( pendingEdits, visibleFields, settings ).map( ( error ) => ( { id: 0, ...error } ) );

		if ( opErrors.length ) {
			setErrors( opErrors );

			return;
		}

		if ( blockOnValidity() ) {
			return;
		}

		if ( ! variationsReady ) {
			setErrors( [ { id: 0, message: variations.error ?? __( 'The variations are still loading.', 'wp-woocommerce-products-list' ) } ] );

			return;
		}

		const projected = validateBulkNumericEdits( targetsForValidation, pendingEdits, editFields, settings, rowOptions );

		if ( projected.length ) {
			setErrors( projected );

			return;
		}

		// Rows a decrease would push below zero are clamped; say so and ask once.
		const clamped = projectWarnings( targetsForValidation, pendingEdits, editFields, settings, rowOptions );
		const warningKey = clamped.map( ( warning ) => `${ warning.id }:${ warning.field }` ).join( '|' );

		if ( clamped.length && acknowledged !== warningKey ) {
			setWarnings( clamped.map( ( warning ) => ( { id: warning.id, field: warning.field, message: warning.message } ) ) );
			setAcknowledged( warningKey );

			return;
		}

		// From here on the editor works on these rows, whatever the selection does meanwhile.
		setFrozenRows( selectedRows );
		setSaving( true );
		setErrors( [] );
		setWarnings( [] );
		setProgress( { done: 0, total: 0 } );

		const names = new Map( targetsForValidation.map( ( item ) => [ item.id, nameOf( item ) ] ) );
		let failed = false;

		try {
			const result = await saveEdits( retryTargets.items, pendingEdits, editFields, {
				applyToVariations,
				source: bulk ? 'bulk' : 'quick',
				prefetchedVariations: retryTargets.prefetched,
				...rowOptions,
				onProgress: ( done, total ) => {
					if ( mountedRef.current ) {
						setProgress( { done, total } );
					}
				},
			} );

			const updated = result.updated.length;
			// Rows that no longer exist cannot be retried; they leave the list once the editor closes.
			const gone = result.errors.filter( ( error ) => isGoneCode( error.code ) ).map( ( error ) => error.id );

			gone.forEach( ( id ) => pendingRemovalRef.current.add( id ) );

			// The outcome is reported even when the editor was unmounted mid-save.
			if ( result.errors.length === 0 ) {
				notify.success( successMessage( result ), { id: SAVED_NOTICE_ID, actions: updated > 0 ? [ undoAction( result.batchId ) ] : undefined } );

				if ( advance && nextRow ) {
					if ( mountedRef.current ) {
						onAdvance( nextRow );
					}
				} else {
					finish();
				}

				return;
			}

			failed = true;

			// The rows that did save can still be undone; the editor (when still up) lists the rest.
			notify.error( partialFailureMessage( result, names, ! mountedRef.current ), {
				id: SAVED_NOTICE_ID,
				actions: updated > 0 ? [ undoAction( result.batchId ) ] : undefined,
			} );

			if ( mountedRef.current ) {
				const goneSet = new Set( gone );

				setErrors(
					result.errors.map( ( error ) => ( {
						id: error.id,
						message: goneSet.has( error.id ) ? `${ error.message } ${ __( 'It leaves the list when this editor closes.', 'wp-woocommerce-products-list' ) }` : error.message,
					} ) )
				);
				setFailedIds( new Set( result.errors.filter( ( error ) => ! goneSet.has( error.id ) ).map( ( error ) => error.id ) ) );
			}
		} catch ( error ) {
			failed = true;
			notify.error( error instanceof Error ? error.message : String( error ) );

			if ( mountedRef.current ) {
				setErrors( [ { id: 0, message: error instanceof Error ? error.message : String( error ) } ] );
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
			void saveRef.current( advance );
		}
	}, [ submitRequested ] );

	const dirty = state.hasInput && pendingCount > 0;

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
		if ( event.key === 'Escape' ) {
			// A control that used Escape itself (a closed picker) keeps it; otherwise the editor closes, after a confirm when dirty.
			if ( event.defaultPrevented ) {
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
			return;
		}

		if ( event.shiftKey && ! nextRow ) {
			return;
		}

		event.preventDefault();
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

	const variationNote = ( () => {
		if ( ! applyToVariations ) {
			return null;
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
	const failedButNothingToRetry = failedIds !== null && retryable === 0;
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

		if ( failedIds ) {
			/* translators: %d: number of rows that failed */
			return sprintf( _n( 'Retry %d failed', 'Retry %d failed', retryable, 'wp-woocommerce-products-list' ), retryable );
		}

		if ( warnings.length ) {
			return __( 'Update anyway', 'wp-woocommerce-products-list' );
		}

		if ( ! bulk ) {
			return __( 'Update', 'wp-woocommerce-products-list' );
		}

		if ( plan ) {
			return saveLabelFor( plan );
		}

		/* translators: %d: number of rows */
		return sprintf( _n( 'Update %d item', 'Update %d items', items.length, 'wp-woocommerce-products-list' ), items.length );
	} )();

	// Busy buttons stay focusable (a disabled button drops keyboard focus to <body>); the handlers ignore the extra press.
	const saveBlocked = saving || loading || needsEditOthers || ( ! failedButNothingToRetry && ( ( pendingCount === 0 && ! state.hasInput ) || nothingToWrite ) );
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
			onSubmit={ ( event ) => {
				event.preventDefault();

				if ( saving ) {
					return;
				}

				if ( failedButNothingToRetry ) {
					finish();

					return;
				}

				void save();
			} }
		>
			{ bulk ? (
				<div className="wc-pl-inline-edit__items">
					<h2 className="wc-pl-inline-edit__title">{ title }</h2>
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
										/* translators: %d: number of selected rows on other pages */
										_n( '%d of them is on another page.', '%d of them are on other pages.', offPageCount, 'wp-woocommerce-products-list' ),
										offPageCount
									) }
								</p>
							) : null }
							<ul className="wc-pl-inline-edit__list" aria-label={ __( 'Selected items', 'wp-woocommerce-products-list' ) }>
								{ listed.map( ( item ) => {
									const kind = kindLabel( item, settings.productTypes );

									return (
										<li key={ item.id } className="wc-pl-inline-edit__item">
											<span className="wc-pl-inline-edit__item-name" title={ nameOf( item ) }>
												{ nameOf( item ) }
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
													onClick={ () => onRemoveItem( item.id ) }
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
				{ ! bulk || ! tabReady ? (
					<div className="wc-pl-inline-edit__head">
						{ ! bulk ? (
							<h2 className="wc-pl-inline-edit__title">
								{ title }
								{ items[ 0 ] ? <span className="wc-pl-inline-edit__name">{ nameOf( items[ 0 ] ) }</span> : null }
							</h2>
						) : null }
						{ ! tabReady ? (
							<span className="wc-pl-inline-edit__loading" role="status">
								<Spinner /> { __( 'Loading current values…', 'wp-woocommerce-products-list' ) }
							</span>
						) : null }
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
						{ sprintf(
							/* translators: 1: number of rows with a sale, 2: number of rows in total, 3: how many of those sales run right now */
							_n(
								'%1$d of the %2$d rows already has a sale price (%3$d active now). The new sale replaces it; a running discount stops until the new sale starts.',
								'%1$d of the %2$d rows already have a sale price (%3$d active now). The new sale replaces them; running discounts stop until the new sale starts.',
								existingSales.rows.length,
								'wp-woocommerce-products-list'
							),
							existingSales.rows.length,
							targetsForValidation.filter( ( item ) => ! item._placeholder && ! isVariableParent( item ) ).length,
							existingSales.active
						) }
						<CheckboxControl
							__nextHasNoMarginBottom
							label={ sprintf(
								/* translators: %d: number of rows */
								_n( 'Skip the %d row that already has a sale', 'Skip the %d rows that already have a sale', existingSales.rows.length, 'wp-woocommerce-products-list' ),
								existingSales.rows.length
							) }
							checked={ skipExistingSales }
							disabled={ saving }
							onChange={ ( checked ) => {
								setSkipExistingSales( checked );
								setErrors( [] );
								setWarnings( [] );
								setAcknowledged( null );
							} }
						/>
					</Notice>
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
						title={ sprintf(
							/* translators: %d: number of rows */
							_n( '%d row would go below zero. Update anyway?', '%d rows would go below zero. Update anyway?', warnings.length, 'wp-woocommerce-products-list' ),
							warnings.length
						) }
					/>
				) : null }

				<EditErrors errors={ errors } items={ targetsForValidation } fieldLabels={ fieldLabels } />

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
							__next40pxDefaultSize
						>
							{ __( 'Update & next', 'wp-woocommerce-products-list' ) }
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
						_n( 'Discard %d unsaved change?', 'Discard %d unsaved changes?', pendingCount, 'wp-woocommerce-products-list' ),
						pendingCount
					) }
				</ConfirmDialog>
			) : null }
		</form>
	);
}

export default InlineEditor;
