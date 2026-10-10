/**
 * Save progress and the per-item error list the modal shows while and after
 * a bulk save. Stays mounted on partial failure so the user can fix and retry.
 */
import { ProgressBar, Notice } from '@wordpress/components';
import { useEffect, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import { getCurrentRows } from '../store/rows';
import type { ProductListItem } from '../types';
import { itemLabel } from './item-label';

export interface SaveProgressProps {
	done: number;
	total: number;
	saving: boolean;
	/** The text next to the bar; "Saving N of M…" by default. */
	label?: ( done: number, total: number ) => string;
}

/** "about 2 min left" from the rate so far; nothing until there is a rate worth trusting. */
export function timeLeft( done: number, total: number, elapsedMs: number ): string | null {
	if ( done < 1 || total <= done || elapsedMs < 1500 ) {
		return null;
	}

	const seconds = Math.ceil( ( ( total - done ) * elapsedMs ) / done / 1000 );

	if ( seconds < 60 ) {
		/* translators: %d: seconds */
		return sprintf( _n( 'about %d second left', 'about %d seconds left', seconds, 'wp-woocommerce-products-list' ), seconds );
	}

	const minutes = Math.ceil( seconds / 60 );

	/* translators: %d: minutes */
	return sprintf( _n( 'about %d minute left', 'about %d minutes left', minutes, 'wp-woocommerce-products-list' ), minutes );
}

export function SaveProgress( { done, total, saving, label }: SaveProgressProps ) {
	const [ startedAt, setStartedAt ] = useState< number | null >( null );
	const [ now, setNow ] = useState( () => Date.now() );

	// Note when saving starts, then tick once a second so the time left keeps moving between progress updates.
	useEffect( () => {
		if ( ! saving ) {
			setStartedAt( null );

			return undefined;
		}

		setStartedAt( Date.now() );
		const timer = window.setInterval( () => setNow( Date.now() ), 1000 );

		return () => window.clearInterval( timer );
	}, [ saving ] );

	if ( ! saving ) {
		return null;
	}

	// Before the plan knows how many rows: an indeterminate bar, so Save is seen to have taken.
	if ( total === 0 ) {
		return (
			<div className="wc-pl-edit__progress is-prominent" role="status" aria-live="polite">
				<span className="wc-pl-edit__progress-label">{ label ? label( 0, 0 ) : __( 'Preparing the update…', 'wp-woocommerce-products-list' ) }</span>
				<ProgressBar />
			</div>
		);
	}

	const value = Math.round( ( done / total ) * 100 );
	const left = startedAt === null ? null : timeLeft( done, total, now - startedAt );
	const large = total >= 200;

	return (
		<div className="wc-pl-edit__progress is-prominent" role="status" aria-live="polite">
			<span className="wc-pl-edit__progress-label">
				<strong>
					{ label
						? label( done, total )
						: sprintf(
								/* translators: 1: rows saved, 2: rows in total */
								__( 'Updating %1$s of %2$s…', 'wp-woocommerce-products-list' ),
								done.toLocaleString(),
								total.toLocaleString()
						  ) }
				</strong>
				{ ` ${ value } %` }
				{ left ? ` · ${ left }` : '' }
			</span>
			<ProgressBar value={ value } />
			{ large ? <span className="wc-pl-edit__progress-hint">{ __( 'You can close this panel and keep working in the list; the update continues. Leaving the page stops it.', 'wp-woocommerce-products-list' ) }</span> : null }
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

	// A variation whose parent is off this page is named by that parent when the editor holds it.
	const rows = [ ...items, ...getCurrentRows() ];

	items.forEach( ( item ) => names.set( item.id, itemLabel( item, rows ) ) );
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
						{ error.field && fieldLabels[ error.field ] && onFocusField && ( ! error.id || items.length <= 1 ) ? (
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
