import { __ } from '@wordpress/i18n';
import type { ProductField, Settings } from '../types';
import { field, valueOf } from './helpers';

function excerpt( html: unknown ): string {
	const text = typeof html === 'string' ? html.replace( /<[^>]+>/g, ' ' ).replace( /\s+/g, ' ' ).trim() : '';

	return text.length > 80 ? `${ text.slice( 0, 80 ) }…` : text;
}

/** HTML content fields: quick edit only (a formatted-text editor, edit/html-text-control.tsx), excerpt in a column. */
export function createDescriptionFields( _settings: Settings ): ProductField[] {
	return [
		field( {
			id: 'short_description',
			type: 'text',
			label: __( 'Short description', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			Edit: { control: 'textarea', rows: 4 },
			html: true,
			render: ( { item } ) => <span className="wc-products-list__excerpt">{ excerpt( valueOf( item, 'short_description' ) ) || '—' }</span>,
			getValue: ( { item } ) => valueOf( item, 'short_description' ) ?? '',
			rest: { applies: { product: true, variation: false } },
			edit: { group: 'content', bulk: false, order: 100 },
		} ),
		field( {
			id: 'description',
			type: 'text',
			label: __( 'Description', 'wp-woocommerce-products-list' ),
			enableSorting: false,
			filterBy: false,
			Edit: { control: 'textarea', rows: 8 },
			html: true,
			render: ( { item } ) => <span className="wc-products-list__excerpt">{ excerpt( item.description ) || '—' }</span>,
			getValue: ( { item } ) => item.description ?? '',
			rest: { applies: { product: true, variation: true } },
			edit: { group: 'content', bulk: false, order: 101 },
		} ),
	];
}
