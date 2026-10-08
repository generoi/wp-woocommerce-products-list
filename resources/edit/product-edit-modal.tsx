/**
 * Quick edit (one row) and bulk edit (many rows) in one DataViews action
 * modal. Edits stay local until Save; Cancel (or Escape) discards after a
 * confirm when something was typed. Save goes variations first then
 * parents, with progress; a partial failure keeps the modal open, in the
 * mode it opened in, with the failed rows listed and the next Save
 * retrying only those.
 *
 * The rows the modal works on are the ones it opened with: the list trims
 * saved rows from the selection while the modal is still up, and following
 * that would turn a bulk edit of three into a quick edit of the one that
 * failed.
 */
import { Button, CheckboxControl, Notice, Spinner, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { KeyboardEvent } from 'react';
import { getVariations } from '../api/client';
import { DataForm, useFormValidity } from '../dataviews';
import type { RenderModalProps } from '../dataviews';
import { getSettings } from '../settings';
import { patchItems, removeItems } from '../store/products';
import type { ProductField, ProductListItem, QuickEditTab } from '../types';
import { notify } from '../actions/notices';
import { fetchAllVariations, variationFetchFields } from './apply-to-variations';
import { withArrayOps } from './bulk-array';
import { editFetchFields, hydrateSelection } from './hydrate';
import { projectWarnings, validateBulkNumericEdits, validateNumericOps } from './bulk-numeric';
import { ChangeSummary } from './change-summary';
import { isGoneCode } from './errors';
import { isVariableParent, isVariation } from './field-value';
import { buildForm, buildTabs, fieldsOfTab, GENERAL_TAB_ID, tabOf, withScheduleSale } from './form-layouts';
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
import { collectInvalidFields, focusFirstInvalidControl, revealInvalidControls } from './validity';
import { isSellableField, visibleEditFields } from './visibility';

export interface ProductEditModalProps extends RenderModalProps< ProductListItem > {
	/** The full field registry; the modal picks what applies. */
	fields: ProductField[];
}

type VariationLoad = { status: 'idle' | 'loading' | 'loaded' | 'error'; byParent: Map< number, ProductListItem[] >; count: number; error?: string };

const IDLE_LOAD: VariationLoad = { status: 'idle', byParent: new Map(), count: 0 };

const PANEL_ID = 'wc-pl-edit-panel';

/** How many item names a notice lists before "and N more". */
const NAMES_SHOWN = 5;

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

function summary( items: ProductListItem[] ): string {
	const products = items.filter( ( item ) => ! isVariation( item ) ).length;
	const variations = items.length - products;

	if ( items.length === 1 ) {
		return nameOf( items[ 0 ]! );
	}

	const parts: string[] = [];

	if ( products ) {
		/* translators: %d: number of products */
		parts.push( sprintf( _n( '%d product', '%d products', products, 'wp-woocommerce-products-list' ), products ) );
	}

	if ( variations ) {
		/* translators: %d: number of variations */
		parts.push( sprintf( _n( '%d variation', '%d variations', variations, 'wp-woocommerce-products-list' ), variations ) );
	}

	/* translators: %s: what is being edited, e.g. "3 products, 12 variations" */
	return sprintf( __( 'Editing %s', 'wp-woocommerce-products-list' ), parts.join( ', ' ) );
}

function focusFirstControl( root: HTMLElement | null ): void {
	const first = root?.querySelector< HTMLElement >( 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])' );

	first?.focus();
}

