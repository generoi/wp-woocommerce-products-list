<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use WC_Product;
use WeakMap;
use WP_REST_Request;
use WP_REST_Response;

/**
 * What the Catalog app needs on every row beyond the wc/v3 fields: the
 * `wc_products_list` object (`variation_count`, `edit_link`, `can_edit`,
 * `can_delete`, `parent_id`) and the integrations' keys through
 * `wc_products_list/row`. Only in list mode.
 *
 * Kept cheap on purpose: a page of 100 rows must not add a query per row.
 * The variation count reads the children WooCommerce has already loaded
 * (it calls `has_child()` on every variable product while serialising), the
 * capabilities and the edit link use the post that is in the object cache
 * from the list query. Nothing is computed when `_fields` leaves it out.
 */
final class Rows
{
    public const KEY = 'wc_products_list';

    public const FILTER_ROW = 'wc_products_list/row';

    public const BRANDS_FILTER = 'woocommerce_rest_prepare_product_object';

    /** @var WeakMap<WP_REST_Request, array<int, string>|null>|null parsed `_fields` per request object */
    private static ?WeakMap $fields = null;

    /** @var callable|null WooCommerce Brands' own response callback, once taken over */
    private $brandsCallback = null;

    public function register(): void
    {
        add_filter('woocommerce_rest_prepare_product_object', [$this, 'enrich'], 10, 3);
        add_filter('woocommerce_rest_prepare_product_variation_object', [$this, 'enrich'], 10, 3);
        // Late: after every other row filter (brands, integrations) has added its keys.
        add_filter('woocommerce_rest_prepare_product_object', [$this, 'trimBatchItem'], 1000, 3);
        add_filter('woocommerce_rest_prepare_product_variation_object', [$this, 'trimBatchItem'], 1000, 3);
        add_filter('woocommerce_product_get_gallery_image_ids', [$this, 'dropGallery'], 10, 2);
        add_action('rest_api_init', [$this, 'registerSchema']);

        // WC_Brands registers its hooks on plugins_loaded at 11.
        add_action('plugins_loaded', [$this, 'takeOverBrands'], 20);
    }

    /**
     * WooCommerce Brands adds `brands` to every product response with
     * `wp_get_post_terms()`, which bypasses the object term cache: two
     * queries per product, on every page, whether or not the request asked
     * for brands (`_fields`). On a 100-row list page that is 200 of the
     * ~360 queries. Its callback is replaced by one that, in list mode,
     * respects `_fields` and reads the terms the list query already primed;
     * every other request still gets WooCommerce's own callback.
     */
    public function takeOverBrands(): void
    {
        $callback = self::findBrandsCallback();

        if ($callback === null) {
            return;
        }

        remove_filter(self::BRANDS_FILTER, $callback, 10);
        $this->brandsCallback = $callback;
        add_filter(self::BRANDS_FILTER, [$this, 'brands'], 10, 3);
    }

    /**
     * @param  WP_REST_Response|mixed  $response
     * @param  WC_Product|mixed  $product
     * @param  WP_REST_Request|mixed  $request
     * @return WP_REST_Response|mixed
     */
    public function brands($response, $product, $request = null)
    {
        if (! ListMode::active() || ListMode::method() !== 'GET' || ! $response instanceof WP_REST_Response || ! $request instanceof WP_REST_Request) {
            return $this->brandsCallback !== null ? call_user_func($this->brandsCallback, $response, $product) : $response;
        }

        if (! self::includes('brands', $request)) {
            return $response;
        }

        $data = $response->get_data();

        if (! is_array($data) || ! empty($data['brands']) || ! $product instanceof WC_Product) {
            return $response;
        }

        $terms = get_the_terms($product->get_id(), 'product_brand');
        $data['brands'] = [];

        foreach (is_array($terms) ? $terms : [] as $term) {
            $data['brands'][] = ['id' => (int) $term->term_id, 'name' => (string) $term->name, 'slug' => (string) $term->slug];
        }

        $response->set_data($data);

        return $response;
    }

    /**
     * The `[WC_Brands, 'rest_api_prepare_brands_to_product']` callback on
     * the product response filter, if WooCommerce registered one.
     */
    private static function findBrandsCallback(): ?callable
    {
        $hook = $GLOBALS['wp_filter'][self::BRANDS_FILTER] ?? null;

        if (! $hook instanceof \WP_Hook) {
            return null;
        }

        foreach ($hook->callbacks[10] ?? [] as $registered) {
            $function = $registered['function'];

            if (is_array($function) && is_object($function[0]) && $function[0] instanceof \WC_Brands && $function[1] === 'rest_api_prepare_brands_to_product') {
                return $function;
            }
        }

        return null;
    }

