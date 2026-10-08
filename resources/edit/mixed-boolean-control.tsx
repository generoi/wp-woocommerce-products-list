/**
 * A checkbox for a boolean field whose rows disagree: indeterminate until
 * the user picks a state, which then applies to every row.
 */
import { CheckboxControl } from '@wordpress/components';
import { useId } from '@wordpress/element';
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { FormData } from './bulk-numeric-control';
import { MIXED_LABEL } from './merge';

export function createMixedBooleanControl( reference?: string | null ): ComponentType< DataFormControlProps< FormData > > {
	function MixedBooleanControl( { data, field, onChange } : DataFormControlProps< FormData > ) {
		const value = data[ field.id ];
		const undecided = value !== true && value !== false;
		// React's own id: core wp-components and dataviews' inlined copy both count
		// `inspector-checkbox-control-N` from zero, so a generated id can point the
		// label at another checkbox and leave this one unnamed.
		const id = `wc-pl-mixed-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;

		return (
			<CheckboxControl
				__nextHasNoMarginBottom
				id={ id }
				label={ field.label }
				aria-label={ undecided ? `${ field.label } (${ MIXED_LABEL })` : undefined }
				help={ reference ? reference : undefined }
				checked={ value === true }
				indeterminate={ undecided }
				onChange={ ( checked ) => onChange( { [ field.id ]: checked } ) }
			/>
		);
	}

	return MixedBooleanControl;
}
