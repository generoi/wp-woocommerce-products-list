/**
 * The row count under the table. DataViews' own footer counts `data.length`,
 * which in a hierarchical list is parents plus the expanded variations and
 * placeholder rows ("136 of 855 items" with 36 variations open), so the
 * footer's count is hidden by CSS and this label sits in the toolbar.
 */
import { _n, sprintf } from '@wordpress/i18n';
import type { ProductListItem } from '../types/product';

export interface FooterCountInput {
	data: ProductListItem[];
	selection: string[];
	totalItems: number;
}

export function footerCountLabel( { data, selection, totalItems }: FooterCountInput ): string {
	const byId = new Map( data.map( ( row ) => [ String( row.id ), row ] ) );

	if ( selection.length ) {
		let products = 0;
		let variations = 0;

		for ( const id of selection ) {
			const row = byId.get( id );

			if ( row?._kind === 'variation' ) {
				variations += 1;
			} else {
				products += 1;
			}
		}

		/* translators: %d: number of selected rows */
		const selected = sprintf( _n( '%d selected', '%d selected', selection.length, 'wp-woocommerce-products-list' ), selection.length );

		if ( products && variations ) {
			return `${ selected } (${ sprintf(
				/* translators: %d: number of products */
				_n( '%d product', '%d products', products, 'wp-woocommerce-products-list' ),
				products
			) }, ${ sprintf(
				/* translators: %d: number of variations */
				_n( '%d variation', '%d variations', variations, 'wp-woocommerce-products-list' ),
				variations
			) })`;
		}

		return selected;
	}

	const parents = data.filter( ( row ) => row._level === 0 && ! row._placeholder ).length;
	const variations = data.filter( ( row ) => row._kind === 'variation' && ! row._placeholder ).length;
	const label =
		parents < totalItems
			? sprintf(
					/* translators: 1: products on this page, 2: products in total */
					_n( '%1$d of %2$d product', '%1$d of %2$d products', totalItems, 'wp-woocommerce-products-list' ),
					parents,
					totalItems
			  )
			: sprintf(
					/* translators: %d: number of products */
					_n( '%d product', '%d products', totalItems, 'wp-woocommerce-products-list' ),
					totalItems
			  );

	if ( variations > 0 ) {
		return `${ label } · ${ sprintf(
			/* translators: %d: number of variation rows shown */
			_n( '%d variation shown', '%d variations shown', variations, 'wp-woocommerce-products-list' ),
			variations
		) }`;
	}

	return label;
}
