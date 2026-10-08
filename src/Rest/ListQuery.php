<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use WP_Query;
use WP_REST_Request;

/**
 * The extra list parameters of `GET /wc/v3/products` and
 * `GET /wc/v3/products/{id}/variations`, mapped onto the WP_Query WooCommerce
 * runs. Only in list mode; every other wc/v3 consumer sees the stock query.
 *
 * Products: `tab`, `brand`, `exclude_category`, `exclude_tag`,
 * `min_stock_quantity`, `max_stock_quantity`, `has_variations`, and
 * `orderby=sku|stock_quantity|menu_order`. Stock and SKU live in
 * `wc_product_meta_lookup`, so those are one LEFT JOIN on the primary key
 * rather than a meta query. The join and the WHERE/ORDER BY pieces are added
 * on `posts_clauses`, keyed by a query var that only this class sets.
 *
 * Search: wc/v3's `search_name_or_sku` lists matching variations as rows of
 * their own next to the products. The list is parents-only (variations are
 * expanded under them), so in list mode the search is the plugin's: a
 * product matches when its name or SKU matches, or when one of its
 * variations' SKU does. One EXISTS on the variation's lookup row.
 *
 * Variations: ordered `menu_order, id` unless the request orders otherwise.
 *
 * Both queries end with a filter for integrations (`product_query_args`,
 * `variation_query_args`), after the plugin's own mapping.
 */
final class ListQuery
{
    public const FILTER_PRODUCT_ARGS = 'wc_products_list/product_query_args';

    public const FILTER_VARIATION_ARGS = 'wc_products_list/variation_query_args';

    /** The WP_Query var carrying the clauses `posts_clauses` has to add. */
    public const QUERY_VAR = 'wc_products_list';

    public const TABS = ['all', 'publish', 'future', 'draft', 'pending', 'private', 'trash'];

    /** What the `all` tab shows: everything but the trash. */
    public const ALL_STATUSES = ['publish', 'future', 'draft', 'pending', 'private'];

    /** Orderings the plugin adds to wc/v3's own (`id, title, date, modified, price, ...`). */
    public const ORDERBY = ['sku', 'stock_quantity', 'menu_order'];

    private const LOOKUP_ALIAS = 'wc_product_meta_lookup';

    public function register(): void
    {
        add_filter('woocommerce_rest_product_object_query', [$this, 'productArgs'], 10, 2);
        add_filter('woocommerce_rest_product_variation_object_query', [$this, 'variationArgs'], 10, 2);
        add_filter('woocommerce_rest_query_vars', [$this, 'allowQueryVar']);
        add_filter('posts_clauses', [$this, 'clauses'], 10, 2);
        add_filter('rest_endpoints', [$this, 'endpoints']);
    }

    /**
     * Turn the list parameters of the request into query vars. Pure, so the
     * unit suite covers the mapping; `productArgs()` is the WordPress glue.
     *
     * @param  array<string, mixed>  $params  the request parameters
     * @return array{
     *     statuses: ?array<int, string>,
     *     brand: array<int, int>,
     *     exclude_category: array<int, int>,
     *     exclude_tag: array<int, int>,
     *     min_stock: ?float,
     *     max_stock: ?float,
     *     has_variations: ?bool,
     *     orderby: ?string,
     *     search: array<int, string>
     * }
     */
    public static function vars(array $params): array
    {
        $tab = isset($params['tab']) && is_string($params['tab']) ? $params['tab'] : null;
        $orderby = isset($params['orderby']) && is_string($params['orderby']) ? strtolower($params['orderby']) : null;
        $search = isset($params['search_name_or_sku']) && is_string($params['search_name_or_sku']) ? $params['search_name_or_sku'] : '';

        return [
            'statuses' => $tab !== null ? self::statusesForTab($tab) : null,
            'brand' => self::ids($params['brand'] ?? null),
            'exclude_category' => self::ids($params['exclude_category'] ?? null),
            'exclude_tag' => self::ids($params['exclude_tag'] ?? null),
            'min_stock' => self::number($params['min_stock_quantity'] ?? null),
            'max_stock' => self::number($params['max_stock_quantity'] ?? null),
            'has_variations' => self::bool($params['has_variations'] ?? null),
            'orderby' => $orderby !== null && in_array($orderby, self::ORDERBY, true) ? $orderby : null,
            'search' => array_values(array_filter(array_map('trim', explode(' ', $search)), static fn (string $token): bool => $token !== '')),
        ];
    }

