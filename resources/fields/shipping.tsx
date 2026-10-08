import { __, sprintf } from '@wordpress/i18n';
import type { ProductField, RawDimensions, Settings } from '../types';
import { OptionCell } from './components/option-cell';
import { PHYSICAL_TYPES, field } from './helpers';

export function createWeightField( settings: Settings ): ProductField {
	return field( {
		id: 'weight',
		type: 'number',
		label: __( 'Weight', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		render: ( { item } ) => <span>{ item.weight ? `${ item.weight } ${ settings.units.weight }` : '—' }</span>,
		getValue: ( { item } ) => ( item.weight ? Number( item.weight ) : undefined ),
		rest: { write: ( value ) => ( { weight: value === undefined || value === null ? '' : String( value ) } ), applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: { group: 'shipping', bulk: 'default', order: 60 },
	} );
}

export function createDimensionsField( settings: Settings ): ProductField {
	return field( {
		id: 'dimensions',
		type: 'text',
		label: __( 'Dimensions', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		readOnly: true,
		render: ( { item } ) => {
			const d = item.dimensions as RawDimensions | undefined;

			if ( ! d || ( ! d.length && ! d.width && ! d.height ) ) {
				return <span>—</span>;
			}

			return <span>{ sprintf( '%1$s × %2$s × %3$s %4$s', d.length || '–', d.width || '–', d.height || '–', settings.units.dimension ) }</span>;
		},
		getValue: ( { item } ) => {
			const d = item.dimensions as RawDimensions | undefined;

			return d ? [ d.length, d.width, d.height ].filter( Boolean ).join( ' × ' ) : '';
		},
		rest: { applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: false,
	} );
}

export function createShippingClassField( settings: Settings ): ProductField {
	const options = [ { value: '', label: __( 'No shipping class', 'wp-woocommerce-products-list' ) }, ...settings.shippingClasses.map( ( c ) => ( { value: c.value, label: c.label } ) ) ];

	return field( {
		id: 'shipping_class',
		type: 'text',
		label: __( 'Shipping class', 'wp-woocommerce-products-list' ),
		elements: options,
		enableSorting: false,
		filterBy: settings.shippingClasses.length ? { operators: [ 'isAny' ] } : false,
		render: ( { item } ) => <OptionCell value={ item.shipping_class } options={ options } />,
		getValue: ( { item } ) => item.shipping_class ?? '',
		rest: { param: 'shipping_class', applies: { product: true, variation: true } },
		productTypes: [ ...PHYSICAL_TYPES ],
		edit: { group: 'shipping', bulk: 'default', order: 61 },
	} );
}
