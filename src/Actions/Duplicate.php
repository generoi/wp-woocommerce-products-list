<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Admin_Duplicate_Product;
use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Duplicate a product the way the classic list's "Duplicate" link does:
 * a draft copy named "… (Copy)" with its variations, through
 * WC_Admin_Duplicate_Product, which REST requests have to include
 * themselves. The copy's id is returned as `new_id`.
 */
final class Duplicate implements Action
{
    public function id(): string
    {
        return 'duplicate';
    }

    public function appliesTo(): string
    {
        return 'product';
    }

    public function can(WC_Product $product): bool
    {
        /** This filter is documented in WooCommerce. */
        $capability = apply_filters('woocommerce_duplicate_product_capability', 'manage_woocommerce');

        return current_user_can($capability) && current_user_can('edit_post', $product->get_id());
    }

    public function sanitizeArgs(array $args): array
    {
        return [];
    }

    public function run(WC_Product $product, array $args, WP_REST_Request $request): array|WP_Error
    {
        if (! class_exists(WC_Admin_Duplicate_Product::class)) {
            include_once WC()->plugin_path().'/includes/admin/class-wc-admin-duplicate-product.php';
        }

        $copy = (new WC_Admin_Duplicate_Product)->product_duplicate($product);

        if ($copy->get_id() === 0) {
            return new WP_Error('wc_products_list_duplicate_failed', __('The product could not be duplicated.', 'wp-woocommerce-products-list'));
        }

        return ['new_id' => $copy->get_id()];
    }
}
