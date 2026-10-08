<?php

namespace GeneroWP\ProductsList\Actions;

use Throwable;
use WC_Admin_Duplicate_Product;
use WC_Data_Exception;
use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Duplicate a product the way the classic list's "Duplicate" link does:
 * a draft copy named "… (Copy)" with its variations, through
 * WC_Admin_Duplicate_Product, which REST requests have to include
 * themselves. The copy's id is returned as `new_id`, and logged as the
 * row's new value (field `duplicate`) with the copy's title in the
 * context, so History can name and link what a duplicate produced.
 *
 * The copy is created inside a REST request, where WooCommerce's product
 * data store takes a "SKU lock" before it saves a product with a SKU
 * (a guard against two concurrent REST creates of the same SKU). That
 * lock is short-circuited by third parties through
 * `wc_product_pre_lock_on_sku`, and Polylang for WooCommerce answers
 * `false` for a product that has no language yet, which every fresh copy
 * is; WooCommerce then deletes the copy and throws "already present in
 * the lookup table". The classic link never hits this because it is not
 * a REST request. The duplicate's SKU was just generated unique by
 * WooCommerce itself, so the lock is answered here for the duration of
 * the copy.
 */
final class Duplicate implements Action
{
    public const FILTER_LOCK = 'wc_product_pre_lock_on_sku';

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

        // Before anyone else (Polylang for WooCommerce sits at 10), and
        // only while this copy is made.
        add_filter(self::FILTER_LOCK, [self::class, 'lockObtained'], 0);

        try {
            $copy = (new WC_Admin_Duplicate_Product)->product_duplicate($product);
        } catch (Throwable $e) {
            return $this->failure($product, $e);
        } finally {
            remove_filter(self::FILTER_LOCK, [self::class, 'lockObtained'], 0);
        }

        if ($copy->get_id() === 0) {
            return new WP_Error('wc_products_list_duplicate_failed', sprintf(
                /* translators: %s: product name */
                __('"%s" could not be duplicated.', 'wp-woocommerce-products-list'),
                $product->get_name()
            ));
        }

        return [
            'new_id' => $copy->get_id(),
            'changes' => ['duplicate' => [null, $copy->get_id()]],
            'context' => ['new_id' => $copy->get_id(), 'new_title' => $copy->get_name()],
        ];
    }

    /**
     * `wc_product_pre_lock_on_sku`: the lock is ours. A non-null answer
     * stops WooCommerce's own INSERT and every later filter.
     */
    public static function lockObtained(): bool
    {
        return true;
    }

    /**
     * WooCommerce's exceptions, as a store manager reads them: the SKU
     * cases name the SKU and the product, anything else keeps its message
     * but says which product it was about.
     */
    private function failure(WC_Product $product, Throwable $e): WP_Error
    {
        $message = $e->getMessage();
        $name = $product->get_name();
        $sku = $product->get_sku();
        $isSku = ($e instanceof WC_Data_Exception && in_array($e->getErrorCode(), ['product_invalid_sku', 'product_invalid_global_unique_id'], true))
            || stripos($message, 'sku') !== false
            || stripos($message, 'lookup table') !== false;

        if ($isSku) {
            return new WP_Error('wc_products_list_duplicate_sku', sprintf(
                /* translators: 1: product name, 2: SKU */
                __('Could not duplicate "%1$s": a product with a SKU derived from %2$s already exists (possibly in the Trash).', 'wp-woocommerce-products-list'),
                $name,
                $sku !== '' ? $sku : __('its SKU', 'wp-woocommerce-products-list')
            ), ['exception' => $message]);
        }

        return new WP_Error('wc_products_list_duplicate_failed', sprintf(
            /* translators: 1: product name, 2: error message */
            __('Could not duplicate "%1$s": %2$s', 'wp-woocommerce-products-list'),
            $name,
            wp_strip_all_tags($message)
        ), ['exception' => $message]);
    }
}
