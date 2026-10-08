/**
 * A checkbox for a boolean field whose rows disagree: indeterminate until
 * the user picks a state, which then applies to every row.
 */
import { CheckboxControl } from '@wordpress/components';
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { FormData } from './bulk-numeric-control';

export function createMixedBooleanControl( reference?: string | null ): ComponentType< DataFormControlProps< FormData > > {
	function MixedBooleanControl( { data, field, onChange } : DataFormControlProps< FormData > ) {
		const value = data[ field.id ];
		const undecided = value !== true && value !== false;

		return (
			<CheckboxControl
				__nextHasNoMarginBottom
				label={ field.label }
				help={ reference ? reference : undefined }
				checked={ value === true }
				indeterminate={ undecided }
				onChange={ ( checked ) => onChange( { [ field.id ]: checked } ) }
			/>
		);
	}

	return MixedBooleanControl;
}