    /**
     * The list only ever shows one image per row, but wc/v3 serialises the
     * whole gallery of every product (two `wp_get_attachment_image_src()`
     * calls and four date conversions per image), which is most of the
     * time of a 100-row page on an image-heavy catalog. On list-mode read
     * requests a product therefore has no gallery: `images` holds the
     * featured image only (or the first gallery image when there is no
     * featured one, so the thumbnail is the same as everywhere else).
     * Writes are untouched (the batch sub-requests of a save run inside one
     * POST), so a save never sees a trimmed gallery.
     *
     * @param  mixed  $ids
     * @param  mixed  $product
     * @return mixed
     */
    public function dropGallery($ids, $product = null)
    {
        if (! ListMode::active() || ListMode::method() !== 'GET' || ! is_array($ids)) {
            return $ids;
        }

        /**
         * Filters whether list-mode reads skip the product gallery.
         *
         * @param  bool  $drop
         */
        if (! apply_filters('wc_products_list/drop_gallery', true)) {
            return $ids;
        }

        $featured = $product instanceof WC_Product ? (int) $product->get_image_id('edit') : 0;

        return $featured > 0 ? [] : array_slice($ids, 0, 1);
    }

    /**
     * Put `wc_products_list` in the item schema of both object types, so
     * `_fields=…,wc_products_list` is accepted as a known field. Schema only:
     * the value is set by `enrich()` in list mode, and no other consumer
     * sees the key.
     */
    public function registerSchema(): void
    {
        foreach (['product', 'product_variation'] as $type) {
            register_rest_field($type, self::KEY, [
                'get_callback' => null,
                'update_callback' => null,
                'schema' => self::schema(),
            ]);
        }
    }

    /**
     * @param  WP_REST_Response|mixed  $response
     * @param  WC_Product|mixed  $product
     * @param  WP_REST_Request|mixed  $request
     * @return WP_REST_Response|mixed
     */
    public function enrich($response, $product, $request)
    {
        if (! $response instanceof WP_REST_Response || ! $product instanceof WC_Product || ! $request instanceof WP_REST_Request || ! ListMode::active()) {
            return $response;
        }

        $data = $response->get_data();

        if (! is_array($data)) {
            return $response;
        }

        $isVariation = $product->is_type('variation');

        if ($isVariation) {
            // wc/v3 11.1 returns both; a leaner build of the controller
            // (or a filter) might not, and the app relies on them.
            if (! array_key_exists('name', $data) && self::includes('name', $request)) {
                $data['name'] = $product->get_name();
            }

            if (! array_key_exists('parent_id', $data) && self::includes('parent_id', $request)) {
                $data['parent_id'] = $product->get_parent_id();
            }
        }

        if (self::includes(self::KEY, $request)) {
            $data[self::KEY] = self::row($product, $isVariation);
        }

        /**
         * Filters a product or variation row sent to the Catalog app, after
         * the plugin's `wc_products_list` key is set. Respect `_fields`:
         * `Rows::includes('i18n', $request)`.
         *
         * @param  array<string, mixed>  $data
         * @param  WC_Product  $product  a WC_Product_Variation for variation rows
         * @param  WP_REST_Request  $request
         */
        $data = apply_filters(self::FILTER_ROW, $data, $product, $request);

        $response->set_data($data);

        return $response;
    }

    /**
     * A batch response returns the full wc/v3 object of every item it
     * wrote (a 50-product chunk is over a megabyte, most of it
     * descriptions, meta and attributes the app never reads), and core's
     * `_fields` cannot reach into `{update: [...]}`. On list-mode batch
     * writes the app names the row fields it wants in `fields` (as for
     * the actions route), and each item row is trimmed to them here, `id`
     * always kept. Single writes are left to core's `_fields`. WooCommerce
     * adds `_links` to each item after this; the app ignores it.
     *
     * @param  WP_REST_Response|mixed  $response
     * @param  WC_Product|mixed  $product
     * @param  WP_REST_Request|mixed  $request
     * @return WP_REST_Response|mixed
     */
    public function trimBatchItem($response, $product, $request)
    {
        if (! $response instanceof WP_REST_Response || ! $request instanceof WP_REST_Request || ! ListMode::active()) {
            return $response;
        }

        $outer = ListMode::request();

        // The outer request is the one being dispatched; a batch item's
        // request is a different object, built by WooCommerce per item.
        if ($outer === null || $outer === $request || $outer->get_method() === 'GET') {
            return $response;
        }

        $fields = $outer->get_param('fields');

        if (! is_string($fields) || trim($fields) === '') {
            return $response;
        }

        $data = $response->get_data();

        if (is_array($data)) {
            $response->set_data(self::trim($data, $fields.',id'));
        }

        return $response;
    }

