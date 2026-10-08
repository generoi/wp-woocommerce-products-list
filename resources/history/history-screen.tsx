/**
 * Catalog → History: every change made through the list, newest first,
 * filterable by time, item, source, action, field and batch, with
 * "Revert batch" (update rows only: trash/delete/duplicate are reported
 * as skipped by the server).
 */
import { Button, Spinner } from '@wordpress/components';
import { dateI18n } from '@wordpress/date';
import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { getQueryArg } from '@wordpress/url';
import { getLogUsers, getRevertPlan } from '../api/client';
import type { RevertPlan } from '../api/client';
import { notify } from '../actions/notices';
import { DataViews } from '../dataviews';
import type { Action, Filter, RenderModalProps, View } from '../dataviews';
import { SaveProgress } from '../edit/progress';
import { getSettings } from '../settings';
import type { Settings } from '../types';
import { invalidateProducts } from '../store/products';
import { Notices } from '../ui';
import { createLogFields, logQueryFromView } from './log-fields';
import { describeBatchScope, scopeFromPlan } from './batch-scope';
import { runRevert } from './revert';
import type { RevertOutcome } from './revert';
import { invalidateLog, useLog } from './use-log';
import type { LogRow } from './use-log';
import '../edit/style.scss';

const TABLE_FIELDS = [ 'user', 'object', 'source', 'action', 'field', 'change', 'status', 'batch_id' ];

/** A log row's time in the site's date/time format and timezone (the same the table shows), from the GMT stamp when the row carries one. */
export function formatLogTime( row: Pick< LogRow, 'created_at' | 'created_at_gmt' >, settings: Pick< Settings, 'dateFormat' | 'timeFormat' > ): string {
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
	const href = typeof window !== 'undefined' ? window.location.href : '';
	const objectId = Number( getQueryArg( href, 'object_id' ) );
	const batch = getQueryArg( href, 'batch' );
	const filters: Filter[] = [];

	if ( Number.isInteger( objectId ) && objectId > 0 ) {
		filters.push( { field: 'object_id', operator: 'is', value: objectId } );
	}

	if ( typeof batch === 'string' && batch ) {
		filters.push( { field: 'batch_id', operator: 'is', value: batch } );
	}

	return filters;
}

function revertLabel( done: number, total: number ): string {
	return sprintf(
		/* translators: 1: items put back so far, 2: items in total */
		__( 'Reverting %1$d of %2$d…', 'wp-woocommerce-products-list' ),
		done,
		total
	);
}

/** The names of the fields the conflicting objects changed again, for the summary line. */
function conflictFields( outcome: RevertOutcome ): string[] {
	return Array.from( new Set( outcome.conflicts.flatMap( ( result ) => result.fields ?? [] ) ) );
}

