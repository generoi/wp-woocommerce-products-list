<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * POST /wc-products-list/v1/variations/batch {update: [{id, ...}]}: one
 * write of up to 100 variations of any number of parents.
 *
 * wc/v3 writes variations per parent (`products/{id}/variations/batch`),
 * so a scheduled sale across a page of variable products is one request
 * per product. Here the rows are grouped by their actual parent and each
 * group is dispatched to that wc/v3 route from inside this request, with
 * this request's headers (list mode, batch id, source) and `fields`: the
 * same permission check (`edit_others_products`, as for every batch),
 * the same validation, save hooks, logging and row trimming as a direct
 * call, in one round trip. The response is wc/v3's `{update: [...]}`
 * with the items in request order; an id that is not a variation gets an
 * `error` entry like any rejected item.
 */
final class VariationsBatchController
{
    public const LIMIT = 100;

    public function register(): void
    {
        register_rest_route(Plugin::REST_NAMESPACE, '/variations/batch', [
            'methods' => 'POST',
            'callback' => [$this, 'handle'],
            'permission_callback' => [$this, 'permission'],
            'args' => [
                'update' => ['type' => 'array', 'required' => true, 'items' => ['type' => 'object']],
                // `fields`, not `_fields`: as for the wc/v3 batch routes in
                // list mode, each item row is trimmed to it, `id` kept.
                'fields' => ['type' => 'string', 'description' => 'Comma-separated wc/v3 fields of the returned rows.'],
            ],
        ]);
    }

    public function permission(): bool|WP_Error
    {
        if (! current_user_can(Plugin::capability())) {
            return new WP_Error('rest_forbidden', __('Sorry, you are not allowed to do that.', 'wp-woocommerce-products-list'), ['status' => rest_authorization_required_code()]);
        }

        // Exactly what wc/v3 asks of a batch write.
        if (! wc_rest_check_post_permissions('product_variation', 'batch')) {
            return new WP_Error('woocommerce_rest_cannot_batch', __('Sorry, you are not allowed to batch manipulate this resource.', 'woocommerce'), ['status' => rest_authorization_required_code()]);
        }

        return true;
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $items = $request->get_param('update');
        $items = is_array($items) ? array_values($items) : [];

        if ($items === []) {
            return new WP_Error('wc_products_list_no_ids', __('No items given.', 'wp-woocommerce-products-list'), ['status' => 400]);
        }

        /** This filter is documented in WooCommerce. */
        $limit = (int) apply_filters('woocommerce_rest_batch_items_limit', self::LIMIT, 'variations');

        if (count($items) > $limit) {
            return new WP_Error('woocommerce_rest_request_entity_too_large', sprintf(
                /* translators: %s: amount of objects */
                __('Unable to accept more than %s items for this request.', 'woocommerce'),
                $limit
            ), ['status' => 413]);
        }

        $results = [];
        $byParent = [];

        foreach ($items as $index => $item) {
            $id = is_array($item) ? (int) ($item['id'] ?? 0) : 0;
            $post = $id > 0 ? get_post($id) : null;

            if ($post === null || $post->post_type !== 'product_variation' || (int) $post->post_parent <= 0) {
                $results[$index] = [
                    'id' => $id,
                    'error' => ['code' => 'woocommerce_rest_product_variation_invalid_id', 'message' => __('Invalid variation ID.', 'wp-woocommerce-products-list'), 'data' => ['status' => 404]],
                ];

                continue;
            }

            // Addressing comes from the route; a stale `parent_id` in the body is dropped.
            unset($item['product_id'], $item['parent_id']);
            $item['id'] = $id;

            $byParent[(int) $post->post_parent][$index] = $item;
        }

        $fields = $request->get_param('fields');
        $source = $request->get_header(Logger::SOURCE_HEADER);

        foreach ($byParent as $parent => $group) {
            $nested = new WP_REST_Request('POST', '/wc/v3/products/'.$parent.'/variations/batch');
            $nested->set_header(ListMode::HEADER, '1');
            $nested->set_header(ListMode::BATCH_HEADER, Logger::batchId());

            if (is_string($source) && $source !== '') {
                $nested->set_header(Logger::SOURCE_HEADER, $source);
            }

            $nested->set_body_params(['update' => array_values($group)]);

            if (is_string($fields) && trim($fields) !== '') {
                $nested->set_query_params(['fields' => $fields]);
            }

            $response = rest_do_request($nested);

            // WooCommerce defers the parent's sync (`_price`, the price
            // range, the lookup row) to the end of the PHP process; a
            // request killed later would leave every parent of the
            // request unsynced. Run the queued syncs now, per group, with
            // WooCommerce's own runner (it drains the queue, so nothing
            // is synced twice): a killed request leaves at most the
            // parent it was writing, which its batch marker repairs.
            if (class_exists(\WC_Post_Data::class)) {
                \WC_Post_Data::do_deferred_product_sync();
            }

            $data = $response->get_data();
            $indexes = array_keys($group);

            if ($response->is_error() || ! is_array($data)) {
                $error = $response->as_error();

                foreach ($group as $index => $item) {
                    $results[$index] = [
                        'id' => (int) $item['id'],
                        'error' => [
                            'code' => $error ? (string) $error->get_error_code() : 'error',
                            'message' => $error ? $error->get_error_message() : __('The request failed.', 'wp-woocommerce-products-list'),
                            'data' => ['status' => $response->get_status()],
                        ],
                    ];
                }

                continue;
            }

            foreach (array_values((array) ($data['update'] ?? [])) as $position => $row) {
                $index = $indexes[$position] ?? null;

                if ($index !== null && is_array($row)) {
                    $results[$index] = $row;
                }
            }
        }

        ksort($results);

        return rest_ensure_response(['update' => array_values($results)]);
    }
}