    /**
     * @return array<int, string>|null null for an unknown tab
     */
    public static function statusesForTab(string $tab): ?array
    {
        if ($tab === 'all') {
            return self::ALL_STATUSES;
        }

        return in_array($tab, self::TABS, true) ? [$tab] : null;
    }

    /**
     * `woocommerce_rest_product_object_query`: runs inside WooCommerce's
     * `prepare_objects_query()` before it reads `include_status`, builds the
     * tax query and resolves the ordering, so status goes through the
     * request and the rest through `$args`.
     *
     * @param  array<string, mixed>  $args
     * @return array<string, mixed>
     */
    public function productArgs(array $args, WP_REST_Request $request): array
    {
        if (! ListMode::active()) {
            return $args;
        }

        $vars = self::vars($request->get_params());

        if ($vars['statuses'] !== null) {
            // WooCommerce overwrites $args['post_status'] with the request's
            // status right after this filter; include_status wins over it.
            $request->set_param('include_status', $vars['statuses']);
        }

        if ($vars['brand'] !== [] && taxonomy_exists('product_brand')) {
            $args['tax_query'][] = [
                'taxonomy' => 'product_brand',
                'field' => 'term_id',
                'terms' => $vars['brand'],
            ];
        }

        foreach (['exclude_category' => 'product_cat', 'exclude_tag' => 'product_tag'] as $param => $taxonomy) {
            if ($vars[$param] !== []) {
                $args['tax_query'][] = [
                    'taxonomy' => $taxonomy,
                    'field' => 'term_id',
                    'terms' => $vars[$param],
                    'operator' => 'NOT IN',
                ];
            }
        }

        if ($vars['search'] !== []) {
            // Blank the parameter before WooCommerce reads it (right after
            // this filter), so it neither widens post_type to variations nor
            // adds its own clauses; `clauses()` runs the search instead.
            $request->set_param('search_name_or_sku', '');
        }

        $clauses = array_filter([
            'min_stock' => $vars['min_stock'],
            'max_stock' => $vars['max_stock'],
            'has_variations' => $vars['has_variations'],
            // menu_order is native to WP_Query (WooCommerce maps it to
            // `menu_order title`); sku and stock_quantity need the lookup table.
            'orderby' => in_array($vars['orderby'], ['sku', 'stock_quantity'], true) ? $vars['orderby'] : null,
            'search' => $vars['search'] !== [] ? $vars['search'] : null,
        ], static fn ($value): bool => $value !== null);

        if ($clauses !== []) {
            $args[self::QUERY_VAR] = $clauses;
        }

        /**
         * Filters the WP_Query arguments of a product list request from the
         * Catalog app, after the plugin's own parameters are mapped.
         *
         * @param  array<string, mixed>  $args
         * @param  WP_REST_Request  $request
         */
        return apply_filters(self::FILTER_PRODUCT_ARGS, $args, $request);
    }

    /**
     * `woocommerce_rest_product_variation_object_query`.
     *
     * @param  array<string, mixed>  $args
     * @return array<string, mixed>
     */
    public function variationArgs(array $args, WP_REST_Request $request): array
    {
        if (! ListMode::active()) {
            return $args;
        }

        $explicit = $request->get_query_params()['orderby'] ?? $request->get_body_params()['orderby'] ?? null;

        if ($explicit === null || $explicit === '') {
            // The order the product editor shows them in, and the one
            // WooCommerce itself reads the children in.
            $args['orderby'] = ['menu_order' => 'ASC', 'ID' => 'ASC'];
            $args['order'] = 'ASC';
        }

        /**
         * Filters the WP_Query arguments of a variations request from the
         * Catalog app.
         *
         * @param  array<string, mixed>  $args
         * @param  WP_REST_Request  $request
         */
        return apply_filters(self::FILTER_VARIATION_ARGS, $args, $request);
    }

