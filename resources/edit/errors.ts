/**
 * Human text for the wc/v3 error codes a save can come back with. The raw
 * message ("Invalid ID.") stays in the log; the modal shows what it means.
 */
import { __ } from '@wordpress/i18n';

const MESSAGES: Record< string, () => string > = {
	woocommerce_rest_product_invalid_id: () => __( 'This product no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_variation_invalid_id: () => __( 'This variation no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_invalid_id: () => __( 'This item no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_cannot_edit: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	woocommerce_rest_cannot_batch: () => __( 'You are not allowed to bulk edit (edit_others_products is required).', 'wp-woocommerce-products-list' ),
	rest_forbidden: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	rest_cannot_edit: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	product_invalid_sku: () => __( 'This SKU is already used by another product.', 'wp-woocommerce-products-list' ),
	woocommerce_rest_product_invalid_sku: () => __( 'This SKU is already used by another product.', 'wp-woocommerce-products-list' ),
	rest_invalid_param: () => __( 'A value was rejected by WooCommerce.', 'wp-woocommerce-products-list' ),
	missing_result: () => __( 'WooCommerce returned no result for this item.', 'wp-woocommerce-products-list' ),
};

/** The message to show for a failed row: a known code's text, else the server's message (with the code's detail kept when it adds something). */
export function humanizeError( code: string | undefined, message: string ): string {
	const known = code ? MESSAGES[ code ] : undefined;

	if ( ! known ) {
		return message || __( 'The item could not be saved.', 'wp-woocommerce-products-list' );
	}

	const text = known();

	if ( code === 'rest_invalid_param' && message ) {
		return `${ text } ${ message }`;
	}

	return text;
}

const GONE_CODES: ReadonlySet< string > = new Set( [ 'woocommerce_rest_product_invalid_id', 'woocommerce_rest_variation_invalid_id', 'woocommerce_rest_invalid_id', 'rest_post_invalid_id' ] );

/** Whether an error code means the row no longer exists (nothing to retry; the row leaves the list). */
export function isGoneCode( code: string | undefined ): boolean {
	return code !== undefined && GONE_CODES.has( code );
}