/** The Save button text for a plan: what will actually be written. */
export function saveLabelFor( plan: SavePlan ): string {
	const { products, variations } = plan;

	if ( products === 0 && variations === 0 ) {
		return __( 'Nothing to save', 'wp-woocommerce-products-list' );
	}

	if ( products > 0 && variations > 0 ) {
		/* translators: 1: number of products, 2: number of variations */
		return sprintf( __( 'Save %1$d products, %2$d variations', 'wp-woocommerce-products-list' ), products, variations );
	}

	if ( variations > 0 ) {
		/* translators: %d: number of variations */
		return sprintf( _n( 'Save %d variation', 'Save %d variations', variations, 'wp-woocommerce-products-list' ), variations );
	}

	/* translators: %d: number of products */
	return sprintf( _n( 'Save %d product', 'Save %d products', products, 'wp-woocommerce-products-list' ), products );
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

type Hydration = { status: 'loading' | 'ready'; items: ProductListItem[]; missing: ProductListItem[] };

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

export function ProductEditModal( { items: selected, closeModal, onActionPerformed, fields: allFields }: ProductEditModalProps ) {
	const settings = getSettings();
	// The rows the modal opened with (DataViews re-renders it with the live
	// selection, which the list trims while a save is still being looked at).
	const [ selectedRows ] = useState( () => selected.filter( ( item ) => ! item._placeholder ) );
	const selectionKey = selectedRows.map( ( item ) => item.id ).join( ',' );
	// The same rows reloaded with every editable field (the list only carries the visible columns).
	const [ hydration, setHydration ] = useState< Hydration >( { status: 'loading', items: selectedRows, missing: [] } );
	const items = hydration.items;
	const bulk = selectedRows.length > 1;
	const mode = bulk ? 'bulk' : 'quick';

	useEffect( () => {
		let cancelled = false;
		const rows = selectedRows;

		setHydration( { status: 'loading', items: rows, missing: [] } );

		hydrateSelection( rows, editFetchFields( allFields, rows, rows.length > 1 ? 'bulk' : 'quick' ) )
			.then( ( { items: full, missing } ) => {
				if ( cancelled ) {
					return;
				}

				const gone = new Set( missing );

				patchItems( full.filter( ( row ) => ! gone.has( row.id ) ) );

				// Rows deleted since the list loaded leave the list and the edit alike.
				if ( missing.length ) {
					removeItems( missing );
				}

				setHydration( { status: 'ready', items: full.filter( ( row ) => ! gone.has( row.id ) ), missing: full.filter( ( row ) => gone.has( row.id ) ) } );
			} )
			.catch( ( error: unknown ) => {
				if ( cancelled ) {
					return;
				}

				notify.error( error instanceof Error ? error.message : __( 'The current values could not be loaded.', 'wp-woocommerce-products-list' ) );
				setHydration( { status: 'ready', items: rows, missing: [] } );
			} );

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- selectionKey stands for selectedRows
	}, [ selectionKey, allFields ] );

	const loading = hydration.status === 'loading';
	const variableParents = useMemo( () => items.filter( isVariableParent ), [ items ] );
	const trashedRows = useMemo( () => items.filter( ( item ) => item.status === 'trash' ), [ items ] );

	const [ applyToVariations, setApplyToVariations ] = useState( false );
	const [ enableManageStock, setEnableManageStock ] = useState( false );
	const [ skipExistingSales, setSkipExistingSales ] = useState( false );
	const [ tabId, setTabId ] = useState( GENERAL_TAB_ID );
	const [ errors, setErrors ] = useState< EditError[] >( [] );
	const [ warnings, setWarnings ] = useState< EditError[] >( [] );
	const [ acknowledged, setAcknowledged ] = useState< string | null >( null );
	const [ failedIds, setFailedIds ] = useState< Set< number > | null >( null );
	const [ confirmClose, setConfirmClose ] = useState( false );
	const [ saving, setSaving ] = useState( false );
	const [ submitRequested, setSubmitRequested ] = useState( false );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	const [ variations, setVariations ] = useState< VariationLoad >( IDLE_LOAD );
	const mountedRef = useRef( true );
	const rootRef = useRef< HTMLFormElement >( null );
	const formRef = useRef< HTMLDivElement >( null );
	const focusedForRef = useRef< string | null >( null );
	const saveRef = useRef< () => Promise< void > >( async () => {} );

	useEffect( () => {
		mountedRef.current = true;

		return () => {
			mountedRef.current = false;
		};
	}, [] );

	const rowOptions = useMemo< RowEditOptions >( () => ( { enableManageStock, skipExistingSales } ), [ enableManageStock, skipExistingSales ] );
	const fieldsWithToggle = useMemo( () => withScheduleSale( allFields ), [ allFields ] );
	// Bulk mode adds the add/remove/replace select in front of the list fields.
	const editFields = useMemo( () => ( bulk ? withArrayOps( fieldsWithToggle ) : fieldsWithToggle ), [ fieldsWithToggle, bulk ] );
	const visibleFields = useMemo( () => visibleEditFields( editFields, items, { mode, applyToVariations } ), [ editFields, items, mode, applyToVariations ] );
	const state = useEditState( items, editFields, selectionKey );

	const tabs = useMemo( () => buildTabs( visibleFields, items, settings ), [ visibleFields, items, settings ] );
	const tab = useMemo< QuickEditTab >( () => tabs.find( ( entry ) => entry.id === tabId ) ?? tabs[ 0 ] ?? { id: GENERAL_TAB_ID, label: __( 'General', 'wp-woocommerce-products-list' ) }, [ tabs, tabId ] );
	const form = useMemo( () => buildForm( visibleFields, tab, items, settings ), [ visibleFields, tab, items, settings ] );
	const formFields = useMemo(
		() => toFormFields( visibleFields, { bulk, items, base: state.data, mixed: state.mixed, settings } ),
		// state.data changes on every keystroke; the placeholders only need the merged base, which state.mixed tracks.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ visibleFields, bulk, items, state.mixed, settings ]
	);
	const { validity, isValid } = useFormValidity< FormData >( state.data, formFields, form );

	// Keyboard focus moves into the dialog once the form is there (the modal opened on a spinner).
	useEffect( () => {
		if ( loading || focusedForRef.current === selectionKey ) {
			return;
		}

		focusedForRef.current = selectionKey;

		const root = rootRef.current;

		if ( root && ! root.contains( document.activeElement ) ) {
			focusFirstControl( formRef.current );
		}
	}, [ loading, selectionKey ] );

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

	const blockOnValidity = (): boolean => {
		if ( bulk || isValid ) {
			return false;
		}

		const invalid = collectInvalidFields( validity as Parameters< typeof collectInvalidFields >[ 0 ] );
		const list: EditError[] = invalid.map( ( entry ) => {
			const field = fieldTab( entry.field );
			const tabName = field ? tabLabels[ tabOf( field ) ] : undefined;

			return {
				id: 0,
				field: entry.field,
				message: tabName && tabs.length > 1 ? `${ entry.message } (${ tabName })` : entry.message,
			};
		} );

		setErrors( list.length ? list : [ { id: 0, message: __( 'Fix the highlighted fields first.', 'wp-woocommerce-products-list' ) } ] );

		const first = invalid[ 0 ] ? fieldTab( invalid[ 0 ].field ) : undefined;

		if ( first && tabOf( first ) !== tab.id ) {
			setTabId( tabOf( first ) );
		}

		revealInvalidControls( formRef.current );
		// After the tab (and the error state) rendered: the first invalid control gets the keyboard focus.
		setTimeout( () => {
			if ( mountedRef.current ) {
				focusFirstInvalidControl( formRef.current );
			}
		}, 0 );

		return true;
	};

	const finish = () => {
		if ( mountedRef.current ) {
			onActionPerformed?.( items );
			closeModal?.();
		}
	};

	const save = async () => {
		if ( saving || loading ) {
			return;
		}

		if ( pendingCount === 0 ) {
			if ( state.hasInput ) {
				notify.info( __( 'Nothing changed: the values equal the current ones.', 'wp-woocommerce-products-list' ) );
			}

			closeModal?.();

			return;
		}

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

		setSaving( true );
		setErrors( [] );
		setWarnings( [] );
		setProgress( { done: 0, total: 0 } );

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
			// Rows that no longer exist cannot be retried; they leave the list.
			const gone = result.errors.filter( ( error ) => isGoneCode( error.code ) ).map( ( error ) => error.id );

			if ( gone.length ) {
				removeItems( gone );
			}

			// The outcome is reported even when the modal was dismissed mid-save.
			if ( result.errors.length === 0 ) {
				notify.success( successMessage( result ), updated > 0 ? { actions: [ { label: __( 'Undo', 'wp-woocommerce-products-list' ), onClick: () => void undoBatch( result.batchId ) } ] } : undefined );
				finish();

				return;
			}

			notify.error(
				sprintf(
					/* translators: 1: rows saved, 2: rows that failed */
					__( '%1$d updated, %2$d failed.', 'wp-woocommerce-products-list' ),
					updated,
					result.errors.length
				)
			);

			if ( mountedRef.current ) {
				const goneSet = new Set( gone );

				setErrors(
					result.errors.map( ( error ) => ( {
						id: error.id,
						message: goneSet.has( error.id ) ? `${ error.message } ${ __( 'It was removed from the list.', 'wp-woocommerce-products-list' ) }` : error.message,
					} ) )
				);
				setFailedIds( new Set( result.errors.filter( ( error ) => ! goneSet.has( error.id ) ).map( ( error ) => error.id ) ) );
			}
		} catch ( error ) {
			notify.error( error instanceof Error ? error.message : String( error ) );

			if ( mountedRef.current ) {
				setErrors( [ { id: 0, message: error instanceof Error ? error.message : String( error ) } ] );
			}
		} finally {
			if ( mountedRef.current ) {
				setSaving( false );
			}
		}
	};

	useEffect( () => {
		saveRef.current = save;
	} );

	// Enter / Cmd+Enter asks for a save; it runs after the keystroke's own value change has rendered.
	useEffect( () => {
		if ( submitRequested ) {
			setSubmitRequested( false );
			void saveRef.current();
		}
	}, [ submitRequested ] );

	const requestClose = () => {
		if ( saving ) {
			return;
		}

		if ( state.hasInput && pendingCount > 0 ) {
			setConfirmClose( true );

			return;
		}

		closeModal?.();
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLFormElement > ) => {
		if ( event.key === 'Escape' ) {
			// The dialog closes on Escape unless the event was handled: a dirty form asks first, a save in progress cannot be left.
			if ( saving || ( state.hasInput && pendingCount > 0 ) ) {
				event.preventDefault();
				event.stopPropagation();

				if ( ! saving ) {
					setConfirmClose( true );
				}
			}

			return;
		}

		if ( event.key !== 'Enter' || event.shiftKey || event.altKey ) {
			return;
		}

		const modifier = event.metaKey || event.ctrlKey;

		// Plain Enter in a single-line field saves, as in the classic quick edit; Cmd/Ctrl+Enter from anywhere (a textarea too).
		if ( ! modifier && ! isTextEntry( event.target ) ) {
			return;
		}

		event.preventDefault();
		setSubmitRequested( true );
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

	const saveLabel = ( () => {
		if ( failedButNothingToRetry ) {
			return __( 'Close', 'wp-woocommerce-products-list' );
		}

		if ( failedIds ) {
			/* translators: %d: number of rows that failed */
			return sprintf( _n( 'Retry %d failed', 'Retry %d failed', retryable, 'wp-woocommerce-products-list' ), retryable );
		}

		if ( warnings.length ) {
			return __( 'Save anyway', 'wp-woocommerce-products-list' );
		}

		if ( ! bulk ) {
			return __( 'Save', 'wp-woocommerce-products-list' );
		}

		if ( plan ) {
			return saveLabelFor( plan );
		}

		/* translators: %d: number of rows */
		return sprintf( _n( 'Save %d item', 'Save %d items', items.length, 'wp-woocommerce-products-list' ), items.length );
	} )();

	return (
		<form
			ref={ rootRef }
			className="wc-pl-edit"
			aria-busy={ saving }
			onKeyDown={ onKeyDown }
			onSubmit={ ( event ) => {
				event.preventDefault();

				if ( failedButNothingToRetry ) {
					finish();

					return;
				}

				void save();
			} }
		>
			<p className="wc-pl-edit__summary">{ summary( items ) }</p>

			{ needsEditOthers ? (
				<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice">
					{ __( 'Saving several items at once needs the "edit others\' products" capability. Edit one item at a time, or ask an administrator.', 'wp-woocommerce-products-list' ) }
				</Notice>
			) : null }

			{ hydration.missing.length > 0 ? (
				<Notice status="warning" isDismissible={ false } className="wc-pl-edit__notice">
					{ sprintf(
						/* translators: 1: number of rows, 2: their names */
						_n( '%1$d of the selected items no longer exists and was left out: %2$s', '%1$d of the selected items no longer exist and were left out: %2$s', hydration.missing.length, 'wp-woocommerce-products-list' ),
						hydration.missing.length,
						listNames( hydration.missing )
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
				aria-busy={ loading }
			>
				{ loading ? (
					<p className="wc-pl-edit__note">
						<Spinner /> { __( 'Loading current values…', 'wp-woocommerce-products-list' ) }
					</p>
				) : visibleFields.length === 0 ? (
					<p>{ __( 'The selected rows share no editable fields.', 'wp-woocommerce-products-list' ) }</p>
				) : (
					<DataForm< FormData > key={ selectionKey } data={ state.data } fields={ formFields } form={ form } onChange={ onChange } validity={ validity } />
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
						_n( '%d row would go below zero. Save anyway?', '%d rows would go below zero. Save anyway?', warnings.length, 'wp-woocommerce-products-list' ),
						warnings.length
					) }
				/>
			) : null }

			<EditErrors errors={ errors } items={ targetsForValidation } fieldLabels={ fieldLabels } />
			<SaveProgress done={ progress.done } total={ progress.total } saving={ saving } />

			<div className="wc-pl-edit__footer">
				<Button type="button" variant="tertiary" onClick={ requestClose } disabled={ saving } __next40pxDefaultSize>
					{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
				</Button>
				<Button
					type="submit"
					variant="primary"
					isBusy={ saving }
					disabled={ saving || loading || needsEditOthers || ( ! failedButNothingToRetry && ( ( pendingCount === 0 && ! state.hasInput ) || nothingToWrite ) ) }
					__next40pxDefaultSize
				>
					{ saveLabel }
				</Button>
			</div>

			{ confirmClose ? (
				<ConfirmDialog
					isOpen
					confirmButtonText={ __( 'Discard changes', 'wp-woocommerce-products-list' ) }
					cancelButtonText={ __( 'Keep editing', 'wp-woocommerce-products-list' ) }
					onConfirm={ () => {
						setConfirmClose( false );
						closeModal?.();
					} }
					onCancel={ () => setConfirmClose( false ) }
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

export default ProductEditModal;