    /**
     * WooCommerce whitelists the query vars it passes to WP_Query; the one
     * carrying our clauses has to be on the list.
     *
     * @param  array<int, string>  $vars
     * @return array<int, string>
     */
    public function allowQueryVar(array $vars): array
    {
        if (ListMode::active()) {
            $vars[] = self::QUERY_VAR;
        }

        return $vars;
    }

    /**
     * `posts_clauses`: the lookup-table join, the stock range, the
     * has-variations test and the SKU / stock ordering. Keyed by the query
     * var so that no other query on the request (WooCommerce reads a
     * variable product's children with its own WP_Query) is touched.
     *
     * @param  array<string, string>  $clauses
     * @return array<string, string>
     */
    public function clauses(array $clauses, WP_Query $query): array
    {
        $vars = $query->get(self::QUERY_VAR);

        if (! is_array($vars) || $vars === []) {
            return $clauses;
        }

        global $wpdb;

        $posts = $wpdb->posts;
        $alias = self::LOOKUP_ALIAS;
        $orderby = $vars['orderby'] ?? null;
        $search = is_array($vars['search'] ?? null) ? $vars['search'] : [];
        $sku = $search !== [] && wc_product_sku_enabled();

        if (isset($vars['min_stock']) || isset($vars['max_stock']) || $orderby !== null || $sku) {
            // WooCommerce joins the same table under the same alias for a
            // SKU search (posts_join runs before posts_clauses).
            if (! str_contains($clauses['join'], $alias)) {
                $clauses['join'] .= " LEFT JOIN {$wpdb->wc_product_meta_lookup} {$alias} ON {$posts}.ID = {$alias}.product_id ";
            }
        }

        if (isset($vars['min_stock'])) {
            $clauses['where'] .= $wpdb->prepare(" AND {$alias}.stock_quantity >= %f", (float) $vars['min_stock']);
        }

        if (isset($vars['max_stock'])) {
            $clauses['where'] .= $wpdb->prepare(" AND {$alias}.stock_quantity <= %f", (float) $vars['max_stock']);
        }

        foreach ($search as $token) {
            $like = '%'.$wpdb->esc_like((string) $token).'%';
            $parts = [$wpdb->prepare("{$posts}.post_title LIKE %s", $like)];

            if ($sku) {
                $parts[] = $wpdb->prepare("{$alias}.sku LIKE %s", $like);
                // A variation's SKU finds its parent. Variation titles are
                // the parent's title plus attributes, so names need no subquery.
                $parts[] = $wpdb->prepare(
                    "EXISTS (SELECT 1 FROM {$posts} wc_products_list_child"
                    ." INNER JOIN {$wpdb->wc_product_meta_lookup} wc_products_list_child_lookup ON wc_products_list_child_lookup.product_id = wc_products_list_child.ID"
                    ." WHERE wc_products_list_child.post_parent = {$posts}.ID"
                    ." AND wc_products_list_child.post_type = 'product_variation'"
                    .' AND wc_products_list_child_lookup.sku LIKE %s)',
                    $like
                );
            }

            $clauses['where'] .= ' AND ('.implode(' OR ', $parts).')';
        }

        if (isset($vars['has_variations'])) {
            $exists = "EXISTS (SELECT 1 FROM {$posts} wc_products_list_variation"
                ." WHERE wc_products_list_variation.post_parent = {$posts}.ID"
                ." AND wc_products_list_variation.post_type = 'product_variation'"
                ." AND wc_products_list_variation.post_status IN ('publish', 'private'))";

            $clauses['where'] .= $vars['has_variations'] ? " AND {$exists}" : " AND NOT {$exists}";
        }

        if ($orderby !== null) {
            $order = strtoupper((string) $query->get('order')) === 'DESC' ? 'DESC' : 'ASC';
            $column = $orderby === 'sku' ? "{$alias}.sku" : "{$alias}.stock_quantity";

            $clauses['orderby'] = "{$column} {$order}, {$posts}.ID {$order}";
        }

        return $clauses;
    }

