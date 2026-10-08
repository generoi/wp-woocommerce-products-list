<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Registry;
use WC_Product;
use WP_REST_Request;

/**
 * The write side of list mode: around every wc/v3 product and variation
 * save made by the app, the recorder snapshots and logs the touched
 * fields, and extensions get `wc_products_list/save` when the request
 * carries one of their write keys.
 *
 * Batch endpoints call the same controller methods per item, so the hooks
 * fire once per product with that product's own sub-request.
 */
final class Saves
{
    public const ACTION_SAVE = 'wc_products_list/save';

    /**
     * Extra top-level request keys that count as extension writes, for
     * integrations that declare no fields through the registry.
     */
    public const FILTER_WRITE_KEYS = 'wc_products_list/write_keys';

    /** @var array<int, string>|null */
    private static ?array $writeKeys = null;

    private static bool $registered = false;

    public static function register(): void
    {
        if (self::$registered) {
            return;
        }

        self::$registered = true;

        Logger::register();

        add_filter('woocommerce_rest_pre_insert_product_object', [self::class, 'preInsert'], 10, 3);
        add_filter('woocommerce_rest_pre_insert_product_variation_object', [self::class, 'preInsert'], 10, 3);
        add_action('woocommerce_rest_insert_product_object', [self::class, 'inserted'], 10, 3);
        add_action('woocommerce_rest_insert_product_variation_object', [self::class, 'inserted'], 10, 3);

        // Per request: the registered write keys may change between tests,
        // and snapshots that never completed are failed saves.
        add_filter('rest_request_before_callbacks', [self::class, 'beforeRequest'], 3, 3);
        add_filter('rest_request_after_callbacks', [self::class, 'afterRequest'], 999, 3);
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function beforeRequest($response, $handler, WP_REST_Request $request)
    {
        self::$writeKeys = null;

        return $response;
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function afterRequest($response, $handler, WP_REST_Request $request)
    {
        if ($request->get_method() !== 'GET' && (Recorder::hasPending() || ListMode::active())) {
            Recorder::abandon($response, $request);
        }

        return $response;
    }

    /**
     * `woocommerce_rest_pre_insert_{product,product_variation}_object`.
     *
     * @param  mixed  $product
     * @return mixed
     */
    public static function preInsert($product, WP_REST_Request $request, bool $creating = false)
    {
        if (! $product instanceof WC_Product || ! ListMode::active()) {
            return $product;
        }

        Recorder::begin($product, $request, $creating);

        if (self::carriesWriteKey($request)) {
            /**
             * Fires before WooCommerce saves a product the app is writing
             * to, when the request carries an extension's write key. Apply
             * the extension's keys to `$product`; WooCommerce saves right
             * after. Throw WC_REST_Exception to reject the save.
             *
             * @param  WC_Product  $product
             * @param  WP_REST_Request  $request
             * @param  bool  $creating
             */
            do_action(self::ACTION_SAVE, $product, $request, $creating);
        }

        return $product;
    }

    /**
     * `woocommerce_rest_insert_{product,product_variation}_object`.
     *
     * @param  mixed  $product
     */
    public static function inserted($product, WP_REST_Request $request, bool $creating = false): void
    {
        if (! $product instanceof WC_Product || ! ListMode::active()) {
            return;
        }

        Recorder::complete($product, $request);
    }

    /**
     * @return array<int, string>
     */
    public static function writeKeys(): array
    {
        if (self::$writeKeys !== null) {
            return self::$writeKeys;
        }

        /**
         * Filters the top-level request keys that fire `wc_products_list/save`
         * in addition to the ones the registered fields declare.
         *
         * @param  array<int, mixed>  $keys
         */
        $extra = apply_filters(self::FILTER_WRITE_KEYS, []);

        $keys = array_merge(Registry::writeKeys(), array_map('strval', array_filter($extra, 'is_scalar')));

        return self::$writeKeys = array_values(array_unique(array_filter($keys, static fn (string $key): bool => $key !== '')));
    }

    public static function resetWriteKeys(): void
    {
        self::$writeKeys = null;
    }

    public static function carriesWriteKey(WP_REST_Request $request): bool
    {
        $keys = self::writeKeys();

        if ($keys === []) {
            return false;
        }

        $body = array_merge($request->get_body_params(), $request->get_json_params() ?: []);

        foreach ($keys as $key) {
            if (array_key_exists($key, $body)) {
                return true;
            }
        }

        return false;
    }
}
