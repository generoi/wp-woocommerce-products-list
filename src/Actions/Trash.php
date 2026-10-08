<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Move to trash. Through the CRUD object so WooCommerce's data store runs
 * its own cleanup (lookup tables, transients) on the way.
 */
final class Trash implements Action
{
    public function id(): string
    {
        return 'trash';
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

        if ($old === 'trash') {
            return [];
        }

        if (! $product->delete(false)) {
            return new WP_Error('wc_products_list_trash_failed', __('The product could not be moved to the trash.', 'wp-woocommerce-products-list'));
        }

        return ['changes' => ['status' => [$old, 'trash']]];
    }
}
