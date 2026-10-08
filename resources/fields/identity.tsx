import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { field, valueOf } from './helpers';

/** id, slug, menu order, permalink: the small read-mostly columns. */
export function createIdentityFields( _settings: Settings ): ProductField[] {
	return [
		field( {
			id: 'id',
			type: 'integer',
			label: __( 'ID', 'wp-woocommerce-products-list' ),
			enableSorting: true,
			filterBy: false,
			readOnly: true,
			getValue: ( { item } ) => item.id,
			rest: { sortParam: 'id', applies: { product: true, variation: true } },
			edit: false,
		} ),
		field( {
			id: 'slug',
			type: 'text',
			label: __( 'Slug', 'wp-woocommerce-products-list' ),
			enableSorting: true,
			filterBy: false,
			getValue: ( { item } ) => item.slug ?? '',
			rest: { sortParam: 'slug', applies: { product: true, variation: false } },
			edit: { group: 'general', bulk: false, order: 5 },
		} ),
		field( {
			id: 'menu_order',
			type: 'integer',
			label: __( 'Menu order', 'wp-woocommerce-products-list' ),
			enableSorting: true,
			filterBy: false,
			getValue: ( { item } ) => item.menu_order ?? 0,
			rest: { sortParam: 'menu_order', applies: { product: true, variation: true } },
			edit: { group: 'advanced', bulk: 'integer', order: 96 },
		} ),
		field( {
			id: 'permalink',
			type: 'url',
			label: __( 'Permalink', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			readOnly: true,
			render: ( { item } ) => {
				const url = valueOf( item, 'permalink' );

				return typeof url === 'string' && url ? (
					<a href={ url } target="_blank" rel="noreferrer">
						{ __( 'View', 'wp-woocommerce-products-list' ) }
					</a>
				) : (
					<span>—</span>
				);
			},
			getValue: ( { item } ) => valueOf( item, 'permalink' ) ?? '',
			rest: { applies: { product: true, variation: true } },
			edit: false,
		} ),
	];
}
