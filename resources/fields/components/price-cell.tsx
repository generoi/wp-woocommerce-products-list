import { __, _n, sprintf } from '@wordpress/i18n';
import { getSettings } from '../../settings';
import type { ProductListItem, Settings } from '../../types';
import { formatPrice } from '../currency';
import { formatSiteDate } from '../site-date';

export interface ScheduledSale {
	from: string;
	to?: string;
	/** The exact instants, when the row carries the `_gmt` keys. */
	fromGmt?: string;
	toGmt?: string;
}

/** Whether a wc/v3 sale window on the row lies in the future (a scheduled sale). */
export function scheduledSale( item: ProductListItem, now: number = Date.now() ): ScheduledSale | null {
	if ( item.on_sale || ! item.sale_price || ! item.date_on_sale_from ) {
		return null;
	}

	// `*_gmt` is exact; without it the site-local string is parsed as-is
	// (off by the site offset at most, which cannot move a future date into the past by a day).
	const gmt = item.date_on_sale_from_gmt;
	const start = Date.parse( gmt ? `${ gmt }Z` : item.date_on_sale_from );

	if ( ! Number.isFinite( start ) || start <= now ) {
		return null;
	}

	return {
		from: item.date_on_sale_from,
		to: item.date_on_sale_to ?? undefined,
		fromGmt: gmt ?? undefined,
		toGmt: ( item as { date_on_sale_to_gmt?: string | null } ).date_on_sale_to_gmt ?? undefined,
	};
}

function shortDate( value: string, gmt: string | undefined, settings: Settings ): string {
	return formatSiteDate( settings.dateFormat, value, gmt, settings );
}

/** "20.11.2026 – 30.11.2026", or "from 20.11.2026" without an end. */
function saleWindow( from: string, fromGmt: string | undefined, to: string | null | undefined, toGmt: string | undefined, settings: Settings ): string {
	const start = shortDate( from, fromGmt, settings );
	const end = to ? shortDate( to, toGmt, settings ) : '';

	return end
		? sprintf(
				/* translators: 1: start date, 2: end date */
				__( '%1$s – %2$s', 'wp-woocommerce-products-list' ),
				start,
				end
		  )
		: sprintf(
				/* translators: %s: start date */
				__( 'from %s', 'wp-woocommerce-products-list' ),
				start
		  );
}

/**
 * The sale line of a variable parent, from `wc_products_list.sale_summary`:
 * "On sale · 3 variations" while a sale is in force, "Scheduled · 12
 * variations 12.10.2026 – 18.10.2026" before it starts, so a campaign on the
 * variations shows on the parent row without expanding it.
 */
export function VariationSaleSummary( { item }: { item: ProductListItem } ) {
	const settings = getSettings();
	const summary = item.wc_products_list?.sale_summary;

	if ( ! summary || ( ! summary.on_sale && ! summary.scheduled ) ) {
		return null;
	}

	const active = summary.on_sale > 0;
	const count = active ? summary.on_sale : summary.scheduled;
	/* translators: %d: number of variations */
	const variations = sprintf( _n( '%d variation', '%d variations', count, 'wp-woocommerce-products-list' ), count );
	const window = summary.from ? saleWindow( summary.from, undefined, summary.to, undefined, settings ) : '';
	const label = active
		? sprintf(
				/* translators: 1: "3 variations", 2: the sale window */
				__( 'On sale: %1$s %2$s', 'wp-woocommerce-products-list' ),
				variations,
				window
		  ).trim()
		: sprintf(
				/* translators: 1: "12 variations", 2: the sale window */
				__( 'Scheduled sale: %1$s %2$s', 'wp-woocommerce-products-list' ),
				variations,
				window
		  ).trim();

	return (
		<span className="wc-products-list__price-scheduled" title={ label }>
			<span className={ `wc-products-list__price-scheduled-badge${ active ? ' is-sale' : '' }` }>
				{ active ? __( 'On sale', 'wp-woocommerce-products-list' ) : __( 'Scheduled', 'wp-woocommerce-products-list' ) }
			</span>
			{ ' ' }
			{ variations }
			{ window ? ` ${ window }` : '' }
		</span>
	);
}

/**
 * The computed price: the sale price with the regular one struck through
 * while on sale; "From X" for a variable parent (wc/v3 `price` is its
 * lowest variation price); a "Scheduled 99,00 € 20.11.2026 – 30.11.2026"
 * line under the current price when a sale is scheduled but not on yet, so
 * campaign prep is visible before it goes live and is never read as the
 * price in force.
 */
export function PriceCell( { item }: { item: ProductListItem } ) {
	const settings = getSettings();
	const price = formatPrice( item.price ?? '', settings );

	if ( ! price ) {
		return <span className="wc-products-list__price wc-products-list__price--empty">—</span>;
	}

	if ( item._kind === 'product' && ( item as { type?: string } ).type === 'variable' ) {
		return (
			<span className="wc-products-list__price">
				{ sprintf( /* translators: %s: lowest price */ __( 'From %s', 'wp-woocommerce-products-list' ), price ) }
				<VariationSaleSummary item={ item } />
			</span>
		);
	}

	if ( item.on_sale && item.regular_price && item.regular_price !== item.price ) {
		return (
			<span className="wc-products-list__price wc-products-list__price--sale">
				<del>{ formatPrice( item.regular_price, settings ) }</del> <ins>{ price }</ins>
			</span>
		);
	}

	const scheduled = scheduledSale( item );

	if ( scheduled ) {
		const sale = formatPrice( item.sale_price ?? '', settings );
		const window = saleWindow( scheduled.from, scheduled.fromGmt, scheduled.to, scheduled.toGmt, settings );
		const label = sprintf(
			/* translators: 1: sale price, 2: the sale window ("20.11.2026 – 30.11.2026" or "from 20.11.2026") */
			__( 'Scheduled sale: %1$s, %2$s', 'wp-woocommerce-products-list' ),
			sale,
			window
		);

		return (
			<span className="wc-products-list__price wc-products-list__price--scheduled">
				{ price }
				<span className="wc-products-list__price-scheduled" title={ label }>
					<span className="wc-products-list__price-scheduled-badge">{ __( 'Scheduled', 'wp-woocommerce-products-list' ) }</span>
					{ ' ' }
					{ sprintf(
						/* translators: 1: sale price, 2: the sale window */
						__( '%1$s %2$s', 'wp-woocommerce-products-list' ),
						sale,
						window
					) }
				</span>
			</span>
		);
	}

	return <span className="wc-products-list__price">{ price }</span>;
}

export function MoneyCell( { value }: { value: unknown } ) {
	const text = formatPrice( typeof value === 'string' || typeof value === 'number' ? value : null, getSettings() );

	return <span className="wc-products-list__price">{ text || '—' }</span>;
}
