/**
 * Catalog → History. Lands on the batches (one row per gesture: what
 * changed on how many items, who, when, failures, reverted since); "Show
 * changes" opens the per-field rows of a batch. The changes view lists
 * every change made through the list, newest first,
 * filterable by time, item, source, action, field and batch, with
 * "Revert batch" (rows with a field of an update or of an extension action
 * such as a translation copy; trash/restore/delete/duplicate rows are
 * reported as skipped by the server).
 */
import { Button, Spinner, __experimentalToggleGroupControl as ToggleGroupControl, __experimentalToggleGroupControlOption as ToggleGroupControlOption } from '@wordpress/components';
import { dateI18n } from '@wordpress/date';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { getQueryArg } from '@wordpress/url';
import { ApiError, getLog, getLogUsers, getRevertPlan } from '../api/client';
import type { LogRow as LogRowType, RevertedBy, RevertPlan } from '../api/client';
import { notify } from '../actions/notices';
import { DataViews } from '../dataviews';
import type { Action, Filter, RenderModalProps, View } from '../dataviews';
import { useReturnFocus } from '../edit/focus';
import { SaveProgress } from '../edit/progress';
import { getSettings } from '../settings';
import { logFieldLabel, logFieldOptions } from '../fields/log-labels';
import type { LogFieldOption } from '../fields/log-labels';
import type { ProductField, Settings } from '../types';
import { invalidateProducts } from '../store/products';
import { Notices } from '../ui';
import { actionLabel, createLogFields, formatLogValue, logQueryFromView } from './log-fields';
import { describeBatchScope, isRevertableRow, itemsLeftToRevert, scopeFromPlan } from './batch-scope';
import { checkRevertPlan, describeConflict, relativeConflicts, runRevert } from './revert';
import type { RevertCheckSummary, RevertOutcome } from './revert';
import { batchQueryFromView, createBatchFields } from './batch-fields';
import { invalidateLog, useLog, useLogBatches } from './use-log';
import { filtersFromUrl, syncUrl } from './url-state';
import type { LogBatch, LogRow } from './use-log';
import '../edit/style.scss';

const TABLE_FIELDS = [ 'user', 'object', 'source', 'action', 'field', 'change', 'status', 'batch_id' ];

const BATCH_FIELDS = [ 'user', 'source', 'changes', 'result', 'reverted', 'batch_id' ];

/** What the revert confirm needs of a batch: a log row of it, or the batch summary itself. */
export interface RevertTarget {
	batch_id: string;
	created_at: string;
	created_at_gmt?: string;
	user: { id: number; name: string };
	reverted_by?: RevertedBy | null;
}

/** A log row's time in the site's date/time format and timezone (the same the table shows), from the GMT stamp when the row carries one. */
export function formatLogTime( row: { created_at: string; created_at_gmt?: string }, settings: Pick< Settings, 'dateFormat' | 'timeFormat' > ): string {
	const gmt = row.created_at_gmt ? `${ row.created_at_gmt.replace( ' ', 'T' ) }Z` : '';
	const source = gmt || row.created_at;

	if ( ! source ) {
		return '';
	}

	try {
		return dateI18n( `${ settings.dateFormat } ${ settings.timeFormat }`, source );
	} catch {
		return row.created_at;
	}
}

function initialFilters(): Filter[] {
	return filtersFromUrl( typeof window !== 'undefined' ? window.location.href : '' ).filters;
}

function initialSearch(): string {
	return filtersFromUrl( typeof window !== 'undefined' ? window.location.href : '' ).search;
}

function revertLabel( done: number, total: number ): string {
	return sprintf(
		/* translators: 1: items put back so far, 2: items in total */
		__( 'Reverting %1$d of %2$d…', 'wp-woocommerce-products-list' ),
		done,
		total
	);
}

/** The field labels of the log keys (Quantity, Sale price), for the revert confirm. */
const FieldOptionsContext = createContext< LogFieldOption[] >( [] );

