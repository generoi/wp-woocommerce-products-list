/**
 * Human text for the wc/v3 error codes a save can come back with. The raw
 * message ("Invalid ID.") stays in the log; the modal shows what it means.
 */
import { __ } from '@wordpress/i18n';

const MESSAGES: Record< string, () => string > = {
	woocommerce_rest_product_invalid_id: () => __( 'This product no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_variation_invalid_id: () => __( 'This variation no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_product_variation_invalid_id: () => __( 'This variation no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_invalid_id: () => __( 'This item no longer exists (it was deleted).', 'wp-woocommerce-products-list' ),
	woocommerce_rest_cannot_edit: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	woocommerce_rest_cannot_batch: () => __( 'You are not allowed to bulk edit (edit_others_products is required).', 'wp-woocommerce-products-list' ),
	rest_forbidden: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	rest_cannot_edit: () => __( 'You are not allowed to edit this item.', 'wp-woocommerce-products-list' ),
	product_invalid_sku: () => __( 'This SKU is already used by another product.', 'wp-woocommerce-products-list' ),
	woocommerce_rest_product_invalid_sku: () => __( 'This SKU is already used by another product.', 'wp-woocommerce-products-list' ),
	rest_invalid_param: () => __( 'A value was rejected by WooCommerce.', 'wp-woocommerce-products-list' ),
	missing_result: () => __( 'WooCommerce returned no result for this item.', 'wp-woocommerce-products-list' ),
	// The server's concurrency checks (docs/contracts.md §3.6).
	wc_products_list_conflict: () => __( 'Changed by someone else since it was loaded, so it was not saved. It now shows the current values: check them and apply the edits again.', 'wp-woocommerce-products-list' ),
	wc_products_list_locked: () => __( 'Another save of this item was running, so it was not saved. Try again in a moment.', 'wp-woocommerce-products-list' ),
	wc_products_list_trashed: () => __( 'This item is in the Trash, so it was not saved.', 'wp-woocommerce-products-list' ),
	wc_products_list_deleted: () => __( 'Deleted meanwhile (another tab or user); nothing was saved for this item.', 'wp-woocommerce-products-list' ),
	// The server's message names the user (Concurrency::editingError) and is shown instead; this is the fallback.
	wc_products_list_editing: () => __( 'Another user is editing this product in the product editor; nothing was saved for this item.', 'wp-woocommerce-products-list' ),
};

/** Per-item refusals of the server's concurrency checks: the server logs them as skipped rows itself (not posted to /log/skipped again). */
const SERVER_LOGGED_CODES: ReadonlySet< string > = new Set( [ 'wc_products_list_conflict', 'wc_products_list_locked', 'wc_products_list_trashed', 'wc_products_list_deleted', 'wc_products_list_editing' ] );

export function isServerLoggedCode( code: string | undefined ): boolean {
	return code !== undefined && SERVER_LOGGED_CODES.has( code );
}

/** Whether a row was refused because it changed meanwhile (reload it, then apply again). */
export function isConflictCode( code: string | undefined ): boolean {
	return code === 'wc_products_list_conflict';
}

const SKU_CODES: ReadonlySet< string > = new Set( [ 'product_invalid_sku', 'woocommerce_rest_product_invalid_sku' ] );

const FIELD_OF_CODE: Record< string, string > = {
	product_invalid_sku: 'sku',
	woocommerce_rest_product_invalid_sku: 'sku',
	product_invalid_global_unique_id: 'global_unique_id',
};

/** The form field a row error is about (a taken SKU is the SKU field's), for flagging its control; undefined when it is about the row. */
export function fieldOfErrorCode( code: string | undefined ): string | undefined {
	return code ? FIELD_OF_CODE[ code ] : undefined;
}

/** The message to show for a failed row: a known code's text, else the server's message (with the code's detail kept when it adds something). */
export function humanizeError( code: string | undefined, message: string ): string {
	const known = code ? MESSAGES[ code ] : undefined;

	if ( ! known ) {
		return message || __( 'The item could not be saved.', 'wp-woocommerce-products-list' );
	}

	const text = known();

	// The plugin names the product that owns a taken SKU ("… is already used by "Name" (#206).", Saves::skuOwnerMessage): that says more.
	if ( code && SKU_CODES.has( code ) && message && /#\d+/.test( message ) ) {
		return message;
	}

	// A post lock: the server names who has it open in the product editor.
	if ( code === 'wc_products_list_editing' && message ) {
		return message;
	}

	if ( code === 'rest_invalid_param' && message ) {
		return `${ text } ${ message }`;
	}

	return text;
}

const GONE_CODES: ReadonlySet< string > = new Set( [
	'woocommerce_rest_product_invalid_id',
	'woocommerce_rest_variation_invalid_id',
	// wc/v3's variations controller (woocommerce_rest_{post_type}_invalid_id) and the plugin's variations batch route.
	'woocommerce_rest_product_variation_invalid_id',
	'woocommerce_rest_invalid_id',
	'rest_post_invalid_id',
	// The server's deleted check (docs/contracts.md §3.6): deleted after the save loaded it.
	'wc_products_list_deleted',
] );

/** Whether an error code means the row no longer exists (nothing to retry; the row leaves the list). */
export function isGoneCode( code: string | undefined ): boolean {
	return code !== undefined && GONE_CODES.has( code );
}

/** The message of a row action's per-id result: a lock held by a save of the row reads like the save's own. */
export function actionResultMessage( code: string | undefined, message: string | undefined ): string {
	if ( code === 'wc_products_list_locked' ) {
		return __( 'Another save of this item was still running, so the action was not applied to it. Try again in a moment.', 'wp-woocommerce-products-list' );
	}

	return message || __( 'The action failed.', 'wp-woocommerce-products-list' );
}
