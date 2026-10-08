<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Controller;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/**
 * GET /wc-products-list/v1/counts: the numbers on the status tabs, from
 * `wp_count_posts('product')` (cached by WordPress; one grouped query when
 * cold). `all` is everything but the trash.
 */
class CountsController extends WP_REST_Controller
{
    public const FILTER_COUNTS = 'wc_products_list/counts';

    public const STATUSES = ['publish', 'future', 'draft', 'pending', 'private', 'trash'];

    protected $namespace = Plugin::REST_NAMESPACE;

    protected $rest_base = 'counts';

    public function register_routes(): void
    {
        register_rest_route($this->namespace, '/'.$this->rest_base, [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [$this, 'get_items'],
                'permission_callback' => [$this, 'get_items_permissions_check'],
                'args' => [],
            ],
            'schema' => [$this, 'get_public_item_schema'],
        ]);
    }

    /**
     * @param  WP_REST_Request  $request
     * @return bool|WP_Error
     */
    public function get_items_permissions_check($request)
    {
        if (current_user_can(Plugin::capability())) {
            return true;
        }

        return new WP_Error(
            'wc_products_list_forbidden',
            __('Sorry, you are not allowed to view the product counts.', 'wp-woocommerce-products-list'),
            ['status' => rest_authorization_required_code()]
        );
    }

    /**
     * @param  WP_REST_Request  $request
     * @return WP_REST_Response
     */
    public function get_items($request)
    {
        return rest_ensure_response(self::counts());
    }

    /**
     * @return array<string, int>
     */
    public static function counts(): array
    {
        // 'readable': private products of other authors are counted only for
        // users who may read them, as the list itself shows them.
        $raw = (array) wp_count_posts('product', 'readable');
        $counts = ['all' => 0];

        foreach (self::STATUSES as $status) {
            $counts[$status] = (int) ($raw[$status] ?? 0);

            if ($status !== 'trash') {
                $counts['all'] += $counts[$status];
            }
        }

        /**
         * Filters the status counts shown on the Catalog tabs.
         *
         * @param  array<string, int>  $counts  `all` and one key per status
         */
        $counts = apply_filters(self::FILTER_COUNTS, $counts);

        return array_map('intval', $counts);
    }

    /**
     * @return array<string, mixed>
     */
    public function get_item_schema()
    {
        $properties = ['all' => ['type' => 'integer', 'description' => 'Every status but trash.']];

        foreach (self::STATUSES as $status) {
            $properties[$status] = ['type' => 'integer'];
        }

        return $this->add_additional_fields_schema([
            '$schema' => 'http://json-schema.org/draft-04/schema#',
            'title' => 'wc_products_list_counts',
            'type' => 'object',
            'properties' => $properties,
        ]);
    }
}
