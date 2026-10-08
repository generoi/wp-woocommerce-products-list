/** The change history of one product or variation, in the row's History modal. */
import { Button } from '@wordpress/components';
import { useMemo, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { DataViews } from '../dataviews';
import type { RenderModalProps, View } from '../dataviews';
import { getSettings } from '../settings';
import type { ProductListItem } from '../types';
import { createLogFields, logQueryFromView } from './log-fields';
import { useLog } from './use-log';
import type { LogRow } from './use-log';

const ROW_FIELDS = [ 'user', 'source', 'field', 'change', 'status' ];

export function RowHistoryModal( { items, closeModal }: RenderModalProps< ProductListItem > ) {
	const settings = getSettings();
	const item = items.find( ( entry ) => ! entry._placeholder );
	const [ view, setView ] = useState< View >( { type: 'table', page: 1, perPage: 25, titleField: 'created_at', fields: ROW_FIELDS, filters: [], layout: { density: 'compact' } } );
	const fields = useMemo( () => createLogFields( settings, { withObject: false } ), [ settings ] );
	const query = useMemo( () => logQueryFromView( view, { object_id: item?.id } ), [ view, item?.id ] );
	const log = useLog( query, { enabled: Boolean( item ) } );

	return (
		<div className="wc-pl-history__modal">
			<div className="wc-pl-history__header">
				<span>
					{ log.total
						? sprintf(
								/* translators: %d: number of logged changes */
								__( '%d logged changes. Newest first.', 'wp-woocommerce-products-list' ),
								log.total
						  )
						: log.isLoading
						? __( 'Loading…', 'wp-woocommerce-products-list' )
						: __( 'No changes have been logged for this item.', 'wp-woocommerce-products-list' ) }
				</span>
				<Button variant="link" href={ `${ settings.links.history }${ settings.links.history.includes( '?' ) ? '&' : '?' }object_id=${ item?.id ?? '' }` }>
					{ __( 'Open in History', 'wp-woocommerce-products-list' ) }
				</Button>
			</div>
			<DataViews< LogRow >
				data={ log.items }
				fields={ fields }
				view={ view }
				onChangeView={ setView }
				getItemId={ ( row ) => String( row.id ) }
				paginationInfo={ { totalItems: log.total, totalPages: log.totalPages } }
				defaultLayouts={ { table: { titleField: 'created_at' } } }
				actions={ [] }
				isLoading={ log.isLoading }
				search={ false }
				empty={ <p>{ __( 'Nothing logged yet.', 'wp-woocommerce-products-list' ) }</p> }
			/>
			<div className="wc-pl-edit__footer">
				<Button variant="tertiary" onClick={ () => closeModal?.() } __next40pxDefaultSize>
					{ __( 'Close', 'wp-woocommerce-products-list' ) }
				</Button>
			</div>
		</div>
	);
}

export default RowHistoryModal;
