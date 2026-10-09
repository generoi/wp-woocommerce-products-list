/**
 * `CheckboxControl` with an id of its own. DataViews 20 inlines its own
 * copy of @wordpress/components, whose instance counter also starts at
 * "inspector-checkbox-control-0": the editor's first checkbox and the
 * list's select-all checkbox would share that id, and a click on the
 * editor checkbox's label would tick every row of the list instead.
 */
import { CheckboxControl as BaseCheckboxControl } from '@wordpress/components';
import { useId } from '@wordpress/element';
import type { ComponentProps } from 'react';

export function CheckboxControl( props: ComponentProps< typeof BaseCheckboxControl > ) {
	const generated = `wc-pl-checkbox-${ useId().replace( /:/g, '' ) }`;

	return <BaseCheckboxControl { ...props } id={ props.id ?? generated } />;
}

export default CheckboxControl;
