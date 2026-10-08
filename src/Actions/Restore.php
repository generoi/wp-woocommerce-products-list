<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Restore from the trash to the status it had: WooCommerce's
 * `wp_untrash_post_status` filter puts products back where they were
 * rather than in draft, which is what `wp_untrash_post` does on its own.
 */
final class Restore implements Action
{
    public function id(): string
    {
        return 'restore';
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
        if ($product->get_status() !== 'trash') {
            return new WP_Error('wc_products_list_not_trashed', __('The product is not in the trash.', 'wp-woocommerce-products-list'));
        }

        $previous = (string) get_post_meta($product->get_id(), '_wp_trash_meta_status', true);

        if (! wp_untrash_post($product->get_id())) {
            return new WP_Error('wc_products_list_restore_failed', __('The product could not be restored.', 'wp-woocommerce-products-list'));
        }

        $status = (string) get_post_status($product->get_id());

        if ($previous !== '' && $status !== $previous) {
            // A site filter overrode the previous status; keep what WooCommerce
            // intended, which is what the app showed before the trash.
            wp_update_post(['ID' => $product->get_id(), 'post_status' => $previous]);
            $status = $previous;
        }

        wc_delete_product_transients($product->get_id());

        return ['changes' => ['status' => ['trash', $status]]];
    }
}
