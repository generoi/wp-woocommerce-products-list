<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Controller;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;
use WP_Term;

/**
 * GET /wc-products-list/v1/terms/{taxonomy}: the terms behind the filter
 * and token controls for categories, tags, brands, shipping classes and
 * the `pa_*` attribute taxonomies. wp/v2 has no route for the last two.
 *
 * `search` matches the name (`name__like`), `include` resolves selected ids
 * exactly, and the list is paged (`page`, `per_page` ≤ 100) with
 * `X-WP-Total` / `X-WP-TotalPages`, ordered by name.
 */
class TermsController extends WP_REST_Controller
{
    public const TAXONOMIES = ['product_cat', 'product_tag', 'product_brand', 'product_shipping_class'];

    public const PER_PAGE_MAX = 100;

    protected $namespace = Plugin::REST_NAMESPACE;

    protected $rest_base = 'terms';

    public function register_routes(): void
    {
        register_rest_route($this->namespace, '/'.$this->rest_base.'/(?P<taxonomy>[a-z0-9_-]+)', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => [$this, 'get_items'],
                'permission_callback' => [$this, 'get_items_permissions_check'],
                'args' => $this->get_collection_params(),
            ],
            'schema' => [$this, 'get_public_item_schema'],
        ]);
    }

    /**
     * Whether the Catalog may list a taxonomy: the product ones and every
     * registered attribute taxonomy.
     */
    public static function allows(string $taxonomy): bool
    {
        if (! in_array($taxonomy, self::TAXONOMIES, true) && ! str_starts_with($taxonomy, 'pa_')) {
            return false;
        }

        return taxonomy_exists($taxonomy);
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
            __('Sorry, you are not allowed to list product terms.', 'wp-woocommerce-products-list'),
            ['status' => rest_authorization_required_code()]
        );
    }

    /**
     * @param  WP_REST_Request  $request
     * @return WP_REST_Response|WP_Error
     */
    public function get_items($request)
    {
        $taxonomy = (string) $request['taxonomy'];

        if (! self::allows($taxonomy)) {
            return new WP_Error(
                'wc_products_list_taxonomy_invalid',
                __('Unknown taxonomy.', 'wp-woocommerce-products-list'),
                ['status' => 404]
            );
        }

        $page = max(1, (int) $request['page']);
        $perPage = min(self::PER_PAGE_MAX, max(1, (int) $request['per_page']));
        $include = array_values(array_filter(array_map('intval', (array) ($request['include'] ?? []))));
        $search = trim((string) ($request['search'] ?? ''));

        $args = [
            'taxonomy' => $taxonomy,
            'hide_empty' => false,
            'orderby' => 'name',
            'order' => 'ASC',
            'update_term_meta_cache' => false,
        ];

        if ($include !== []) {
            $args['include'] = $include;
        }

        if ($search !== '') {
            $args['name__like'] = $search;
        }

        $total = wp_count_terms($args);

        if ($total instanceof WP_Error) {
            return $total;
        }

        $total = (int) $total;

        $terms = get_terms($args + [
            'number' => $perPage,
            'offset' => ($page - 1) * $perPage,
        ]);

        if ($terms instanceof WP_Error) {
            return $terms;
        }

        // No `fields` argument, so these are term objects.
        $items = array_map([self::class, 'item'], array_values((array) $terms));

        $totalPages = (int) ceil($total / $perPage);

        $response = rest_ensure_response([
            'items' => $items,
            'total' => $total,
            'totalPages' => $totalPages,
        ]);
        $response->header('X-WP-Total', (string) $total);
        $response->header('X-WP-TotalPages', (string) $totalPages);

        return $response;
    }

    /**
     * @return array{id: int, name: string, slug: string, parent: int, count: int}
     */
    public static function item(WP_Term $term): array
    {
        return [
            'id' => (int) $term->term_id,
            'name' => (string) $term->name,
            'slug' => (string) $term->slug,
            'parent' => (int) $term->parent,
            'count' => (int) $term->count,
        ];
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    public function get_collection_params()
    {
        return [
            'search' => [
                'description' => 'Limit results to terms whose name contains this string.',
                'type' => 'string',
                'default' => '',
                'sanitize_callback' => 'sanitize_text_field',
            ],
            'include' => [
                'description' => 'Return exactly these term ids.',
                'type' => 'array',
                'items' => ['type' => 'integer'],
                'default' => [],
                'sanitize_callback' => 'wp_parse_id_list',
            ],
            'page' => [
                'description' => 'Current page of the collection.',
                'type' => 'integer',
                'default' => 1,
                'minimum' => 1,
                'sanitize_callback' => 'absint',
                'validate_callback' => 'rest_validate_request_arg',
            ],
            'per_page' => [
                'description' => 'Maximum number of items to be returned in result set.',
                'type' => 'integer',
                'default' => 50,
                'minimum' => 1,
                'maximum' => self::PER_PAGE_MAX,
                'sanitize_callback' => 'absint',
                'validate_callback' => 'rest_validate_request_arg',
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function get_item_schema()
    {
        return $this->add_additional_fields_schema([
            '$schema' => 'http://json-schema.org/draft-04/schema#',
            'title' => 'wc_products_list_terms',
            'type' => 'object',
            'properties' => [
                'items' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'id' => ['type' => 'integer'],
                            'name' => ['type' => 'string'],
                            'slug' => ['type' => 'string'],
                            'parent' => ['type' => 'integer'],
                            'count' => ['type' => 'integer'],
                        ],
                    ],
                ],
                'total' => ['type' => 'integer'],
                'totalPages' => ['type' => 'integer'],
            ],
        ]);
    }
}
