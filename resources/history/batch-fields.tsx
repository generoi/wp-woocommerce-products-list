/**
 * The History landing view: one row per batch (one user gesture: a bulk
 * edit, a quick edit, an action, a revert) instead of one row per field.
 * "-20 % sale: Regular price, Sale price… on 348 variations of 5 products",
 * who and when, how many failed, and whether it was reverted since.
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import type { Field } from '../dataviews';
import { logFieldLabel } from '../fields/log-labels';
import type { LogFieldOption } from '../fields/log-labels';
import type { Settings } from '../types';
import { actionLabel, SOURCE_OPTIONS } from './log-fields';
import { skipReasonLabel } from './batch-scope';
import type { BatchQuery, LogBatch } from './use-log';

/** How many field names a batch row lists before "+N more". */
const FIELDS_SHOWN = 4;

/** "348 variations of 5 products, 2 products" from the batch counts. */
export function describeBatchObjects( batch: Pick< LogBatch, 'objects' | 'products' | 'variations' | 'parents' > ): string {
	const parts: string[] = [];
	const products = batch.products ?? 0;
	const variations = batch.variations ?? 0;

	if ( variations > 0 ) {
		parts.push(
			( batch.parents ?? 0 ) > 0
				? sprintf(
						/* translators: 1: "N variations", 2: "N products" */
						__( '%1$s of %2$s', 'wp-woocommerce-products-list' ),
						/* translators: %d: number of variations */
						sprintf( _n( '%d variation', '%d variations', variations, 'wp-woocommerce-products-list' ), variations ),
						/* translators: %d: number of products */
						sprintf( _n( '%d product', '%d products', batch.parents ?? 0, 'wp-woocommerce-products-list' ), batch.parents ?? 0 )
				  )
				: /* translators: %d: number of variations */
				  sprintf( _n( '%d variation', '%d variations', variations, 'wp-woocommerce-products-list' ), variations )
		);
	}

	if ( products > 0 ) {
		/* translators: %d: number of products */
		parts.push( sprintf( _n( '%d product', '%d products', products, 'wp-woocommerce-products-list' ), products ) );
	}

	if ( ! parts.length ) {
		/* translators: %d: number of items */
		return sprintf( _n( '%d item', '%d items', batch.objects, 'wp-woocommerce-products-list' ), batch.objects );
	}

	return parts.join( ', ' );
}

/** The batch's field labels ("Regular price, Svenska: Name +3 more"), or its actions when it changed no field. */
export function describeBatchChanges( batch: Pick< LogBatch, 'fields' | 'actions' > & Partial< Pick< LogBatch, 'summary' > >, fieldOptions: LogFieldOption[], settings?: Pick< Settings, 'actions' > | null ): string {
	// The server's (or an integration's) name for an action batch: "Moved to trash", "Copy translations (Suomi → Svenska): Name".
	if ( typeof batch.summary === 'string' && batch.summary.trim() !== '' ) {
		return batch.summary;
	}

	const labels = Array.from( new Set( batch.fields.map( ( key ) => logFieldLabel( key, fieldOptions ) ) ) );
	const actions = ( batch.actions ?? [] ).filter( ( action ) => action !== 'update' ).map( ( action ) => actionLabel( action, settings ) );
	const named = [ ...actions, ...labels ];

	if ( ! named.length ) {
		return '—';
	}

	const shown = named.slice( 0, FIELDS_SHOWN ).join( ', ' );
	const rest = named.length - FIELDS_SHOWN;

	/* translators: 1: the first names, 2: how many more */
	return rest > 0 ? sprintf( __( '%1$s +%2$d more', 'wp-woocommerce-products-list' ), shown, rest ) : shown;
}

/** "Still running…" / "Interrupted: 312 of 900 written": a batch a save is still writing, or stopped writing before it was done. */
export function describeBatchState( batch: Pick< LogBatch, 'state' | 'planned' | 'objects' > ): string {
	if ( batch.state === 'running' ) {
		return __( 'Still running…', 'wp-woocommerce-products-list' );
	}

	if ( batch.state === 'interrupted' ) {
		return batch.planned
			? sprintf(
					/* translators: 1: items written, 2: items the save planned to write */
					__( 'Interrupted: %1$d of %2$d written', 'wp-woocommerce-products-list' ),
					Math.min( batch.objects, batch.planned ),
					batch.planned
			  )
			: __( 'Interrupted', 'wp-woocommerce-products-list' );
	}

	return '';
}

/** "5 skipped (already had the value)": the batch's left-out items with why. */
export function describeSkipped( batch: Pick< LogBatch, 'skipped' | 'skipped_reasons' > ): string {
	const count = batch.skipped ?? 0;
	const reasons = Array.from( new Set( ( batch.skipped_reasons ?? [] ).map( skipReasonLabel ) ) );

	return reasons.length
		? sprintf(
				/* translators: 1: number of items the batch left out, 2: why ("already had the value") */
				_n( '%1$d skipped (%2$s)', '%1$d skipped (%2$s)', count, 'wp-woocommerce-products-list' ),
				count,
				reasons.join( ', ' )
		  )
		: sprintf(
				/* translators: %d: number of items the batch left out */
				_n( '%d skipped', '%d skipped', count, 'wp-woocommerce-products-list' ),
				count
		  );
}

export interface BatchFieldOptions {
	users?: Array< { id: number; name: string } >;
	fieldOptions?: LogFieldOption[];
	formatTime( stamp: { created_at: string; created_at_gmt?: string } ): string;
}

