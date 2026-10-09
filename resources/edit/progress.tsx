/**
 * Save progress and the per-item error list the modal shows while and after
 * a bulk save. Stays mounted on partial failure so the user can fix and retry.
 */
import { ProgressBar, Notice } from '@wordpress/components';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { ProductListItem } from '../types';
import { itemLabel } from './item-label';

export interface SaveProgressProps {
	done: number;
	total: number;
	saving: boolean;
	/** The text next to the bar; "Saving N of M…" by default. */
	label?: ( done: number, total: number ) => string;
}

export function SaveProgress( { done, total, saving, label }: SaveProgressProps ) {
	if ( ! saving ) {
		return null;
	}

	// Before the plan knows how many rows: an indeterminate bar, so Save is seen to have taken.
	if ( total === 0 ) {
		return (
			<div className="wc-pl-edit__progress" role="status" aria-live="polite">
				<ProgressBar />
				<span className="wc-pl-edit__progress-label">{ label ? label( 0, 0 ) : __( 'Saving…', 'wp-woocommerce-products-list' ) }</span>
			</div>
		);
	}

	const value = Math.round( ( done / total ) * 100 );

	return (
		<div className="wc-pl-edit__progress" role="status" aria-live="polite">
			<ProgressBar value={ value } />
			<span className="wc-pl-edit__progress-label">
				{ label
					? label( done, total )
					: sprintf(
							/* translators: 1: rows saved, 2: rows in total */
							__( 'Saving %1$d of %2$d…', 'wp-woocommerce-products-list' ),
							done,
							total
					  ) }
			</span>
		</div>
	);
}

export interface EditError {
	/** 0 when the error is about the form, not a row. */
	id: number;
	field?: string;
	message: string;
}

export interface EditErrorsProps {
	errors: EditError[];
	items: ProductListItem[];
	/** Names known beyond `items` (a row a save failed on that is in no list any more); `items` win. */
	names?: ReadonlyMap< number, string >;
	fieldLabels: Record< string, string >;
	title?: string;
	/** `error` (default) or `warning` for a list the user may accept. */
	status?: 'error' | 'warning';
	className?: string;
	/** Move to a field named in the list (its tab, then its control); the field names become buttons. */
	onFocusField?: ( fieldId: string ) => void;
}

export function EditErrors( { errors, items, names: knownNames, fieldLabels, title, status = 'error', className = 'wc-pl-edit__errors', onFocusField }: EditErrorsProps ) {
	if ( errors.length === 0 ) {
		return null;
	}

	const names = new Map< number, string >( knownNames ?? [] );

	items.forEach( ( item ) => names.set( item.id, itemLabel( item ) ) );
	const shown = errors.slice( 0, 50 );

	return (
		<Notice status={ status } isDismissible={ false } className={ className }>
			<strong>
				{ title ??
					sprintf(
						/* translators: %d: number of problems */
						_n( '%d problem', '%d problems', errors.length, 'wp-woocommerce-products-list' ),
						errors.length
					) }
			</strong>
			<ul>
				{ shown.map( ( error, index ) => (
					<li key={ `${ error.id }-${ error.field ?? '' }-${ index }` }>
						{ error.id ? <strong>{ names.get( error.id ) ?? `#${ error.id }` }: </strong> : null }
						{ error.field && fieldLabels[ error.field ] && onFocusField && ! error.id ? (
							<>
								<button type="button" className="button-link wc-pl-edit__error-field" onClick={ () => onFocusField( error.field! ) }>
									{ fieldLabels[ error.field ] }
								</button>
								{ ' — ' }
							</>
						) : error.field && fieldLabels[ error.field ] ? (
							`${ fieldLabels[ error.field ] } — `
						) : (
							''
						) }
						{ error.message }
					</li>
				) ) }
				{ errors.length > shown.length ? (
					<li>
						{ sprintf(
							/* translators: %d: number of further problems */
							__( '…and %d more', 'wp-woocommerce-products-list' ),
							errors.length - shown.length
						) }
					</li>
				) : null }
			</ul>
		</Notice>
	);
}
