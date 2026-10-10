/**
 * The DataForm control for the sale dates: a labelled date input and an
 * optional time input, in the site's wall-clock time. A date without a time
 * is a whole day: "from" starts at 00:00, "to" ends at 23:59. DataViews' own datetime control
 * names its input "Date time" for assistive technology and converts to a
 * UTC instant; this one carries the field's label ("Sale from") and emits
 * `Y-m-d\TH:i:s` the way wc/v3 stores it, so what is typed is what the
 * shop runs.
 */
import { dateI18n } from '@wordpress/date';
import { useId, useRef } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType, FocusEvent } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { Settings } from '../types';
import type { FormData } from './bulk-numeric-control';
import { DATE_INPUT_MAX, DATE_INPUT_MIN, invalidDate, invalidDateText, isInvalidDate } from './sale-schedule';

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;

/** A stored value → what a `datetime-local` input shows (`YYYY-MM-DDTHH:mm`); zoned instants are shown in site time. */
export function toInputDateTime( value: unknown ): string {
	if ( typeof value !== 'string' || value === '' ) {
		return '';
	}

	if ( isInvalidDate( value ) ) {
		return invalidDateText( value );
	}

	if ( ZONED.test( value ) ) {
		try {
			return dateI18n( 'Y-m-d\\TH:i', value );
		} catch {
			return '';
		}
	}

	const match = LOCAL.exec( value );

	return match ? `${ match[ 1 ] }T${ match[ 2 ] }` : '';
}

/** A stored site-time value's time: `HH:mm` and its seconds. */
const STORED_LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}):(\d{2})$/;

const INPUT_DATE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/** Whether a date field is the end of a range (`…date_on_sale_to`): a date without a time then means the end of that day. */
export function isEndDateField( fieldId: string ): boolean {
	return /date_on_sale_to$/.test( fieldId );
}

/**
 * What the input emits → the wc/v3 site-time form. Empty stays empty (clear
 * the date); a date without a time is the start of that day, or its last
 * minute (23:59:59) for an end date; anything else that is not a
 * four-digit-year date ("202623-10-18T05:09") becomes the invalid marker,
 * never a silent "no date".
 */
export function fromInputDateTime( text: string, end = false ): string {
	if ( text === '' ) {
		return '';
	}

	const match = INPUT_DATE.exec( text );

	if ( ! match ) {
		return invalidDate( text );
	}

	if ( match[ 2 ] === undefined ) {
		return `${ match[ 1 ] }T${ end ? '23:59:59' : '00:00:00' }`;
	}

	return `${ match[ 1 ] }T${ match[ 2 ] }:00`;
}

type DateInputLike = Pick< HTMLInputElement, 'value' > & { validity?: Pick< ValidityState, 'badInput' > };

/** The date and time inputs → the stored value. The time is optional; a time without a date is not a date. */
export function readDateTimeInputs( date: DateInputLike, time: DateInputLike, end = false ): string {
	if ( date.validity?.badInput || time.validity?.badInput ) {
		return invalidDate( [ date.value, time.value ].filter( Boolean ).join( 'T' ) );
	}

	if ( date.value === '' ) {
		return time.value === '' ? '' : invalidDate( `T${ time.value }` );
	}

	return fromInputDateTime( time.value === '' ? date.value : `${ date.value }T${ time.value }`, end );
}

/** The input's value as the form stores it, reading the browser's own verdict: a half-typed date reports "" with `badInput`. */
export function readDateInput( input: Pick< HTMLInputElement, 'value' > & { validity?: Pick< ValidityState, 'badInput' > } ): string {
	if ( input.value === '' && input.validity?.badInput ) {
		return invalidDate( '' );
	}

	return fromInputDateTime( input.value );
}

export interface DateTimeControlOptions {
	/** The problem with the field's value in this record (an incomplete date, an end before the start), or null. */
	problem?: ( data: FormData, fieldId: string ) => string | null;
}

