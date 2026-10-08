import { __, sprintf } from '@wordpress/i18n';
import { getSettings } from '../../settings';
import type { ProductListItem } from '../../types';
import { formatPrice } from '../currency';

/**
 * The computed price: the sale price with the regular one struck through
 * while on sale; "From X" for a variable parent (wc/v3 `price` is its
 * lowest variation price).
 */
export function PriceCell( { item }: { item: ProductListItem } ) {
	const settings = getSettings();
	const price = formatPrice( item.price ?? '', settings );

	if ( ! price ) {
		return <span className="wc-products-list__price wc-products-list__price--empty">—</span>;
	}

	if ( item._kind === 'product' && ( item as { type?: string } ).type === 'variable' ) {
		return <span className="wc-products-list__price">{ sprintf( /* translators: %s: lowest price */ __( 'From %s', 'wp-woocommerce-products-list' ), price ) }</span>;
	}

	if ( item.on_sale && item.regular_price && item.regular_price !== item.price ) {
		return (
			<span className="wc-products-list__price wc-products-list__price--sale">
				<del>{ formatPrice( item.regular_price, settings ) }</del> <ins>{ price }</ins>
			</span>
		);
	}

	return <span className="wc-products-list__price">{ price }</span>;
}

export function MoneyCell( { value }: { value: unknown } ) {
	const text = formatPrice( typeof value === 'string' || typeof value === 'number' ? value : null, getSettings() );

	return <span className="wc-products-list__price">{ text || '—' }</span>;
}
