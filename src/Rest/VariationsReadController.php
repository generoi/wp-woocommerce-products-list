<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * GET /wc-products-list/v1/variations: the variations of many parents in
 * one request, the read twin of `variations/batch`.
 *
 * wc/v3 reads variations per parent (`products/{id}/variations`), so
 * expanding a page of variable products or opening bulk edit over it was
 * one request per parent. Here either
 *
 * - `include=1,2,3` (≤ 100 ids): those variations, whatever their parents;
 * - `parent=1,2,3` (≤ 100 ids): every variation of those parents, grouped
 *   by parent in the order given, each parent's in menu order then id,
 *   paged (`per_page` ≤ 100, `X-WP-Total`, `X-WP-TotalPages`).
 *
 * The rows come from WooCommerce's own cross-parent collection
 * (`/wc/v3/variations`), dispatched from inside this request in list mode,
 * so permissions, the row enrichment, the integrations' row filters and
 * `_fields` are exactly those of a per-parent read.
 */
final class VariationsReadController
{
    public const LIMIT = 100;

    public function register(): void
    {
        $ids = static fn (string $description): array => [
            'type' => 'array',
            'items' => ['type' => 'integer', 'minimum' => 1],
            'maxItems' => self::LIMIT,
            'description' => $description,
        ];

        register_rest_route(Plugin::REST_NAMESPACE, '/variations', [
            'methods' => 'GET',
            'callback' => [$this, 'handle'],
            'permission_callback' => [$this, 'permission'],
            'args' => [
                'include' => $ids('These variations, whatever their parents.'),
                'parent' => $ids('Every variation of these parents, grouped by parent in this order.'),
                'per_page' => ['type' => 'integer', 'default' => self::LIMIT, 'minimum' => 1, 'maximum' => self::LIMIT],
                'page' => ['type' => 'integer', 'default' => 1, 'minimum' => 1],
            ],
        ]);
    }

    public function permission(): bool|WP_Error
    {
        if (! current_user_can(Plugin::capability()) || ! wc_rest_check_post_permissions('product_variation', 'read')) {
            return new WP_Error('rest_forbidden', __('Sorry, you are not allowed to do that.', 'wp-woocommerce-products-list'), ['status' => rest_authorization_required_code()]);
        }

        return true;
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $include = self::ids($request->get_param('include'));
        $parents = self::ids($request->get_param('parent'));

        if (($include === []) === ($parents === [])) {
            return new WP_Error('rest_invalid_param', __('Pass either include or parent.', 'wp-woocommerce-products-list'), ['status' => 400]);
        }

        $query = [
            'per_page' => (int) $request->get_param('per_page'),
            'page' => (int) $request->get_param('page'),
        ];

        if ($include !== []) {
            $query['include'] = $include;
        } else {
            $query['parent'] = $parents;
        }

        $fields = $request->get_param('_fields');

        if (is_string($fields) && trim($fields) !== '') {
            // The integrations' row filters and the enrichment read the
            // nested request's `_fields`; core trims this response to the
            // outer one's when it is served.
            $query['_fields'] = $fields;
        }

        $nested = new WP_REST_Request('GET', '/wc/v3/variations');
        $nested->set_header(ListMode::HEADER, '1');
        $nested->set_query_params($query);

        $response = rest_do_request($nested);

        if ($response->is_error()) {
            return $response->as_error();
        }

        $data = $response->get_data();
        $headers = $response->get_headers();
        $out = rest_ensure_response(is_array($data) ? array_values($data) : []);

        foreach (['X-WP-Total', 'X-WP-TotalPages'] as $header) {
            if (isset($headers[$header])) {
                $out->header($header, (string) $headers[$header]);
            }
        }

        return $out;
    }

    /**
     * @return array<int, int>
     */
    private static function ids(mixed $value): array
    {
        if (is_string($value)) {
            $value = explode(',', $value);
        }

        return is_array($value) ? array_values(array_unique(array_filter(array_map('intval', $value), static fn (int $id): bool => $id > 0))) : [];
    }
}
