<?php

namespace GeneroWP\ProductsList\Actions;

use GeneroWP\ProductsList\Bootstrap;
use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Delete permanently. A variable product takes its variations with it, as
 * WooCommerce's data store does. There is no way back, and the log row
 * says so.
 *
 * As in the classic list, only what is in the Trash can be deleted
 * permanently; the `wc_products_list/allow_hard_delete` filter lifts that
 * for the UI and here alike, so a scripted request cannot skip the trash
 * step the UI shows.
 */
final class Delete implements Action
{
    public function id(): string
    {
        return 'delete';
    }

    public function appliesTo(): string
    {
        return 'both';
    }

    public function can(WC_Product $product): bool
    {
        return current_user_can('delete_post', $product->get_id());
    }

    public function sanitizeArgs(array $args): array
    {
        return [];
    }

    public function run(WC_Product $product, array $args, WP_REST_Request $request): array|WP_Error
    {
        $old = $product->get_status();
        $id = $product->get_id();

        /** This filter is documented in src/Bootstrap.php. */
        if ($old !== 'trash' && ! apply_filters(Bootstrap::FILTER_ALLOW_HARD_DELETE, false)) {
            return new WP_Error('wc_products_list_not_trashed', __('Only products in the Trash can be deleted permanently.', 'wp-woocommerce-products-list'));
        }

        $product->delete(true);

        if (get_post($id) !== null) {
            return new WP_Error('wc_products_list_delete_failed', __('The product could not be deleted.', 'wp-woocommerce-products-list'));
        }

        return ['changes' => ['status' => [$old, null]]];
    }
}