    /**
     * @return array{variation_count: int, edit_link: string, can_edit: bool, can_delete: bool, parent_id: int}
     */
    public static function row(WC_Product $product, ?bool $isVariation = null): array
    {
        $isVariation ??= $product->is_type('variation');
        $id = $product->get_id();
        $parentId = $isVariation ? $product->get_parent_id() : 0;

        return [
            // Children are already loaded for variable products by the
            // serialiser; for anything else this is a type check.
            'variation_count' => $product->is_type('variable') ? count($product->get_children()) : 0,
            // Variations are edited inside the parent's editor.
            'edit_link' => self::editLink($isVariation ? $parentId : $id),
            'can_edit' => current_user_can('edit_post', $id),
            'can_delete' => current_user_can('delete_post', $id),
            'parent_id' => $parentId,
        ];
    }

    /**
     * Whether a top-level key is wanted: true when `_fields` is absent, or
     * names the key or one of its sub-keys.
     */
    public static function includes(string $field, WP_REST_Request $request): bool
    {
        $fields = self::fields($request);

        return $fields === null || rest_is_field_included($field, $fields);
    }

    /**
     * The parsed `_fields` of the request, or null when it has none. Parsed
     * once per request object: it is asked for on every row of a page.
     *
     * @return array<int, string>|null
     */
    public static function fields(WP_REST_Request $request): ?array
    {
        // Keyed by the object itself: an id would be reused by a later
        // request once this one is freed (tests, WP-CLI, batch loops).
        self::$fields ??= new WeakMap;

        if (self::$fields->offsetExists($request)) {
            return self::$fields[$request];
        }

        $raw = $request->get_param('_fields');
        $fields = null;

        if (is_string($raw) || is_array($raw)) {
            $parsed = array_values(array_filter(array_map('trim', wp_parse_list($raw))));
            $fields = $parsed === [] ? null : $parsed;
        }

        return self::$fields[$request] = $fields;
    }

    /**
     * A row trimmed to a `fields` list the way core trims a response to
     * `_fields` (`rest_is_field_included()`, so `i18n.se.name` keeps `i18n`),
     * without `_links`/`_embedded`. For rows collected from nested requests:
     * `rest_do_request()` never trims, and batch sub-requests do not see the
     * parent's `_fields` at all.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    public static function trim(array $row, ?string $fields): array
    {
        unset($row['_links'], $row['_embedded']);

        $wanted = is_string($fields) ? array_values(array_filter(array_map('trim', wp_parse_list($fields)))) : [];

        if ($wanted === []) {
            return $row;
        }

        return array_filter($row, static fn (string $key): bool => rest_is_field_included($key, $wanted), ARRAY_FILTER_USE_KEY);
    }

    private static function editLink(int $postId): string
    {
        // get_edit_post_link() is the one that knows about the block
        // product editor; it returns null when the user may not edit.
        $link = $postId > 0 ? get_edit_post_link($postId, 'raw') : null;

        return is_string($link) && $link !== '' ? $link : admin_url(sprintf('post.php?post=%d&action=edit', $postId));
    }

    /**
     * @return array<string, mixed>
     */
    private static function schema(): array
    {
        return [
            'description' => 'Catalog app row data: variation count, edit link and per-row capabilities. Present only on requests with the X-WC-Products-List header.',
            'type' => 'object',
            'context' => ['view', 'edit'],
            'readonly' => true,
            'properties' => [
                'variation_count' => ['type' => 'integer', 'description' => 'Number of variations of a variable product, 0 otherwise.'],
                'edit_link' => ['type' => 'string', 'format' => 'uri', 'description' => 'Admin edit link; the parent product for a variation.'],
                'can_edit' => ['type' => 'boolean'],
                'can_delete' => ['type' => 'boolean'],
                'parent_id' => ['type' => 'integer', 'description' => 'The parent product id of a variation, 0 for products.'],
            ],
        ];
    }
}
