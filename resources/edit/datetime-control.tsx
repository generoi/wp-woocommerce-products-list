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
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { Settings } from '../types';
import { InputControl } from '../ui';
import type { FormData } from './bulk-numeric-control';

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;

/** A stored value → what a `datetime-local` input shows (`YYYY-MM-DDTHH:mm`); zoned instants are shown in site time. */
export function toInputDateTime( value: unknown ): string {
	if ( typeof value !== 'string' || value === '' ) {
		return '';
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

/** What the input emits → the wc/v3 site-time form; empty stays empty (clear the date). */
export function fromInputDateTime( text: string ): string {
	const match = LOCAL.exec( text );

	return match ? `${ match[ 1 ] }T${ match[ 2 ] }:00` : '';
}

export function createDateTimeControl( settings: Pick< Settings, 'timezone' > ): ComponentType< DataFormControlProps< FormData > > {
	function DateTimeControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const id = `wc-pl-date-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;
		const value = toInputDateTime( data[ field.id ] );
		/* translators: %s: the site's timezone, e.g. Europe/Helsinki */
		const zone = settings.timezone ? sprintf( __( 'Site time (%s).', 'wp-woocommerce-products-list' ), settings.timezone ) : '';

		return (
			<InputControl
				__next40pxDefaultSize
				id={ id }
				type="datetime-local"
				label={ field.label }
				hideLabelFromVision={ hideLabelFromVision }
				help={ [ field.description, zone ].filter( Boolean ).join( ' ' ) || undefined }
				value={ value }
				onChange={ ( next ) => onChange( { [ field.id ]: fromInputDateTime( next ?? '' ) } ) }
			/>
		);
	}

	return DateTimeControl;
}
