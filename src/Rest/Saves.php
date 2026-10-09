<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Plugin;
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

        // After the route's permission_callback: `rest_request_before_callbacks`
        // runs before it, so per-id work there would be done for anyone.
        add_filter('rest_dispatch_request', [self::class, 'beforeDispatch'], 3, 4);
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function beforeRequest($response, $handler, WP_REST_Request $request)
    {
        self::$writeKeys = null;

        if (! ListMode::nested()) {
            Recorder::forgetLoggedErrors();
        }

        return $response;
    }

    /**
     * `rest_dispatch_request`: WordPress applies it only once the route's
     * permission_callback has passed, right before the callback runs, so
     * the batch priming and the transient deferral never do work for a
     * request that is going to be refused.
     *
     * @param  mixed  $result
     * @param  mixed  $route
     * @param  mixed  $handler
     * @return mixed
     */
    public static function beforeDispatch($result, WP_REST_Request $request, $route = null, $handler = null)
    {
        if ($request->get_method() !== 'GET') {
            // The route's permission check passed: from here on, what the
            // request does is a save attempt that may be logged.
            self::$dispatched[spl_object_id($request)] = true;
        }

        if ($result !== null || $request->get_method() === 'GET' || ! ListMode::active()) {
            return $result;
        }

        if (! current_user_can(Plugin::capability())) {
            return $result;
        }

        self::primeBatch($request);
        self::deferTransients($request);

        return $result;
    }

    /** @var array<int, true> write requests (spl_object_id) that passed their permission check */
    private static array $dispatched = [];

    /** @var array<int, true> requests (spl_object_id) whose transient deletions are deferred */
    private static array $deferring = [];

    /**
     * WooCommerce deletes nine product transients on every save of a
     * product, five times per save (two queries each, most of them for
     * transients that do not exist): about fifty queries per item of a
     * products batch. Its variations batch coalesces them into one
     * deletion at the end of the request (`ProductTransientsDeferrer`);
     * a list-mode products batch gets the same.
     */
    private static function deferTransients(WP_REST_Request $request): void
    {
        $deferrer = self::transientsDeferrer();

        if ($deferrer === null || ! preg_match('#^/wc/v3/products/batch$#', $request->get_route())) {
            return;
        }

        $deferrer->start_deferring();
        self::$deferring[spl_object_id($request)] = true;
    }

    private static function stopDeferringTransients(WP_REST_Request $request): void
    {
        $key = spl_object_id($request);

        if (! isset(self::$deferring[$key])) {
            return;
        }

        unset(self::$deferring[$key]);
        self::transientsDeferrer()?->stop_deferring();
    }

    /**
     * WooCommerce's deferrer (internal API, WooCommerce 10.x+); null when
     * the installed version has none, and the saves delete as they go.
     */
    private static function transientsDeferrer(): ?object
    {
        $deferrer = self::fromContainer('Automattic\\WooCommerce\\Internal\\Caches\\ProductTransientsDeferrer');

        return $deferrer !== null && method_exists($deferrer, 'start_deferring') && method_exists($deferrer, 'stop_deferring') ? $deferrer : null;
    }

    /**
     * A service of WooCommerce's container by class name, null when the
     * class or the container is missing. By name: the internal classes
     * looked up here are not in the WooCommerce stubs.
     */
    private static function fromContainer(string $class): ?object
    {
        if (! class_exists($class) || ! function_exists('wc_get_container')) {
            return null;
        }

        try {
            return wc_get_container()->get($class);
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * A list-mode batch write loads every item twice before saving it (the
     * recorder's snapshot and WooCommerce's own object), each load a post,
     * a meta and a raw meta query of its own. Warm all three caches for
     * the batch's items in three queries; WooCommerce invalidates each
     * object's caches when it saves it, so nothing stale is read.
     */
    public static function primeBatch(WP_REST_Request $request): void
    {
        if (! str_ends_with($request->get_route(), '/batch')) {
            return;
        }

        $body = array_merge($request->get_body_params(), $request->get_json_params() ?: []);
        $ids = [];

        $limit = self::batchLimit($request);

        foreach (is_array($body['update'] ?? null) ? $body['update'] : [] as $item) {
            if (is_array($item) && isset($item['id']) && (int) $item['id'] > 0) {
                $ids[] = (int) $item['id'];
            }

            if (count($ids) >= $limit) {
                break;
            }
        }

        if ($ids === []) {
            return;
        }

        _prime_post_caches($ids, true, true);
        Rows::primeRawMetaOf($ids);
    }

    /**
     * WooCommerce's batch limit for the route's resource: a larger batch
     * is refused by the callback, so priming more than this is waste.
     */
    public static function batchLimit(WP_REST_Request $request): int
    {
        $base = str_contains($request->get_route(), 'variations') ? 'variations' : 'products';

        return max(1, (int) apply_filters('woocommerce_rest_batch_items_limit', VariationsBatchController::LIMIT, $base));
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function afterRequest($response, $handler, WP_REST_Request $request)
    {
        self::stopDeferringTransients($request);

        if ($request->get_method() !== 'GET' && ListMode::active()) {
            $response = self::nameSkuOwners($response, $request);
        }

        $key = spl_object_id($request);
        $dispatched = isset(self::$dispatched[$key]);
        unset(self::$dispatched[$key]);

        if ($request->get_method() !== 'GET' && (Recorder::hasPending() || ListMode::active())) {
            if ($dispatched && self::mayLog()) {
                Recorder::abandon($response, $request);
            } else {
                // Refused before its callback ran (not logged in, no
                // capability, the route's permission check, invalid
                // params): nothing was attempted, nothing is logged.
                Recorder::discard();
            }
        }

        return $response;
    }

    /**
     * Whether the current user's failed writes are logged: a logged-in
     * user with the list capability. Anyone else is refused, and a
     * refusal is not a change.
     */
    public static function mayLog(): bool
    {
        return get_current_user_id() > 0 && current_user_can(Plugin::capability());
    }

    /** WooCommerce's code for a SKU that is malformed or already taken. */
    public const SKU_ERROR = 'product_invalid_sku';

    /**
     * WooCommerce rejects a taken SKU with "Invalid or duplicated SKU."
     * and no word on who has it. In list mode the message names the
     * product that owns the SKU, in the response and so in the log row.
     *
     * @param  mixed  $response  a WP_Error, a WP_REST_Response or a batch handler's plain array
     * @return mixed
     */
    public static function nameSkuOwners($response, WP_REST_Request $request)
    {
        $body = array_merge($request->get_body_params(), $request->get_json_params() ?: []);

        if (is_wp_error($response)) {
            if ($response->get_error_code() === self::SKU_ERROR) {
                $message = self::skuOwnerMessage($body['sku'] ?? null, (int) ($request['id'] ?? 0));

                if ($message !== null) {
                    return new \WP_Error(self::SKU_ERROR, $message, $response->get_error_data());
                }
            }

            return $response;
        }

        $isResponse = $response instanceof \WP_REST_Response;
        $data = $isResponse ? $response->get_data() : $response;

        if (! is_array($data) || ! is_array($data['update'] ?? null) || ! is_array($body['update'] ?? null)) {
            return $response;
        }

        $skus = [];

        foreach ($body['update'] as $item) {
            if (is_array($item) && isset($item['id'])) {
                $skus[(int) $item['id']] = $item['sku'] ?? null;
            }
        }

        $changed = false;

        foreach ($data['update'] as $index => $item) {
            if (! is_array($item) || ($item['error']['code'] ?? null) !== self::SKU_ERROR) {
                continue;
            }

            $id = (int) ($item['id'] ?? 0);
            $message = self::skuOwnerMessage($skus[$id] ?? null, $id);

            if ($message !== null) {
                $data['update'][$index]['error']['message'] = $message;
                $changed = true;
            }
        }

        if (! $changed) {
            return $response;
        }

        if ($isResponse) {
            $response->set_data($data);

            return $response;
        }

        return $data;
    }

    /**
     * "SKU "X" is already used by "Name" (#123)." or null when no other
     * product has the SKU (it was rejected for its form, not as a duplicate).
     */
    public static function skuOwnerMessage(mixed $sku, int $id): ?string
    {
        if (! is_scalar($sku) || trim((string) $sku) === '') {
            return null;
        }

        $sku = trim((string) $sku);
        $owner = (int) wc_get_product_id_by_sku($sku);

        if ($owner <= 0 || $owner === $id) {
            return null;
        }

        $product = wc_get_product($owner);
        $name = $product instanceof WC_Product ? $product->get_name() : '';

        return sprintf(
            /* translators: 1: SKU, 2: product name, 3: product id */
            __('The SKU "%1$s" is already used by "%2$s" (#%3$d).', 'wp-woocommerce-products-list'),
            $sku,
            $name,
            $owner
        );
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

        self::forwardFields($request);
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
     * A batch sub-request gets the batch's `fields` as its own `_fields`.
     *
     * WooCommerce serialises every item it wrote in full (the product
     * controller skips what `_fields` leaves out, but a sub-request has no
     * `_fields` of its own: the batch request's `fields` is only applied
     * afterwards by `Rows::trimBatchItem()`), so a status change on a
     * variable product still computes its price range, which reads every
     * variation. With `_fields` on the sub-request the controller builds
     * only what the app asked for, and the response is the same rows the
     * trim would have left. The variations controller ignores `_fields`
     * for its own keys; the integrations' row filters still honour it.
     */
    private static function forwardFields(WP_REST_Request $request): void
    {
        $outer = ListMode::request();

        if ($outer === null || $outer === $request || $outer->get_method() === 'GET') {
            return;
        }

        $fields = $outer->get_param('fields');
        $own = $request->get_param('_fields');

        if (! is_string($fields) || trim($fields) === '' || (is_string($own) && trim($own) !== '')) {
            return;
        }

        $request->set_query_params($request->get_query_params() + ['_fields' => $fields.',id']);
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
