<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * One row action behind POST /wc-products-list/v1/actions/{id}. Register
 * instances with the `wc_products_list/action_handlers` filter, keyed by
 * id; the declarative definition the UI renders goes through
 * `wc_products_list/actions`.
 *
 * `run()` is called once per id, after `can()` passed, and returns the data
 * of the result row. A `changes` key (`field => [old, new]`) in it is logged
 * as one row per field; anything else (`new_id`, ...) is passed to the app.
 */
interface Action
{
    public function id(): string;

    /**
     * @param  array<string, mixed>  $args  the sanitized args of the request
     * @return array<string, mixed>|WP_Error data for the result row
     */
    public function run(WC_Product $product, array $args, WP_REST_Request $request): array|WP_Error;

    /** Per-id capability check. */
    public function can(WC_Product $product): bool;

    /** 'product' | 'variation' | 'both' */
    public function appliesTo(): string;

    /**
     * Once per request, before any id runs.
     *
     * @param  array<string, mixed>  $args
     * @return array<string, mixed>|WP_Error
     */
    public function sanitizeArgs(array $args): array|WP_Error;
}