/** The labels of the fields the conflicting objects changed again, for the summary line. */
export function conflictFields( outcome: Pick< RevertOutcome, 'conflicts' >, options: LogFieldOption[] = [] ): string[] {
	const labels = new Set< string >();

	for ( const result of outcome.conflicts ) {
		( result.fields ?? [] ).forEach( ( key, index ) => labels.add( result.labels?.[ index ] || logFieldLabel( key, options ) ) );
	}

	return Array.from( labels );
}

/** How many changes the revert confirm previews. */
const PREVIEW_ROWS = 5;

/** "Pelsi Black 37: Quantity 12 → 2": what the revert puts back, for the first few changes of the batch. */
function RevertPreview( { batchId, options }: { batchId: string; options: LogFieldOption[] } ) {
	const settings = getSettings();
	const [ preview, setPreview ] = useState< { rows: LogRowType[]; total: number } | null >( null );

	useEffect( () => {
		let cancelled = false;

		getLog( { batch: batchId, per_page: 20 } )
			.then( ( result ) => {
				if ( ! cancelled ) {
					const rows = result.items.filter( isRevertableRow );

					setPreview( { rows: rows.slice( 0, PREVIEW_ROWS ), total: Math.max( rows.length, result.total - ( result.items.length - rows.length ) ) } );
				}
			} )
			.catch( () => {
				if ( ! cancelled ) {
					setPreview( null );
				}
			} );

		return () => {
			cancelled = true;
		};
	}, [ batchId ] );

	if ( ! preview || ! preview.rows.length ) {
		return null;
	}

	const more = preview.total - preview.rows.length;

	return (
		<div className="wc-pl-confirm__preview">
			<p>{ __( 'For example (value this batch set → value it goes back to):', 'wp-woocommerce-products-list' ) }</p>
			<ul>
				{ preview.rows.map( ( row ) => (
					<li key={ row.id }>
						<strong>{ row.object_name || `#${ row.object_id }` }</strong>: { logFieldLabel( row.field, options ) }{ ' ' }
						{ formatLogValue( row.field, row.new_value, settings ) } → { formatLogValue( row.field, row.old_value, settings ) }
					</li>
				) ) }
			</ul>
			{ more > 0 ? (
				<p>
					{ sprintf(
						/* translators: %d: number of further changes */
						_n( '…and %d more change.', '…and %d more changes.', more, 'wp-woocommerce-products-list' ),
						more
					) }
				</p>
			) : null }
		</div>
	);
}