    /**
     * Declare the list parameters on the wc/v3 routes so they are validated
     * and documented like the stock ones, and widen `orderby` to the values
     * `posts_clauses` knows. Unknown enum values would otherwise be rejected
     * before any callback runs.
     *
     * @param  array<string, array<int|string, mixed>>  $endpoints
     * @return array<string, array<int|string, mixed>>
     */
    public function endpoints(array $endpoints): array
    {
        if (isset($endpoints['/wc/v3/products'])) {
            $endpoints['/wc/v3/products'] = $this->extendCollection($endpoints['/wc/v3/products'], self::ORDERBY, self::params());
        }

        $variations = '/wc/v3/products/(?P<product_id>[\d]+)/variations';

        if (isset($endpoints[$variations])) {
            $endpoints[$variations] = $this->extendCollection($endpoints[$variations], ['menu_order'], []);
        }

        return $endpoints;
    }

    /**
     * The schema of the list parameters.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function params(): array
    {
        return [
            'tab' => [
                'description' => 'Status tab: `all` is every status but trash.',
                'type' => 'string',
                'enum' => self::TABS,
                'sanitize_callback' => 'sanitize_key',
                'validate_callback' => 'rest_validate_request_arg',
            ],
            'brand' => [
                'description' => 'Limit result set to products assigned to these brand term ids.',
                'type' => 'array',
                'items' => ['type' => 'integer'],
                'sanitize_callback' => 'wp_parse_id_list',
            ],
            'exclude_category' => [
                'description' => 'Exclude products in these category term ids.',
                'type' => 'array',
                'items' => ['type' => 'integer'],
                'sanitize_callback' => 'wp_parse_id_list',
            ],
            'exclude_tag' => [
                'description' => 'Exclude products with these tag term ids.',
                'type' => 'array',
                'items' => ['type' => 'integer'],
                'sanitize_callback' => 'wp_parse_id_list',
            ],
            'min_stock_quantity' => [
                'description' => 'Limit result set to products with at least this stock quantity.',
                'type' => 'number',
                'validate_callback' => 'rest_validate_request_arg',
            ],
            'max_stock_quantity' => [
                'description' => 'Limit result set to products with at most this stock quantity.',
                'type' => 'number',
                'validate_callback' => 'rest_validate_request_arg',
            ],
            'has_variations' => [
                'description' => 'Limit result set to variable products with at least one variation (true) or to the rest (false).',
                'type' => 'boolean',
                'sanitize_callback' => 'rest_sanitize_boolean',
                'validate_callback' => 'rest_validate_request_arg',
            ],
        ];
    }

    /**
     * @param  array<int|string, mixed>  $endpoint
     * @param  array<int, string>  $orderby
     * @param  array<string, array<string, mixed>>  $params
     * @return array<int|string, mixed>
     */
    private function extendCollection(array $endpoint, array $orderby, array $params): array
    {
        foreach ($endpoint as $index => $handler) {
            if (! is_int($index) || ! is_array($handler) || ! isset($handler['args']) || ! is_array($handler['args'])) {
                continue;
            }

            $methods = $handler['methods'] ?? '';
            $methods = is_array($methods) ? array_keys(array_filter($methods)) : explode(',', (string) $methods);

            if (! in_array('GET', array_map('trim', $methods), true)) {
                continue;
            }

            if (isset($handler['args']['orderby']['enum']) && is_array($handler['args']['orderby']['enum'])) {
                $endpoint[$index]['args']['orderby']['enum'] = array_values(array_unique(array_merge($handler['args']['orderby']['enum'], $orderby)));
            }

            $endpoint[$index]['args'] += $params;
        }

        return $endpoint;
    }

    /**
     * @return array<int, int>
     */
    private static function ids(mixed $value): array
    {
        if ($value === null || $value === '' || $value === []) {
            return [];
        }

        return array_values(array_filter(array_map('intval', is_array($value) ? $value : explode(',', (string) $value))));
    }

    private static function number(mixed $value): ?float
    {
        return is_numeric($value) ? (float) $value : null;
    }

    private static function bool(mixed $value): ?bool
    {
        if ($value === null || $value === '') {
            return null;
        }

        return is_bool($value) ? $value : in_array(strtolower((string) $value), ['1', 'true', 'yes'], true);
    }
}
