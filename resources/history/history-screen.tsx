/**
 * Catalog → History: every change made through the list, newest first,
 * filterable by time, item, source, action, field and batch, with
 * "Revert batch" (update rows only: trash/delete/duplicate are reported
 * as skipped by the server).
 */
import { Button } from '@wordpress/components';
import { useCallback, useMemo, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { getQueryArg } from '@wordpress/url';
import { revertBatch } from '../api/client';
import { notify } from '../actions/notices';
import { DataViews } from '../dataviews';
import type { Action, Filter, RenderModalProps, View } from '../dataviews';
import { getSettings } from '../settings';
import { invalidateProducts } from '../store/products';
import { Notices } from '../ui';
import { createLogFields, logQueryFromView } from './log-fields';
import { invalidateLog, useLog } from './use-log';
import type { LogRow } from './use-log';
import '../edit/style.scss';

const TABLE_FIELDS = [ 'user', 'object', 'source', 'action', 'field', 'change', 'status', 'batch_id' ];

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

function RevertModal( { items, closeModal, onActionPerformed }: RenderModalProps< LogRow > ) {
	const row = items[ 0 ];
	const [ busy, setBusy ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );

	const confirm = async () => {
		if ( ! row ) {
			return;
		}

		setBusy( true );
		setError( null );

		try {
			// Only the per-object results are used; the rows are refetched by the list.
			const response = await revertBatch( row.batch_id, { fields: [ 'id' ] } );
			const ok = response.results.filter( ( result ) => result.ok ).length;
			const failed = response.results.filter( ( result ) => ! result.ok );

			invalidateProducts( { counts: true } );
			invalidateLog();

			if ( ok ) {
				notify.success(
					sprintf(
						/* translators: %d: number of items reverted */
						_n( '%d item reverted.', '%d items reverted.', ok, 'wp-woocommerce-products-list' ),
						ok
					)
				);
			}

			if ( failed.length ) {
				notify.error( failed[ 0 ]?.message ?? __( 'Some items could not be reverted.', 'wp-woocommerce-products-list' ) );
			}

			onActionPerformed?.( items );
			closeModal?.();
		} catch ( caught ) {
			setBusy( false );
			setError( caught instanceof Error ? caught.message : __( 'The revert failed.', 'wp-woocommerce-products-list' ) );
		}
	};

	return (
		<div className="wc-pl-confirm">
			<p>
				{ __( 'Put back the previous values of every field this batch changed? Trash, delete and duplicate entries are not reverted. The revert is logged as a new batch.', 'wp-woocommerce-products-list' ) }
			</p>
			{ row ? (
				<p>
					<code>{ row.batch_id }</code> · { row.user?.name } · { row.created_at }
				</p>
			) : null }
			{ error ? (
				<p className="wc-pl-confirm__error" role="alert">
					{ error }
				</p>
			) : null }
			<div className="wc-pl-edit__footer">
				<Button variant="tertiary" onClick={ () => closeModal?.() } disabled={ busy } __next40pxDefaultSize>
					{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
				</Button>
				<Button variant="primary" isBusy={ busy } disabled={ busy || ! row } onClick={ () => void confirm() } __next40pxDefaultSize>
					{ __( 'Revert batch', 'wp-woocommerce-products-list' ) }
				</Button>
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
	const fields = useMemo( () => createLogFields( settings ), [ settings ] );
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
