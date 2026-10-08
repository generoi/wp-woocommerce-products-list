/**
 * The DataForm control for the sale dates: a labelled `datetime-local`
 * input in the site's wall-clock time. DataViews' own datetime control
 * names its input "Date time" for assistive technology and converts to a
 * UTC instant; this one carries the field's label ("Sale from") and emits
 * `Y-m-d\TH:i:s` the way wc/v3 stores it, so what is typed is what the
 * shop runs.
 */
import { dateI18n } from '@wordpress/date';
import { useId } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType, FocusEvent } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { Settings } from '../types';
import { InputControl } from '../ui';
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

const INPUT_DATE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * What the input emits → the wc/v3 site-time form. Empty stays empty (clear
 * the date); anything else that is not a four-digit-year date ("202623-10-18T05:09")
 * becomes the invalid marker, never a silent "no date".
 */
export function fromInputDateTime( text: string ): string {
	if ( text === '' ) {
		return '';
	}

	const match = INPUT_DATE.exec( text );

	return match ? `${ match[ 1 ] }T${ match[ 2 ] }:00` : invalidDate( text );
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
		const stored = data[ field.id ];
		const value = toInputDateTime( stored );
		const problem = options.problem ? options.problem( data, field.id ) : null;
		/* translators: %s: the site's timezone, e.g. Europe/Helsinki */
		const zone = settings.timezone ? sprintf( __( 'Site time (%s).', 'wp-woocommerce-products-list' ), settings.timezone ) : '';
		const store = ( next: string ) => {
			if ( next !== ( typeof stored === 'string' ? stored : '' ) ) {
				onChange( { [ field.id ]: next } );
			}
		};

		return (
			<div className={ `wc-pl-date-control${ problem ? ' is-invalid' : '' }` }>
				<InputControl
					__next40pxDefaultSize
					id={ id }
					type="datetime-local"
					min={ DATE_INPUT_MIN }
					max={ DATE_INPUT_MAX }
					label={ field.label }
					hideLabelFromVision={ hideLabelFromVision }
					help={ problem ?? ( [ field.description, zone ].filter( Boolean ).join( ' ' ) || undefined ) }
					aria-invalid={ problem ? true : undefined }
					value={ value }
					onChange={ ( next, extra ) => {
						const target = ( extra as { event?: { target?: unknown } } | undefined )?.event?.target;

						store( target instanceof HTMLInputElement ? readDateInput( target ) : fromInputDateTime( next ?? '' ) );
					} }
					// A half-typed date fires no change (the value stays ""): the browser's verdict is read when the field is left.
					onBlur={ ( event: FocusEvent< HTMLInputElement > ) => {
						if ( event.target.validity?.badInput || event.target.value !== value ) {
							store( readDateInput( event.target ) );
						}
					} }
				/>
			</div>
		);
	}

	return DateTimeControl;
}
