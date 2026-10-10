import { __, _n, sprintf } from '@wordpress/i18n';
import type { ProductField, ProductListItem, Settings, VariationStockSummary } from '../types';
import { OptionCell } from './components/option-cell';
import { field } from './helpers';

/** "4 of 16 variations out of stock". */
export function variationStockLabel( summary: VariationStockSummary ): string {
	return sprintf(
		/* translators: 1: variations out of stock, 2: variations in total */
		_n( '%1$d of %2$d variation out of stock', '%1$d of %2$d variations out of stock', summary.total, 'wp-woocommerce-products-list' ),
		summary.out_of_stock,
		summary.total
	);
}

/** The variation stock summary of a variable parent row, when the server sent one and something is out. */
export function variationStockOf( item: ProductListItem ): VariationStockSummary | null {
	const summary = item._kind === 'product' ? item.wc_products_list?.variation_stock : null;

	return summary && typeof summary.out_of_stock === 'number' && summary.out_of_stock > 0 ? summary : null;
}

/**
 * The stock status, with the managed quantity beside it ("In stock · 12")
 * so a restock can be planned from the list without another column, and on
 * a variable parent how many of its variations are out ("4 of 16 variations
 * out of stock"), so the sizes to restock are found without expanding rows.
 */
export function createStockStatusField( settings: Settings ): ProductField {
	return field( {
		id: 'stock_status',
		type: 'text',
		// The label is also the edit form's: it stays "Stock". As a filter it
		// judges the product's own status (a variable product is out of stock
		// only when every variation is) and narrows the expanded variations to
		// the same status ("3 of 15 variations match"); "Variation stock" is the
		// any-variation filter.
		label: __( 'Stock', 'wp-woocommerce-products-list' ),
		elements: settings.stockStatuses,
		// wc/v3 validates `stock_status` against its enum: one value at a time.
		filterBy: { operators: [ 'is' ], isPrimary: true },
		// Sorted by the managed quantity (Rest\ListQuery `orderby=stock_quantity`):
		// ascending puts what is out and what is low first, the restock view.
		enableSorting: true,
		render: ( { item } ) => {
			const managed = item.manage_stock === true && typeof item.stock_quantity === 'number';
			const variations = variationStockOf( item );

			return (
				<span className={ `wc-products-list__stock wc-products-list__stock--${ item.stock_status ?? 'unknown' }` }>
					<OptionCell value={ item.stock_status } options={ settings.stockStatuses } />
					{ managed && (
						<span className="wc-products-list__stock-qty" title={ __( 'Stock quantity', 'wp-woocommerce-products-list' ) }>
							{ item.stock_quantity }
						</span>
					) }
					{ variations && <span className="wc-products-list__stock-variations">{ variationStockLabel( variations ) }</span> }
				</span>
			);
		},
		getValue: ( { item } ) => item.stock_status ?? '',
		rest: { fields: [ 'stock_status', 'stock_quantity', 'manage_stock' ], param: 'stock_status', sortParam: 'stock_quantity', applies: { product: true, variation: true } },
		edit: { group: 'inventory', bulk: 'default', order: 32, label: __( 'Stock status', 'wp-woocommerce-products-list' ) },
	} );
}

/**
 * A filter, not a column: variable products with at least one variation in
 * a stock status ("Any variation: Out of stock" is the restock list).
 * `variation_stock_status` is mapped by Rest\ListQuery (docs/contracts.md §3.1).
 */
export function createVariationStockFilter( settings: Settings ): ProductField {
	return field( {
		id: 'variation_stock',
		label: __( 'Variation stock', 'wp-woocommerce-products-list' ),
		elements: settings.stockStatuses.map( ( option ) => ( {
			value: option.value,
			/* translators: %s: a stock status ("Out of stock") */
			label: sprintf( __( 'Any variation: %s', 'wp-woocommerce-products-list' ), option.label ),
		} ) ),
		filterBy: { operators: [ 'is' ] },
		readOnly: true,
		enableSorting: false,
		enableGlobalSearch: false,
		// Not a column: keep it out of the column pickers.
		enableHiding: false,
		filterOnly: true,
		render: () => null,
		getValue: () => undefined,
		rest: { fields: [], param: 'variation_stock_status', applies: { product: true, variation: false } },
		edit: false,
	} );
}
