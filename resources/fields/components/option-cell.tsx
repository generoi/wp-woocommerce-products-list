import type { Option } from '../../types';

/** The label of a `{value, label}` option, the raw value when unknown. */
export function OptionCell( { value, options }: { value: unknown; options: Option[] } ) {
	if ( value === undefined || value === null || value === '' ) {
		return <span className="wc-products-list__option wc-products-list__option--empty">—</span>;
	}

	const option = options.find( ( o ) => o.value === String( value ) );

	return <span className="wc-products-list__option">{ option?.label ?? String( value ) }</span>;
}