export function createDateTimeControl( settings: Pick< Settings, 'timezone' >, options: DateTimeControlOptions = {} ): ComponentType< DataFormControlProps< FormData > > {
	function DateTimeControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const id = `wc-pl-date-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;
		const timeId = `${ id }-time`;
		const helpId = `${ id }-help`;
		const dateRef = useRef< HTMLInputElement >( null );
		const timeRef = useRef< HTMLInputElement >( null );
		const stored = data[ field.id ];
		const end = isEndDateField( field.id );
		const value = toInputDateTime( stored );
		const [ dateValue = '', timeValue = '' ] = value.split( 'T' );
		const problem = options.problem ? options.problem( data, field.id ) : null;
		/* translators: %s: the site's timezone, e.g. Europe/Helsinki */
		const zone = settings.timezone ? sprintf( __( 'Site time (%s).', 'wp-woocommerce-products-list' ), settings.timezone ) : '';
		const wholeDay = end ? __( 'Without a time the sale ends at 23:59 that day.', 'wp-woocommerce-products-list' ) : __( 'Without a time the sale starts at 00:00 that day.', 'wp-woocommerce-products-list' );
		const help = problem ?? [ field.description, wholeDay, zone ].filter( Boolean ).join( ' ' );
		const store = ( source: 'date' | 'time' ) => {
			const date = dateRef.current;
			const time = timeRef.current;

			if ( ! date || ! time ) {
				return;
			}

			// Emptying the date clears the field (the time shown is only the day's default).
			let next = source === 'date' && date.value === '' && ! date.validity?.badInput ? '' : readDateTimeInputs( date, time, end );
			// A date changed under a time the user left alone keeps the stored time to the second: the time input shows
			// only minutes, so a whole-day end (23:59:59) read back from it would otherwise end the sale at 23:59:00.
			const kept = typeof stored === 'string' ? STORED_LOCAL_TIME.exec( stored ) : null;

			if ( source === 'date' && kept && time.value === timeValue && time.value === kept[ 1 ] && next.endsWith( `T${ kept[ 1 ] }:00` ) ) {
				next = `${ next.slice( 0, -2 ) }${ kept[ 2 ] }`;
			}

			if ( next !== ( typeof stored === 'string' ? stored : '' ) ) {
				onChange( { [ field.id ]: next } );
			}
		};
		/* translators: %s: the date field's label, e.g. "Sale from" */
		const timeLabel = sprintf( __( '%s, time (optional)', 'wp-woocommerce-products-list' ), field.label );

		return (
			<div className={ `wc-pl-date-control${ problem ? ' is-invalid' : '' }` }>
				<label htmlFor={ id } className={ `components-base-control__label wc-pl-date-control__label${ hideLabelFromVision ? ' screen-reader-text' : '' }` }>
					{ field.label }
				</label>
				<div className="wc-pl-date-control__inputs" style={ { display: 'flex', gap: '8px' } }>
					<input
						ref={ dateRef }
						id={ id }
						className="components-text-control__input"
						type="date"
						min={ DATE_INPUT_MIN.slice( 0, 10 ) }
						max={ DATE_INPUT_MAX.slice( 0, 10 ) }
						aria-describedby={ help ? helpId : undefined }
						aria-invalid={ problem ? true : undefined }
						value={ dateValue }
						onChange={ () => store( 'date' ) }
						// A half-typed date fires no change (the value stays ""): the browser's verdict is read when the field is left.
						onBlur={ ( event: FocusEvent< HTMLInputElement > ) => {
							if ( event.target.validity?.badInput || event.target.value !== dateValue ) {
								store( 'date' );
							} else if ( isInvalidDate( stored ) ) {
								// A half-typed date cleared segment by segment ends as "" without a change event: read both inputs again.
								store( 'time' );
							}
						} }
					/>
					<input
						ref={ timeRef }
						id={ timeId }
						className="components-text-control__input"
						type="time"
						aria-label={ timeLabel }
						aria-describedby={ help ? helpId : undefined }
						aria-invalid={ problem ? true : undefined }
						value={ timeValue }
						onChange={ () => store( 'time' ) }
						onBlur={ ( event: FocusEvent< HTMLInputElement > ) => {
							// Clearing a time segment by segment passes through a half-typed time (stored as invalid) and ends as ""
							// without a change event, so an invalid stored value is read again when the field is left.
							if ( event.target.validity?.badInput || event.target.value !== timeValue || isInvalidDate( stored ) ) {
								store( 'time' );
							}
						} }
					/>
				</div>
				{ help ? (
					<p id={ helpId } className="components-base-control__help">
						{ help }
					</p>
				) : null }
			</div>
		);
	}

	return DateTimeControl;
}