function RevertModal< T extends RevertTarget >( { items, closeModal, onActionPerformed }: RenderModalProps< T > ) {
	const settings = getSettings();
	const fieldOptions = useContext( FieldOptionsContext );
	const row = items[ 0 ];
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );
	const [ plan, setPlan ] = useState< RevertPlan | null | 'loading' >( 'loading' );
	// Why the plan could not be loaded, when the server said (a batch still being written, a revert already running).
	const [ planError, setPlanError ] = useState< string | null >( null );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	// Set when a pass left conflicts behind: the summary and "Revert anyway".
	const [ outcome, setOutcome ] = useState< RevertOutcome | null >( null );
	// The dry run: items changed again since the batch, known before Revert is pressed.
	const [ check, setCheck ] = useState< RevertCheckSummary | null | 'loading' >( null );
	const batchId = row?.batch_id;
	// Already put back once: a second revert re-applies the batch's values over the first revert.
	const revertedByAny = ( plan && plan !== 'loading' ? plan.reverted_by : null ) ?? row?.reverted_by ?? null;
	// The revert just run here is not news: no "already reverted" warning for it.
	const revertedBy = revertedByAny && outcome && revertedByAny.batch_id === outcome.revertBatchId ? null : revertedByAny;

	useReturnFocus();

	useEffect( () => {
		if ( ! batchId ) {
			setPlan( null );

			return;
		}

		let cancelled = false;

		setPlan( 'loading' );
		setPlanError( null );

		// What the revert writes, from the log itself: exact for any batch size, and the chunks to post.
		getRevertPlan( batchId )
			.then( ( loaded ) => {
				if ( ! cancelled ) {
					setPlan( loaded );
				}
			} )
			.catch( ( caught: unknown ) => {
				if ( ! cancelled ) {
					setPlan( null );
					// 409 wc_products_list_batch_running: the save is still writing this batch (another tab, another user).
					setPlanError( caught instanceof ApiError && caught.status === 409 ? caught.message : null );
				}
			} );

		return () => {
			cancelled = true;
		};
	}, [ batchId ] );

	useEffect( () => {
		if ( ! batchId || ! plan || plan === 'loading' || ! plan.revertable || ! plan.objects ) {
			setCheck( null );

			return;
		}

		const controller = new AbortController();

		setCheck( 'loading' );
		checkRevertPlan( batchId, plan, undefined, controller.signal )
			.then( ( summary ) => {
				if ( ! controller.signal.aborted ) {
					setCheck( summary );
				}
			} )
			.catch( () => {
				if ( ! controller.signal.aborted ) {
					setCheck( null );
				}
			} );

		return () => controller.abort();
	}, [ batchId, plan ] );

	const finish = ( result: RevertOutcome ) => {
		invalidateProducts( { counts: true } );
		invalidateLog();

		if ( result.ok && ! result.failed.length ) {
			notify.success(
				sprintf(
					/* translators: %d: number of items reverted */
					_n( '%d item reverted.', '%d items reverted.', result.ok, 'wp-woocommerce-products-list' ),
					result.ok
				)
			);
		}

		if ( result.failed.length ) {
			notify.error(
				sprintf(
					/* translators: 1: items reverted, 2: items that failed, 3: the first failure's message */
					__( '%1$d reverted, %2$d failed: %3$s', 'wp-woocommerce-products-list' ),
					result.ok,
					result.failed.length,
					result.failed[ 0 ]?.message ?? __( 'Some items could not be reverted.', 'wp-woocommerce-products-list' )
				)
			);
		}

		onActionPerformed?.( items );
		closeModal?.();
	};

	const confirm = async ( force: false | 'force' | 'relative' = false ) => {
		if ( ! row || ! plan || plan === 'loading' ) {
			return;
		}

		setBusy( true );
		setError( null );

		try {
			const retry = force && outcome ? ( force === 'relative' ? relativeConflicts( outcome.conflicts ) : outcome.conflicts ) : [];
			const result =
				force && outcome
					? await runRevert( row.batch_id, plan, {
							ids: retry.map( ( conflict ) => conflict.id ),
							...( force === 'relative' ? { relative: true } : { force: true } ),
							revertBatchId: outcome.revertBatchId,
							onProgress: ( done, total ) => setProgress( { done, total } ),
					  } )
					: await runRevert( row.batch_id, plan, { onProgress: ( done, total ) => setProgress( { done, total } ) } );

			if ( force && outcome ) {
				const left = outcome.conflicts.filter( ( conflict ) => ! retry.includes( conflict ) );
				const merged: RevertOutcome = { ...result, ok: result.ok + outcome.ok, failed: [ ...outcome.failed, ...result.failed ], skipped: outcome.skipped, conflicts: [ ...left, ...result.conflicts ] };

				// The second pass completes the first one; conflicts it did not cover stay on offer.
				if ( merged.conflicts.length ) {
					invalidateProducts( { counts: true } );
					invalidateLog();
					setOutcome( merged );
					setBusy( false );

					return;
				}

				finish( merged );

				return;
			}

			if ( result.conflicts.length === 0 ) {
				finish( result );

				return;
			}

			// Some fields were changed again since; say so and offer to overwrite them.
			invalidateProducts( { counts: true } );
			invalidateLog();
			setOutcome( result );
			setBusy( false );
		} catch ( caught ) {
			setBusy( false );
			setError( caught instanceof Error ? caught.message : __( 'The revert failed.', 'wp-woocommerce-products-list' ) );
		}
	};

	const closeAfterConflicts = () => {
		if ( outcome ) {
			onActionPerformed?.( items );
		}

		closeModal?.();
	};

	// Items the check found changed since the batch: the revert leaves them as they are, so they are not "put back".
	const keptItems = ! outcome && check && check !== 'loading' ? check.changed : 0;
	const nothingLeft = keptItems > 0 && !! plan && plan !== 'loading' && itemsLeftToRevert( { objects: plan.objects }, keptItems ) === 0;

	return (
		<div className="wc-pl-confirm">
			<p>
				{ __( 'Put back the previous values of every field this batch changed? Trash, restore, delete and duplicate entries are not reverted. The revert is logged as a new batch.', 'wp-woocommerce-products-list' ) }
			</p>
			{ row ? (
				<p>
					<code>{ row.batch_id }</code> · { row.user?.name } · { formatLogTime( row, settings ) }
				</p>
			) : null }
			{ revertedBy ? (
				<p className="wc-pl-confirm__warning" role="status">
					<strong>
						{ sprintf(
							/* translators: 1: user name, 2: date and time */
							__( 'This batch was already reverted by %1$s at %2$s.', 'wp-woocommerce-products-list' ),
							revertedBy.user?.name || `#${ revertedBy.user?.id ?? 0 }`,
							formatLogTime( revertedBy, settings )
						) }
					</strong>{ ' ' }
					{ __( 'Reverting it again puts back the values from before this batch a second time; to undo the revert, revert the revert batch instead.', 'wp-woocommerce-products-list' ) }
				</p>
			) : null }
			<p className="wc-pl-confirm__scope" aria-live="polite">
				{ plan === 'loading' ? (
					<>
						<Spinner /> { __( 'Checking what the batch changed…', 'wp-woocommerce-products-list' ) }
					</>
				) : plan ? (
					<strong>{ describeBatchScope( scopeFromPlan( plan, ( action ) => actionLabel( action, settings ) ), keptItems ) }</strong>
				) : (
					planError ?? __( 'The scope of this batch could not be loaded.', 'wp-woocommerce-products-list' )
				) }
			</p>
			{ ! outcome && check === 'loading' ? (
				<p className="wc-pl-confirm__scope" aria-live="polite">
					<Spinner /> { __( 'Checking for changes made since this batch…', 'wp-woocommerce-products-list' ) }
				</p>
			) : null }
			{ ! outcome && check && check !== 'loading' && check.changed > 0 ? (
				<div className="wc-pl-confirm__warning" role="status">
					<p>
						{ check.changed - check.alreadyReverted > 0
							? sprintf(
									/* translators: %d: number of items */
									_n(
										'%d item changed since this batch (by an order or another edit) and will be left as it is.',
										'%d items changed since this batch (by an order or another edit) and will be left as they are.',
										check.changed - check.alreadyReverted,
										'wp-woocommerce-products-list'
									),
									check.changed - check.alreadyReverted
							  )
							: null }{ ' ' }
						{ check.alreadyReverted > 0
							? sprintf(
									/* translators: %d: number of items */
									_n( '%d already put back by an earlier revert.', '%d already put back by an earlier revert.', check.alreadyReverted, 'wp-woocommerce-products-list' ),
									check.alreadyReverted
							  )
							: null }
					</p>
					{ check.example ? (
						<p>
							{ sprintf(
								/* translators: %s: one item changed since the batch, e.g. "Pelsi 38: Stock quantity 10 → 9 kept" */
								__( 'Changed since: %s', 'wp-woocommerce-products-list' ),
								describeConflict( check.example, ( key ) => logFieldLabel( key, fieldOptions ) )
							) }
						</p>
					) : null }
				</div>
			) : null }
			<SaveProgress done={ progress.done } total={ progress.total } saving={ busy } label={ revertLabel } />
			{ ! outcome && batchId && plan && plan !== 'loading' && plan.revertable ? <RevertPreview batchId={ batchId } options={ fieldOptions } /> : null }
			{ outcome ? (
				<div className="wc-pl-confirm__conflicts" role="status">
					<p>
						{ sprintf(
							/* translators: 1: items put back, 2: items left alone, 3: the field names */
							_n(
								'%1$d put back. %2$d item was changed again after this batch (%3$s) and was left as it is:',
								'%1$d put back. %2$d items were changed again after this batch (%3$s) and were left as they are:',
								outcome.conflicts.length,
								'wp-woocommerce-products-list'
							),
							outcome.ok,
							outcome.conflicts.length,
							conflictFields( outcome, fieldOptions ).join( ', ' )
						) }
					</p>
					<ul>
						{ outcome.conflicts.slice( 0, 10 ).map( ( conflict ) => (
							<li key={ conflict.id }>{ describeConflict( conflict, ( key ) => logFieldLabel( key, fieldOptions ) ) }</li>
						) ) }
					</ul>
					{ outcome.conflicts.length > 10 ? (
						<p>
							{ sprintf(
								/* translators: %d: number of further items */
								_n( '…and %d more.', '…and %d more.', outcome.conflicts.length - 10, 'wp-woocommerce-products-list' ),
								outcome.conflicts.length - 10
							) }
						</p>
					) : null }
				</div>
			) : null }
			{ error ? (
				<p className="wc-pl-confirm__error" role="alert">
					{ error }
				</p>
			) : null }
			<div className="wc-pl-edit__footer">
				<Button variant="tertiary" onClick={ closeAfterConflicts } disabled={ busy } __next40pxDefaultSize>
					{ outcome ? __( 'Keep them', 'wp-woocommerce-products-list' ) : __( 'Cancel', 'wp-woocommerce-products-list' ) }
				</Button>
				{ outcome && relativeConflicts( outcome.conflicts ).length ? (
					<Button variant="secondary" isBusy={ busy } disabled={ busy } onClick={ () => void confirm( 'relative' ) } __next40pxDefaultSize>
						{ __( 'Subtract the change instead', 'wp-woocommerce-products-list' ) }
					</Button>
				) : null }
				{ outcome ? (
					<Button variant="primary" isDestructive isBusy={ busy } disabled={ busy } onClick={ () => void confirm( 'force' ) } __next40pxDefaultSize>
						{ sprintf(
							/* translators: %d: number of items */
							_n( 'Revert %d anyway', 'Revert %d anyway', outcome.conflicts.length, 'wp-woocommerce-products-list' ),
							outcome.conflicts.length
						) }
					</Button>
				) : (
					<Button variant="primary" isBusy={ busy } disabled={ busy || ! row || plan === 'loading' || ! plan || ! plan.revertable || nothingLeft } onClick={ () => void confirm() } __next40pxDefaultSize>
						{ revertedBy ? __( 'Revert again', 'wp-woocommerce-products-list' ) : __( 'Revert batch', 'wp-woocommerce-products-list' ) }
					</Button>
				) }
			</div>
		</div>
	);
}

