/**
 * Quick edit (one row) and bulk edit (many rows) in one DataViews action
 * modal. Edits stay local until Save; Cancel discards (after a confirm when
 * something was typed). Save goes variations first then parents, with
 * progress; a partial failure keeps the modal open with the failed rows
 * listed and the next Save retries only those.
 */
import { Button, CheckboxControl, Notice, Spinner, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useCallback, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { KeyboardEvent } from 'react';
import { getVariations } from '../api/client';
import { DataForm, useFormValidity } from '../dataviews';
import type { RenderModalProps } from '../dataviews';
import { getSettings } from '../settings';
import { patchItems } from '../store/products';
import type { ProductField, ProductListItem, QuickEditTab } from '../types';
import { notify } from '../actions/notices';
import { fetchAllVariations, variationFetchFields } from './apply-to-variations';
import { editFetchFields, hydrateItems } from './hydrate';
import { projectWarnings, validateBulkNumericEdits, validateNumericOps } from './bulk-numeric';
import { ChangeSummary } from './change-summary';
import { isVariableParent, isVariation } from './field-value';
import { buildForm, buildTabs, fieldsOfTab, GENERAL_TAB_ID, tabOf, withScheduleSale } from './form-layouts';
import { labelsOf, toFormFields } from './form-fields';
import type { FormData } from './form-fields';
import { EditErrors, SaveProgress } from './progress';
import type { EditError } from './progress';
import { saveEdits } from './save';
import { undoBatch } from './undo';
import { useEditState } from './use-edit-state';
import { collectInvalidFields, revealInvalidControls } from './validity';
import { isSellableField, visibleEditFields } from './visibility';

export interface ProductEditModalProps extends RenderModalProps< ProductListItem > {
	/** The full field registry; the modal picks what applies. */
	fields: ProductField[];
}

type VariationLoad = { status: 'idle' | 'loading' | 'loaded' | 'error'; byParent: Map< number, ProductListItem[] >; count: number; error?: string };

const IDLE_LOAD: VariationLoad = { status: 'idle', byParent: new Map(), count: 0 };

const PANEL_ID = 'wc-pl-edit-panel';

function pick( edits: Record< string, unknown >, ids: Set< string > ): Record< string, unknown > {
	return Object.fromEntries( Object.entries( edits ).filter( ( [ id ] ) => ids.has( id ) ) );
}

function summary( items: ProductListItem[] ): string {
	const products = items.filter( ( item ) => ! isVariation( item ) ).length;
	const variations = items.length - products;

	if ( items.length === 1 ) {
		return ( items[ 0 ] as { name?: string } ).name ?? '';
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

type Hydration = { status: 'loading' | 'ready'; items: ProductListItem[] };

export function ProductEditModal( { items: selected, closeModal, onActionPerformed, fields: allFields }: ProductEditModalProps ) {
	const settings = getSettings();
	// The selection as DataViews hands it over, then the same rows reloaded
	// with every editable field (the list only carries the visible columns).
	// Keyed by the ids: DataViews passes a fresh array on every render.
	const selectedRows = useMemo( () => selected.filter( ( item ) => ! item._placeholder ), [ selected ] );
	const selectionKey = selectedRows.map( ( item ) => item.id ).join( ',' );
	const [ hydration, setHydration ] = useState< Hydration >( { status: 'loading', items: selectedRows } );
	const items = hydration.items;
	const bulk = items.length > 1;
	const mode = bulk ? 'bulk' : 'quick';

	useEffect( () => {
		let cancelled = false;
		const rows = selectedRows;

		setHydration( { status: 'loading', items: rows } );

		hydrateItems( rows, editFetchFields( allFields, rows, rows.length > 1 ? 'bulk' : 'quick' ) )
			.then( ( full ) => {
				if ( cancelled ) {
					return;
				}

				patchItems( full );
				setHydration( { status: 'ready', items: full } );
			} )
			.catch( ( error: unknown ) => {
				if ( cancelled ) {
					return;
				}

				notify.error( error instanceof Error ? error.message : __( 'The current values could not be loaded.', 'wp-woocommerce-products-list' ) );
				setHydration( { status: 'ready', items: rows } );
			} );

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- selectionKey stands for selectedRows
	}, [ selectionKey, allFields ] );

	const loading = hydration.status === 'loading';
	const variableParents = useMemo( () => items.filter( isVariableParent ), [ items ] );
	const trashed = useMemo( () => items.filter( ( item ) => item.status === 'trash' ).length, [ items ] );

	const [ applyToVariations, setApplyToVariations ] = useState( false );
	const [ tabId, setTabId ] = useState( GENERAL_TAB_ID );
	const [ errors, setErrors ] = useState< EditError[] >( [] );
	const [ warnings, setWarnings ] = useState< EditError[] >( [] );
	const [ acknowledged, setAcknowledged ] = useState< string | null >( null );
	const [ failedIds, setFailedIds ] = useState< Set< number > | null >( null );
	const [ confirmClose, setConfirmClose ] = useState( false );
	const [ saving, setSaving ] = useState( false );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	const [ variations, setVariations ] = useState< VariationLoad >( IDLE_LOAD );
	const mountedRef = useRef( true );
	const rootRef = useRef< HTMLFormElement >( null );
	const formRef = useRef< HTMLDivElement >( null );
	const focusedForRef = useRef< string | null >( null );

	useEffect( () => {
		mountedRef.current = true;

		return () => {
			mountedRef.current = false;
		};
	}, [] );

	// Another selection in the same modal instance starts clean.
	useEffect( () => {
		setErrors( [] );
		setWarnings( [] );
		setAcknowledged( null );
		setFailedIds( null );
		setTabId( GENERAL_TAB_ID );
	}, [ selectionKey ] );

	const fieldsWithToggle = useMemo( () => withScheduleSale( allFields ), [ allFields ] );
	const visibleFields = useMemo( () => visibleEditFields( fieldsWithToggle, items, { mode, applyToVariations } ), [ fieldsWithToggle, items, mode, applyToVariations ] );
	const state = useEditState( items, fieldsWithToggle, selectionKey );

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
	// so relative price ops and the sale < regular check see their current values.
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
	const fieldLabels = useMemo( () => labelsOf( fieldsWithToggle ), [ fieldsWithToggle ] );
	const tabLabels = useMemo( () => Object.fromEntries( tabs.map( ( entry ) => [ entry.id, entry.label ] ) ), [ tabs ] );
	const fieldTab = useCallback( ( fieldId: string ) => fieldsWithToggle.find( ( field ) => field.id === fieldId ), [ fieldsWithToggle ] );

	const onChange = useCallback(
		( changes: Record< string, unknown > ) => {
			state.setFields( changes );
			setErrors( [] );
			setWarnings( [] );
			setAcknowledged( null );
		},
		[ state ]
	);

	const targetsForValidation = useMemo( () => {
		if ( ! applyToVariations ) {
			return items;
		}

		return [ ...items, ...Array.from( variations.byParent.values() ).flat() ];
	}, [ applyToVariations, items, variations ] );

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

		return true;
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

		if ( applyToVariations && variableParents.length && variations.status !== 'loaded' ) {
			setErrors( [ { id: 0, message: variations.error ?? __( 'The variations are still loading.', 'wp-woocommerce-products-list' ) } ] );

			return;
		}

		const projected = validateBulkNumericEdits( targetsForValidation, pendingEdits, fieldsWithToggle, settings );

		if ( projected.length ) {
			setErrors( projected );

			return;
		}

		// Rows a decrease would push below zero are clamped; say so and ask once.
		const clamped = projectWarnings( targetsForValidation, pendingEdits, fieldsWithToggle, settings );
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
			const result = await saveEdits( retryTargets.items, pendingEdits, fieldsWithToggle, {
				applyToVariations,
				source: bulk ? 'bulk' : 'quick',
				prefetchedVariations: retryTargets.prefetched,
				onProgress: ( done, total ) => {
					if ( mountedRef.current ) {
						setProgress( { done, total } );
					}
				},
			} );

			const updated = result.updated.length;

			// The outcome is reported even when the modal was dismissed mid-save.
			if ( result.errors.length === 0 ) {
				notify.success(
					updated === 0
						? __( 'Nothing to change.', 'wp-woocommerce-products-list' )
						: sprintf(
								/* translators: %d: number of rows saved */
								_n( '%d item updated.', '%d items updated.', updated, 'wp-woocommerce-products-list' ),
								updated
						  ),
					updated > 0 ? { actions: [ { label: __( 'Undo', 'wp-woocommerce-products-list' ), onClick: () => void undoBatch( result.batchId ) } ] } : undefined
				);

				if ( mountedRef.current ) {
					onActionPerformed?.( items );
					closeModal?.();
				}

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
				setErrors( result.errors.map( ( error ) => ( { id: error.id, message: error.message } ) ) );
				setFailedIds( new Set( result.errors.map( ( error ) => error.id ) ) );
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

	const saveLabel = ( () => {
		if ( failedIds ) {
			/* translators: %d: number of rows that failed */
			return sprintf( _n( 'Retry %d failed', 'Retry %d failed', failedIds.size, 'wp-woocommerce-products-list' ), failedIds.size );
		}

		if ( warnings.length ) {
			return __( 'Save anyway', 'wp-woocommerce-products-list' );
		}

		if ( bulk ) {
			/* translators: %d: number of rows */
			return sprintf( _n( 'Save %d item', 'Save %d items', items.length, 'wp-woocommerce-products-list' ), items.length );
		}

		return __( 'Save', 'wp-woocommerce-products-list' );
	} )();

	return (
		<form
			ref={ rootRef }
			className="wc-pl-edit"
			aria-busy={ saving }
			onSubmit={ ( event ) => {
				event.preventDefault();
				void save();
			} }
		>
			<p className="wc-pl-edit__summary">{ summary( items ) }</p>

			{ needsEditOthers ? (
				<Notice status="warning" isDismissible={ false }>
					{ __( 'Saving several items at once needs the "edit others\' products" capability. Edit one item at a time, or ask an administrator.', 'wp-woocommerce-products-list' ) }
				</Notice>
			) : null }

			{ trashed > 0 ? (
				<Notice status="warning" isDismissible={ false }>
					{ sprintf(
						/* translators: %d: number of rows in the trash */
						_n( '%d of the selected items is in the trash; it will be updated too.', '%d of the selected items are in the trash; they will be updated too.', trashed, 'wp-woocommerce-products-list' ),
						trashed
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
						const selected = entry.id === tab.id;

						return (
							<button
								key={ entry.id }
								type="button"
								role="tab"
								id={ `wc-pl-edit-tab-${ entry.id }` }
								data-tab={ entry.id }
								aria-selected={ selected }
								aria-controls={ PANEL_ID }
								tabIndex={ selected ? 0 : -1 }
								className={ `components-button is-tertiary wc-pl-edit__tab${ selected ? ' is-active' : '' }` }
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

			{ bulk && pendingCount > 0 && ! loading ? <ChangeSummary edits={ pendingEdits } fields={ fieldsWithToggle } targets={ targetsForValidation } settings={ settings } applyToVariations={ applyToVariations } /> : null }

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
				<Button type="submit" variant="primary" isBusy={ saving } disabled={ saving || loading || needsEditOthers || ( pendingCount === 0 && ! state.hasInput ) } __next40pxDefaultSize>
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
