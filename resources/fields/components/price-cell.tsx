import { __, sprintf } from '@wordpress/i18n';
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
		return <span className="wc-products-list__price">{ sprintf( /* translators: %s: lowest price */ __( 'From %s', 'wp-woocommerce-products-list' ), price ) }</span>;
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
		const from = shortDate( scheduled.from, scheduled.fromGmt, settings );
		const to = scheduled.to ? shortDate( scheduled.to, scheduled.toGmt, settings ) : '';
		const window = to
			? sprintf(
					/* translators: 1: start date, 2: end date */
					__( '%1$s – %2$s', 'wp-woocommerce-products-list' ),
					from,
					to
			  )
			: sprintf(
					/* translators: %s: start date */
					__( 'from %s', 'wp-woocommerce-products-list' ),
					from
			  );
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