type HistoryMode = 'batches' | 'changes';

function initialMode(): HistoryMode {
	const href = typeof window !== 'undefined' ? window.location.href : '';

	const named = filtersFromUrl( href );

	return named.filters.length || named.search || getQueryArg( href, 'view' ) === 'changes' ? 'changes' : 'batches';
}

function EmptyLog( { error, filtered, onReset }: { error?: Error; filtered: boolean; onReset: () => void } ) {
	if ( error ) {
		return <p className="wc-products-list__empty">{ error.message }</p>;
	}

	if ( filtered ) {
		return (
			<div className="wc-products-list__empty">
				<p>{ __( 'No changes match these filters.', 'wp-woocommerce-products-list' ) }</p>
				<Button variant="secondary" onClick={ onReset } __next40pxDefaultSize>
					{ __( 'Reset filters', 'wp-woocommerce-products-list' ) }
				</Button>
			</div>
		);
	}

	return <p className="wc-products-list__empty">{ __( 'No changes logged yet. Every edit made through the catalog shows up here.', 'wp-woocommerce-products-list' ) }</p>;
}

export function HistoryScreen( { fields: productFields = [] }: { fields?: ProductField[] } ) {
	const settings = getSettings();
	const [ mode, setMode ] = useState< HistoryMode >( initialMode );
	const [ view, setView ] = useState< View >( () => ( {
		type: 'table',
		page: 1,
		perPage: 50,
		titleField: 'created_at',
		fields: TABLE_FIELDS,
		filters: initialFilters(),
		search: initialSearch(),
		layout: { density: 'compact' },
	} ) );
	const [ batchView, setBatchView ] = useState< View >( () => ( {
		type: 'table',
		page: 1,
		perPage: 25,
		titleField: 'created_at',
		fields: BATCH_FIELDS,
		filters: [],
		layout: { density: 'compact' },
	} ) );
	const [ users, setUsers ] = useState< Array< { id: number; name: string } > >( [] );
	const fieldOptions = useMemo( () => logFieldOptions( productFields ), [ productFields ] );
	const fields = useMemo( () => createLogFields( settings, { users, fieldOptions } ), [ settings, users, fieldOptions ] );
	const batchFields = useMemo( () => createBatchFields( settings, { users, fieldOptions, formatTime: ( stamp ) => formatLogTime( stamp, settings ) } ), [ settings, users, fieldOptions ] );

	useEffect( () => {
		let cancelled = false;

		getLogUsers()
			.then( ( list ) => {
				if ( ! cancelled ) {
					setUsers( list );
				}
			} )
			.catch( () => {} );

		return () => {
			cancelled = true;
		};
	}, [] );

	useEffect( () => {
		const title = __( 'History', 'wp-woocommerce-products-list' );
		const previous = document.title;

		document.title = document.title.includes( title ) ? document.title : `${ title } ‹ ${ document.title }`;

		return () => {
			document.title = previous;
		};
	}, [] );
	// The changes view's filters live in the URL: a filtered view is a link to hand on.
	useEffect( () => {
		syncUrl( view, mode );
	}, [ view, mode ] );

	const query = useMemo( () => logQueryFromView( view ), [ view ] );
	const log = useLog( query, { enabled: mode === 'changes' } );
	const batchQuery = useMemo( () => batchQueryFromView( batchView ), [ batchView ] );
	const batches = useLogBatches( batchQuery, { enabled: mode === 'batches' } );

	const showBatch = useCallback(
		( batchId: string ) => {
			setView( ( current ) => ( { ...current, page: 1, filters: [ ...( current.filters ?? [] ).filter( ( filter ) => filter.field !== 'batch_id' ), { field: 'batch_id', operator: 'is', value: batchId } ] } ) );
			setMode( 'changes' );
		},
		[ setView ]
	);

	const resetFilters = useCallback( () => setView( ( current ) => ( { ...current, page: 1, search: '', filters: [] } ) ), [] );
	const resetBatchFilters = useCallback( () => setBatchView( ( current ) => ( { ...current, page: 1, search: '', filters: [] } ) ), [] );

	const actions = useMemo< Action< LogRow >[] >(
		() => [
			{
				id: 'show-batch',
				label: __( 'Show this batch', 'wp-woocommerce-products-list' ),
				supportsBulk: false,
				callback: ( items ) => {
					if ( items[ 0 ] ) {
						showBatch( items[ 0 ].batch_id );
					}
				},
			},
			{
				id: 'open-item',
				label: __( 'Edit item', 'wp-woocommerce-products-list' ),
				supportsBulk: false,
				isEligible: ( item ) => Boolean( item.edit_link ),
				callback: ( items ) => {
					if ( items[ 0 ]?.edit_link ) {
						window.location.assign( items[ 0 ].edit_link );
					}
				},
			},
			{
				id: 'revert-batch',
				label: __( 'Revert batch', 'wp-woocommerce-products-list' ),
				supportsBulk: false,
				isEligible: ( item ) => isRevertableRow( item ) && settings.caps.edit,
				RenderModal: RevertModal,
				modalHeader: __( 'Revert batch', 'wp-woocommerce-products-list' ),
				modalSize: 'medium',
			},
		],
		[ showBatch, settings.caps.edit ]
	);

	const batchActions = useMemo< Action< LogBatch >[] >(
		() => [
			{
				id: 'show-changes',
				label: __( 'Show changes', 'wp-woocommerce-products-list' ),
				isPrimary: true,
				supportsBulk: false,
				callback: ( items ) => {
					if ( items[ 0 ] ) {
						showBatch( items[ 0 ].batch_id );
					}
				},
			},
			{
				id: 'revert-batch',
				label: __( 'Revert batch', 'wp-woocommerce-products-list' ),
				supportsBulk: false,
				isEligible: ( item ) => item.revertable && settings.caps.edit,
				RenderModal: RevertModal,
				modalHeader: __( 'Revert batch', 'wp-woocommerce-products-list' ),
				modalSize: 'medium',
			},
		],
		[ showBatch, settings.caps.edit ]
	);

	const header = (
		<div className="wc-products-list__header">
			<Button variant="tertiary" size="compact" href={ settings.links.page }>
				{ __( '← All Products (New)', 'wp-woocommerce-products-list' ) }
			</Button>
		</div>
	);

	return (
		<FieldOptionsContext.Provider value={ fieldOptions }>
		<div className="wc-products-list wc-pl-history">
			<h1 className="wc-pl-history__title">{ __( 'History', 'wp-woocommerce-products-list' ) }</h1>
			<ToggleGroupControl
				className="wc-pl-history__mode"
				label={ __( 'Show', 'wp-woocommerce-products-list' ) }
				hideLabelFromVision
				isBlock={ false }
				value={ mode }
				onChange={ ( next ) => setMode( next === 'changes' ? 'changes' : 'batches' ) }
				__next40pxDefaultSize
				__nextHasNoMarginBottom
			>
				<ToggleGroupControlOption value="batches" label={ __( 'Batches', 'wp-woocommerce-products-list' ) } />
				<ToggleGroupControlOption value="changes" label={ __( 'All changes', 'wp-woocommerce-products-list' ) } />
			</ToggleGroupControl>
			{ mode === 'batches' ? (
				<DataViews< LogBatch >
					key="batches"
					data={ batches.items }
					fields={ batchFields }
					view={ batchView }
					onChangeView={ setBatchView }
					getItemId={ ( batch ) => batch.batch_id }
					paginationInfo={ { totalItems: batches.total, totalPages: batches.totalPages } }
					defaultLayouts={ { table: { titleField: 'created_at' } } }
					actions={ batchActions }
					isLoading={ batches.isLoading }
					search
					searchLabel={ __( 'Search product names and values', 'wp-woocommerce-products-list' ) }
					header={ header }
					config={ { perPageSizes: [ 25, 50, 100 ] } }
					empty={ <EmptyLog error={ batches.error } filtered={ Boolean( batchView.filters?.length || batchView.search ) } onReset={ resetBatchFilters } /> }
				/>
			) : (
				<DataViews< LogRow >
					key="changes"
					data={ log.items }
					fields={ fields }
					view={ view }
					onChangeView={ setView }
					getItemId={ ( row ) => String( row.id ) }
					paginationInfo={ { totalItems: log.total, totalPages: log.totalPages } }
					defaultLayouts={ { table: { titleField: 'created_at' } } }
					actions={ actions }
					isLoading={ log.isLoading }
					search
					searchLabel={ __( 'Search product names and values', 'wp-woocommerce-products-list' ) }
					header={ header }
					config={ { perPageSizes: [ 25, 50, 100 ] } }
					empty={ <EmptyLog error={ log.error } filtered={ Boolean( view.filters?.length || view.search ) } onReset={ resetFilters } /> }
				/>
			) }
			<Notices />
		</div>
		</FieldOptionsContext.Provider>
	);
}

export default HistoryScreen;
