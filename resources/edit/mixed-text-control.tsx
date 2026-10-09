/**
 * The bulk control of a text field whose rows disagree: the input shows
 * "Mixed" until something is typed, and typing then erasing is "no change"
 * again (use-edit-state drops it). Emptying the field on every row is a
 * separate, explicit choice: the "Clear on all rows" checkbox, which the
 * edit state turns into an empty string on Save.
 */
import { __experimentalInputControl as InputControl } from '@wordpress/components';
import { CheckboxControl } from '../ui/checkbox-control';
import { useId } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { FormData } from './bulk-numeric-control';
import { CLEAR_VALUE, MIXED_LABEL } from './merge';

export function createMixedTextControl(): ComponentType< DataFormControlProps< FormData > > {
	function MixedTextControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const id = `wc-pl-mixed-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;
		const raw = data[ field.id ];
		const clearing = raw === CLEAR_VALUE;
		const value = clearing || raw === undefined || raw === null ? '' : String( raw );

		return (
			<div className="wc-pl-edit__mixed-text">
				<InputControl
					__next40pxDefaultSize
					id={ id }
					label={ field.label }
					hideLabelFromVision={ hideLabelFromVision }
					help={ field.description }
					placeholder={ MIXED_LABEL }
					value={ value }
					disabled={ clearing }
					onChange={ ( next ) => onChange( { [ field.id ]: next ?? '' } ) }
				/>
				<CheckboxControl
					__nextHasNoMarginBottom
					className="wc-pl-edit__clear-all"
					label={ sprintf(
						/* translators: %s: the field's label */
						__( 'Clear %s on all rows', 'wp-woocommerce-products-list' ),
						field.label
					) }
					checked={ clearing }
					onChange={ ( checked ) => onChange( { [ field.id ]: checked ? CLEAR_VALUE : undefined } ) }
				/>
			</div>
		);
	}

	return MixedTextControl;
}
