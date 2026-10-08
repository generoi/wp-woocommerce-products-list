/**
 * Quick edit (one row) and bulk edit (many rows) in one DataViews action
 * modal. Edits stay local until Save; Cancel discards. Save goes variations
 * first then parents, with progress; a partial failure keeps the modal open
 * with the failed rows listed.
 */
import { Button, CheckboxControl, Spinner } from '@wordpress/components';
import { useCallback, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { getVariations } from '../api/client';
import { DataForm, useFormValidity } from '../dataviews';
import type { RenderModalProps } from '../dataviews';
import { getSettings } from '../settings';
import { patchItems } from '../store/products';
import type { ProductField, ProductListItem, QuickEditTab } from '../types';
import { notify } from '../actions/notices';
import { fetchAllVariations, variationFetchFields } from './apply-to-variations';
import { editFetchFields, hydrateItems } from './hydrate';
import { validateBulkNumericEdits, validateNumericOps } from './bulk-numeric';
import { isVariableParent, isVariation } from './field-value';
import { buildForm, buildTabs, fieldsOfTab, GENERAL_TAB_ID, withScheduleSale } from './form-layouts';
import { labelsOf, toFormFields } from './form-fields';
import type { FormData } from './form-fields';
import { EditErrors, SaveProgress } from './progress';
import type { EditError } from './progress';
import { saveEdits } from './save';
import { useEditState } from './use-edit-state';
import { isSellableField, visibleEditFields } from './visibility';

export interface ProductEditModalProps extends RenderModalProps< ProductListItem > {
	/** The full field registry; the modal picks what applies. */
	fields: ProductField[];
}

type VariationLoad = { status: 'idle' | 'loading' | 'loaded' | 'error'; byParent: Map< number, ProductListItem[] >; count: number; error?: string };

const IDLE_LOAD: VariationLoad = { status: 'idle', byParent: new Map(), count: 0 };

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

	const [ applyToVariations, setApplyToVariations ] = useState( false );
	const [ tabId, setTabId ] = useState( GENERAL_TAB_ID );
	const [ errors, setErrors ] = useState< EditError[] >( [] );
	const [ saving, setSaving ] = useState( false );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	const [ variations, setVariations ] = useState< VariationLoad >( IDLE_LOAD );
	const mountedRef = useRef( true );

	useEffect( () => {
		mountedRef.current = true;

		return () => {
			mountedRef.current = false;
		};
	}, [] );

	const fieldsWithToggle = useMemo( () => withScheduleSale( allFields ), [ allFields ] );
	const visibleFields = useMemo( () => visibleEditFields( fieldsWithToggle, items, { mode, applyToVariations } ), [ fieldsWithToggle, items, mode, applyToVariations ] );
	const state = useEditState( items, fieldsWithToggle );

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

	const onChange = useCallback(
		( changes: Record< string, unknown > ) => {
			state.setFields( changes );
			setErrors( [] );
		},
		[ state ]
	);

	const targetsForValidation = useMemo( () => {
		if ( ! applyToVariations ) {
			return items;
		}

		return [ ...items, ...Array.from( variations.byParent.values() ).flat() ];
	}, [ applyToVariations, items, variations ] );

	const save = async () => {
		if ( pendingCount === 0 ) {
			closeModal?.();

			return;
		}

		const opErrors = validateNumericOps( pendingEdits, visibleFields, settings ).map( ( error ) => ( { id: 0, ...error } ) );

		if ( opErrors.length ) {
			setErrors( opErrors );

			return;
		}

		if ( ! bulk && ! isValid ) {
			setErrors( [ { id: 0, message: __( 'Fix the highlighted fields first.', 'wp-woocommerce-products-list' ) } ] );

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

		setSaving( true );
		setErrors( [] );
		setProgress( { done: 0, total: 0 } );

		try {
			const result = await saveEdits( items, pendingEdits, fieldsWithToggle, {
				applyToVariations,
				source: bulk ? 'bulk' : 'quick',
				prefetchedVariations: variations.byParent,
				onProgress: ( done, total ) => {
					if ( mountedRef.current ) {
						setProgress( { done, total } );
					}
				},
			} );

			if ( ! mountedRef.current ) {
				return;
			}

			const updated = result.updated.length;

			if ( result.errors.length === 0 ) {
				notify.success(
					updated === 0
						? __( 'Nothing to change.', 'wp-woocommerce-products-list' )
						: sprintf(
								/* translators: %d: number of rows saved */
								_n( '%d item updated.', '%d items updated.', updated, 'wp-woocommerce-products-list' ),
								updated
						  )
				);
				onActionPerformed?.( items );
				closeModal?.();

				return;
			}

			setErrors( result.errors.map( ( error ) => ( { id: error.id, message: error.message } ) ) );
			notify.error(
				sprintf(
					/* translators: 1: rows saved, 2: rows that failed */
					__( '%1$d updated, %2$d failed.', 'wp-woocommerce-products-list' ),
					updated,
					result.errors.length
				)
			);
		} catch ( error ) {
			if ( mountedRef.current ) {
				setErrors( [ { id: 0, message: error instanceof Error ? error.message : String( error ) } ] );
			}
		} finally {
			if ( mountedRef.current ) {
				setSaving( false );
			}
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

	return (
		<div className="wc-pl-edit" aria-busy={ saving }>
			<p className="wc-pl-edit__summary">{ summary( items ) }</p>

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
						} }
					/>
					{ variationNote }
				</div>
			) : null }

			{ tabs.length > 1 ? (
				<div className="wc-pl-edit__tabs" role="tablist" aria-label={ __( 'Edit sections', 'wp-woocommerce-products-list' ) }>
					{ tabs.map( ( entry ) => (
						<Button
							key={ entry.id }
							role="tab"
							aria-selected={ entry.id === tab.id }
							variant="tertiary"
							onClick={ () => setTabId( entry.id ) }
							__next40pxDefaultSize
						>
							{ entry.label }
							{ fieldsOfTab( visibleFields, entry ).some( ( field ) => field.id in pendingEdits ) ? ' •' : '' }
						</Button>
					) ) }
				</div>
			) : null }

			<div className="wc-pl-edit__form" role={ tabs.length > 1 ? 'tabpanel' : undefined } aria-busy={ loading }>
				{ loading ? (
					<p className="wc-pl-edit__note">
						<Spinner /> { __( 'Loading current values…', 'wp-woocommerce-products-list' ) }
					</p>
				) : visibleFields.length === 0 ? (
					<p>{ __( 'The selected rows share no editable fields.', 'wp-woocommerce-products-list' ) }</p>
				) : (
					<DataForm< FormData > data={ state.data } fields={ formFields } form={ form } onChange={ onChange } validity={ validity } />
				) }
			</div>

			<EditErrors errors={ errors } items={ targetsForValidation } fieldLabels={ fieldLabels } />
			<SaveProgress done={ progress.done } total={ progress.total } saving={ saving } />

			<div className="wc-pl-edit__footer">
				<Button variant="tertiary" onClick={ () => closeModal?.() } disabled={ saving } __next40pxDefaultSize>
					{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
				</Button>
				<Button variant="primary" onClick={ () => void save() } isBusy={ saving } disabled={ saving || loading || ( pendingCount === 0 && state.isDirty === false ) } __next40pxDefaultSize>
					{ bulk
						? sprintf(
								/* translators: %d: number of rows */
								_n( 'Save %d item', 'Save %d items', items.length, 'wp-woocommerce-products-list' ),
								items.length
						  )
						: __( 'Save', 'wp-woocommerce-products-list' ) }
				</Button>
			</div>
		</div>
	);
}

export default ProductEditModal;