function RevertModal( { items, closeModal, onActionPerformed }: RenderModalProps< LogRow > ) {
	const settings = getSettings();
	const row = items[ 0 ];
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );
	const [ plan, setPlan ] = useState< RevertPlan | null | 'loading' >( 'loading' );
	const [ progress, setProgress ] = useState( { done: 0, total: 0 } );
	// Set when a pass left conflicts behind: the summary and "Revert anyway".
	const [ outcome, setOutcome ] = useState< RevertOutcome | null >( null );
	const batchId = row?.batch_id;

	useEffect( () => {
		if ( ! batchId ) {
			setPlan( null );

			return;
		}

		let cancelled = false;

		setPlan( 'loading' );

		// What the revert writes, from the log itself: exact for any batch size, and the chunks to post.
		getRevertPlan( batchId )
			.then( ( loaded ) => {
				if ( ! cancelled ) {
					setPlan( loaded );
				}
			} )
			.catch( () => {
				if ( ! cancelled ) {
					setPlan( null );
				}
			} );

		return () => {
			cancelled = true;
		};
	}, [ batchId ] );

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

	const confirm = async ( force = false ) => {
		if ( ! row || ! plan || plan === 'loading' ) {
			return;
		}

		setBusy( true );
		setError( null );

		try {
			const result = force && outcome
				? await runRevert( row.batch_id, plan, { ids: outcome.conflicts.map( ( conflict ) => conflict.id ), force: true, revertBatchId: outcome.revertBatchId, onProgress: ( done, total ) => setProgress( { done, total } ) } )
				: await runRevert( row.batch_id, plan, { onProgress: ( done, total ) => setProgress( { done, total } ) } );

			if ( force && outcome ) {
				// The forced pass completes the first one.
				finish( { ...result, ok: result.ok + outcome.ok, failed: [ ...outcome.failed, ...result.failed ], skipped: outcome.skipped } );

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

	return (
		<div className="wc-pl-confirm">
			<p>
				{ __( 'Put back the previous values of every field this batch changed? Trash, delete and duplicate entries are not reverted. The revert is logged as a new batch.', 'wp-woocommerce-products-list' ) }
			</p>
			{ row ? (
				<p>
					<code>{ row.batch_id }</code> · { row.user?.name } · { formatLogTime( row, settings ) }
				</p>
			) : null }
			<p className="wc-pl-confirm__scope" aria-live="polite">
				{ plan === 'loading' ? (
					<>
						<Spinner /> { __( 'Checking what the batch changed…', 'wp-woocommerce-products-list' ) }
					</>
				) : plan ? (
					<strong>{ describeBatchScope( scopeFromPlan( plan ) ) }</strong>
				) : (
					__( 'The scope of this batch could not be loaded.', 'wp-woocommerce-products-list' )
				) }
			</p>
			<SaveProgress done={ progress.done } total={ progress.total } saving={ busy } label={ revertLabel } />
			{ outcome ? (
				<p className="wc-pl-confirm__conflicts" role="status">
					{ sprintf(
						/* translators: 1: items put back, 2: items left alone, 3: the field names */
						_n(
							'%1$d put back. %2$d item was changed again after this batch (%3$s) and was left as it is.',
							'%1$d put back. %2$d items were changed again after this batch (%3$s) and were left as they are.',
							outcome.conflicts.length,
							'wp-woocommerce-products-list'
						),
						outcome.ok,
						outcome.conflicts.length,
						conflictFields( outcome ).join( ', ' )
					) }
				</p>
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
				{ outcome ? (
					<Button variant="primary" isDestructive isBusy={ busy } disabled={ busy } onClick={ () => void confirm( true ) } __next40pxDefaultSize>
						{ sprintf(
							/* translators: %d: number of items */
							_n( 'Revert %d anyway', 'Revert %d anyway', outcome.conflicts.length, 'wp-woocommerce-products-list' ),
							outcome.conflicts.length
						) }
					</Button>
				) : (
					<Button variant="primary" isBusy={ busy } disabled={ busy || ! row || plan === 'loading' || ! plan || ! plan.revertable } onClick={ () => void confirm() } __next40pxDefaultSize>
						{ __( 'Revert batch', 'wp-woocommerce-products-list' ) }
					</Button>
				) }
			</div>
		</div>
	);
}

export function HistoryScreen() {
	const settings = getSettings();
	const [ view, setView ] = useState< View >( () => ( {
		type: 'table',
		page: 1,
		perPage: 50,
		titleField: 'created_at',
		fields: TABLE_FIELDS,
		filters: initialFilters(),
		layout: { density: 'compact' },
	} ) );
	const [ users, setUsers ] = useState< Array< { id: number; name: string } > >( [] );
	const fields = useMemo( () => createLogFields( settings, { users } ), [ settings, users ] );

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
	const query = useMemo( () => logQueryFromView( view ), [ view ] );
	const log = useLog( query );

	const showBatch = useCallback(
		( batchId: string ) => {
			setView( ( current ) => ( { ...current, page: 1, filters: [ ...( current.filters ?? [] ).filter( ( filter ) => filter.field !== 'batch_id' ), { field: 'batch_id', operator: 'is', value: batchId } ] } ) );
		},
		[ setView ]
	);

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
				isEligible: ( item ) => item.action === 'update' && item.status === 'ok' && settings.caps.edit,
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
				{ __( '← Catalog', 'wp-woocommerce-products-list' ) }
			</Button>
		</div>
	);

	return (
		<div className="wc-products-list wc-pl-history">
			<h1 className="wc-pl-history__title">{ __( 'History', 'wp-woocommerce-products-list' ) }</h1>
			<DataViews< LogRow >
				data={ log.items }
				fields={ fields }
				view={ view }
				onChangeView={ setView }
				getItemId={ ( row ) => String( row.id ) }
				paginationInfo={ { totalItems: log.total, totalPages: log.totalPages } }
				defaultLayouts={ { table: { titleField: 'created_at' } } }
				actions={ actions }
				isLoading={ log.isLoading }
				search={ false }
				header={ header }
				config={ { perPageSizes: [ 25, 50, 100 ] } }
				empty={ <p className="wc-products-list__empty">{ log.error ? log.error.message : __( 'No changes logged yet. Every edit made through the catalog shows up here.', 'wp-woocommerce-products-list' ) }</p> }
			/>
			<Notices />
		</div>
	);
}

export default HistoryScreen;