export function createBatchFields( settings: Settings, options: BatchFieldOptions ): Field< LogBatch >[] {
	const users = options.users ?? [];
	const fieldOptions = options.fieldOptions ?? [];

	return [
		{
			id: 'created_at',
			type: 'datetime',
			label: __( 'Time', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			enableHiding: false,
			filterBy: { operators: [ 'after', 'before' ] },
			format: { datetime: `${ settings.dateFormat } ${ settings.timeFormat }` },
		},
		{
			id: 'user',
			type: 'text',
			label: __( 'User', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			getValue: ( { item } ) => ( users.length ? String( item.user?.id ?? '' ) : item.user?.name ?? '' ),
			render: ( { item } ) => <span>{ item.user?.name || ( item.user?.id ? `#${ item.user.id }` : '—' ) }</span>,
			...( users.length
				? {
						elements: users.map( ( user ) => ( { value: String( user.id ), label: user.name || `#${ user.id }` } ) ),
						filterBy: { operators: [ 'is' ] },
				  }
				: { filterBy: false } ),
		},
		{
			id: 'source',
			type: 'text',
			label: __( 'Source', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			elements: SOURCE_OPTIONS,
			filterBy: { operators: [ 'is' ] },
		},
		{
			id: 'changes',
			type: 'text',
			label: __( 'Changed', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			enableHiding: false,
			filterBy: false,
			getValue: ( { item } ) => describeBatchChanges( item, fieldOptions, settings ),
			render: ( { item } ) => {
				const changes = describeBatchChanges( item, fieldOptions, settings );
				const all = item.fields.map( ( key ) => logFieldLabel( key, fieldOptions ) ).join( ', ' );

				return (
					<span className="wc-pl-history__batch" title={ all }>
						<strong>{ changes }</strong>
						<span className="wc-pl-history__batch-scope">
							{ ' ' }
							{ /* translators: %s: "348 variations of 5 products" */ sprintf( __( 'on %s', 'wp-woocommerce-products-list' ), describeBatchObjects( item ) ) }
						</span>
					</span>
				);
			},
		},
		{
			id: 'result',
			type: 'text',
			label: __( 'Result', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			getValue: ( { item } ) => String( item.errors ?? 0 ),
			render: ( { item } ) => (
				<>
					{ item.state ? (
						<span className={ item.state === 'running' ? 'wc-pl-history__running' : 'wc-pl-history__error' }>
							{ describeBatchState( item ) }
							{ ' · ' }
						</span>
					) : null }
					{ item.errors ? (
						<span className="wc-pl-history__error">
							{ sprintf(
								/* translators: 1: changes that failed, 2: changes in the batch */
								__( '%1$d of %2$d failed', 'wp-woocommerce-products-list' ),
								item.errors,
								item.rows
							) }
						</span>
					) : (
						<span>
							{ sprintf(
								/* translators: %d: number of logged changes */
								_n( '%d change', '%d changes', item.rows, 'wp-woocommerce-products-list' ),
								item.rows
							) }
						</span>
					) }
					{ item.skipped ? (
						<span className="wc-pl-history__skipped">
							{ ', ' }
							{ describeSkipped( item ) }
						</span>
					) : null }
				</>
			),
		},
		{
			id: 'reverted',
			type: 'text',
			label: __( 'Reverted', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			getValue: ( { item } ) => item.reverted_by?.batch_id ?? '',
			render: ( { item } ) => {
				if ( item.reverted_by ) {
					return (
						<span className="wc-pl-history__reverted">
							{ sprintf(
								/* translators: 1: user name, 2: date and time */
								__( 'Reverted by %1$s at %2$s', 'wp-woocommerce-products-list' ),
								item.reverted_by.user?.name || `#${ item.reverted_by.user?.id ?? 0 }`,
								options.formatTime( item.reverted_by )
							) }
						</span>
					);
				}

				if ( item.reverts ) {
					return (
						<span title={ item.reverts }>
							{ sprintf(
								/* translators: %s: the short id of the batch this revert put back */
								__( 'Revert of %s', 'wp-woocommerce-products-list' ),
								item.reverts.slice( 0, 8 )
							) }
						</span>
					);
				}

				return <span>—</span>;
			},
		},
		{
			id: 'batch_id',
			type: 'text',
			label: __( 'Batch', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			// The server takes the full id or its first characters (4 or more).
			filterBy: { operators: [ 'is' ] },
			getValue: ( { item } ) => item.batch_id,
			render: ( { item } ) => <code title={ item.batch_id }>{ item.batch_id.slice( 0, 8 ) }</code>,
		},
	];
}

/** The batches view's filters as `GET /log/batches` params. */
export function batchQueryFromView(
	view: { page?: number; perPage?: number; search?: string; filters?: Array< { field: string; operator: string; value: unknown } > }
): NonNullable< BatchQuery > & { search?: string } {
	const query: NonNullable< BatchQuery > & { search?: string } = { page: view.page ?? 1, perPage: view.perPage ?? 25 };

	// The batches that touched a product of that name (the server's `search`).
	if ( view.search && view.search.trim() !== '' ) {
		query.search = view.search.trim();
	}

	for ( const filter of view.filters ?? [] ) {
		const value = Array.isArray( filter.value ) ? filter.value[ 0 ] : filter.value;

		if ( value === undefined || value === null || value === '' ) {
			continue;
		}

		switch ( filter.field ) {
			case 'created_at':
				if ( filter.operator === 'after' ) {
					query.since = String( value );
				} else if ( filter.operator === 'before' ) {
					query.until = String( value );
				}
				break;
			case 'user':
				query.user = Number( value );
				break;
			case 'source':
				query.source = String( value );
				break;
			case 'batch_id':
				query.batch = String( value );
				break;
			default:
				break;
		}
	}

	return query;
}
