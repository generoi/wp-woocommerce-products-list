<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\Rest\Rows;
use WC_Product;
use WC_Product_Variation;
use WP_REST_Request;

/**
 * Turns one REST write into log rows: snapshots the touched fields before
 * WooCommerce saves, reads them again from the saved object and writes one
 * row per field that actually changed.
 *
 * Fields are the request's top-level wc/v3 keys. Two kinds expand into
 * leaves: `meta_data` becomes `meta_data.{key}`, and extension keys such as
 * `i18n` become their nested paths (`i18n.se.name`), so a translation edit
 * is one row like any other field. Values are stored as strings: scalars as
 * they are, booleans as `true`/`false`, arrays JSON-encoded in the shape
 * wc/v3 accepts on input, so a revert can post them back verbatim.
 *
 * The pure parts (paths, serialize, diff, rows) carry no WordPress
 * dependency and are covered by the unit suite.
 *
 * @phpstan-type Pending array{
 *     paths: array<int, string>, before: array<string, ?string>, creating: bool,
 *     object_id: int, object_type: string, parent_id: int, context: array<string, mixed>,
 *     attempted: array<string, ?string>
 * }
 */
final class Recorder
{
    public const FILTER_CONTEXT = 'wc_products_list/log_context';

    public const FILTER_VALUE = 'wc_products_list/log_value';

    /** wc/v3's relative stock key: the quantity is changed by this much. */
    public const INVENTORY_DELTA = 'inventory_delta';

    /** Request keys that are addressing, not data. */
    public const IGNORED_KEYS = ['id', 'product_id', 'context', '_fields', '_locale', '_method', '_envelope', 'force', 'parent_id'];

    /**
     * wc/v3 keys the product and variation controllers write. Arrays among
     * them (categories, images, dimensions) are one field, not leaves.
     */
    public const CORE_KEYS = [
        'name', 'slug', 'date_created', 'date_created_gmt', 'type', 'status', 'featured', 'catalog_visibility',
        'description', 'short_description', 'sku', 'global_unique_id', 'regular_price', 'sale_price',
        'date_on_sale_from', 'date_on_sale_from_gmt', 'date_on_sale_to', 'date_on_sale_to_gmt',
        'virtual', 'downloadable', 'downloads', 'download_limit', 'download_expiry', 'external_url', 'button_text',
        'tax_status', 'tax_class', 'manage_stock', 'stock_quantity', 'stock_status', 'backorders', 'low_stock_amount',
        'sold_individually', 'weight', 'dimensions', 'shipping_class', 'reviews_allowed', 'upsell_ids', 'cross_sell_ids',
        'purchase_note', 'categories', 'tags', 'brands', 'images', 'image', 'attributes', 'default_attributes',
        'grouped_products', 'menu_order', 'post_password', 'cost_of_goods_sold',
    ];

    /**
     * Fields whose value is never stored, only a marker of it. The log is
     * readable by everyone with the list capability; a product password
     * is not for them. `mask()` keeps two different values distinguishable
     * so a change still yields a row, but nothing can be read back from it,
     * and a revert skips the field.
     */
    public const MASKED_KEYS = ['post_password'];

    public const MASK_PREFIX = '***';

    /** @var array<int, Pending> keyed by spl_object_id of the request */
    private static array $pending = [];

    /**
     * The error rows already written during this request, as
     * `object_id|code`. A route of the plugin that dispatches wc/v3
     * batches from inside itself (the variations batch) answers with the
     * items those batches rejected; the nested request logged them, the
     * outer one must not log them again.
     *
     * @var array<string, true>
     */
    private static array $loggedErrors = [];

    /**
     * The stored form of a sensitive value: empty stays empty (so "no
     * password" reads as such), anything else is a fixed-length marker
     * derived from the value with a one-way hash.
     */
    public static function mask(?string $value): ?string
    {
        if ($value === null || $value === '') {
            return $value;
        }

        return self::MASK_PREFIX.substr(hash('sha256', $value), 0, 8);
    }

    public static function isMasked(string $path): bool
    {
        return in_array($path, self::MASKED_KEYS, true);
    }

    /**
     * The field paths a request body touches.
     *
     * @param  array<string, mixed>  $body  the request's body params
     * @return array<int, string>
     */
    public static function paths(array $body): array
    {
        $paths = [];

        foreach ($body as $key => $value) {
            $key = (string) $key;

            if ($key === '' || in_array($key, self::IGNORED_KEYS, true)) {
                continue;
            }

            // WooCommerce's relative stock write (`inventory_delta`: add to the
            // stored quantity, in the same save, so an order placed since the
            // editor opened is not overwritten): what changes is the quantity.
            if ($key === self::INVENTORY_DELTA) {
                $paths[] = 'stock_quantity';

                continue;
            }

            if ($key === 'meta_data') {
                foreach (is_array($value) ? $value : [] as $meta) {
                    if (is_array($meta) && isset($meta['key']) && is_scalar($meta['key']) && (string) $meta['key'] !== '') {
                        $paths[] = 'meta_data.'.$meta['key'];
                    }
                }

                continue;
            }

            if (in_array($key, self::CORE_KEYS, true) || ! is_array($value) || array_is_list($value)) {
                $paths[] = $key;

                continue;
            }

            foreach (self::leaves($value, $key) as $leaf) {
                $paths[] = $leaf;
            }
        }

        return array_values(array_unique($paths));
    }

    /**
     * Dot paths to the scalar (or list) leaves of a nested array.
     *
     * @param  array<string, mixed>  $value
     * @return array<int, string>
     */
    private static function leaves(array $value, string $prefix): array
    {
        $leaves = [];

        foreach ($value as $key => $child) {
            $path = $prefix.'.'.$key;

            if (is_array($child) && $child !== [] && ! array_is_list($child)) {
                foreach (self::leaves($child, $path) as $leaf) {
                    $leaves[] = $leaf;
                }
            } else {
                $leaves[] = $path;
            }
        }

        return $leaves;
    }

    /**
     * The stored form of a value: null stays null, booleans become
     * `true`/`false`, other scalars strings, arrays JSON.
     */
    public static function serialize(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }

        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        if (is_scalar($value)) {
            return (string) $value;
        }

        if ($value instanceof \DateTimeInterface) {
            return $value->format('Y-m-d\TH:i:s');
        }

        if (is_object($value) && method_exists($value, 'get_data')) {
            $value = $value->get_data();
        }

        $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        return $json === false ? '' : $json;
    }

    /**
     * The fields whose stored value differs. Null and the empty string are
     * the same absence: WooCommerce returns '' for an unset price and null
     * for an unset date, and a request clearing either yields no noise row.
     *
     * @param  array<string, ?string>  $before
     * @param  array<string, ?string>  $after
     * @return array<string, array{old: ?string, new: ?string}>
     */
    public static function diff(array $before, array $after): array
    {
        $changes = [];

        foreach ($after as $path => $new) {
            $old = $before[$path] ?? null;

            if (($old ?? '') === ($new ?? '')) {
                continue;
            }

            $changes[$path] = ['old' => $old, 'new' => $new];
        }

        return $changes;
    }

    /**
     * Log rows for a set of changes.
     *
     * @param  array<string, array{old: ?string, new: ?string}>  $changes
     * @param  array<string, mixed>  $base  shared columns (object_id, object_type, parent_id, action, context, ...)
     * @return array<int, array<string, mixed>>
     */
    public static function rows(array $changes, array $base): array
    {
        $rows = [];

        foreach ($changes as $field => $change) {
            $rows[] = $base + [
                'field' => $field,
                'old_value' => $change['old'],
                'new_value' => $change['new'],
                'status' => 'ok',
                'message' => '',
            ];
        }

        return $rows;
    }

    /**
     * Before WooCommerce saves: remember the current values of the fields
     * the request touches. The product passed by `pre_insert` already
     * carries the new values, so the old ones come from a fresh load.
     */
    public static function begin(WC_Product $product, WP_REST_Request $request, bool $creating): void
    {
        $body = self::body($request);
        $paths = self::paths($body);

        if ($paths === []) {
            return;
        }

        $before = [];

        if (! $creating && $product->get_id() > 0) {
            $stored = wc_get_product($product->get_id());

            if ($stored instanceof WC_Product) {
                $before = self::snapshot($stored, $paths);
            }
        }

        self::$pending[spl_object_id($request)] = [
            'paths' => $paths,
            'before' => $before,
            'creating' => $creating,
            'object_id' => (int) $product->get_id(),
            'object_type' => $product instanceof WC_Product_Variation ? 'variation' : 'product',
            'parent_id' => (int) $product->get_parent_id(),
            'context' => self::context($request, array_keys($body)),
            'attempted' => self::attempted($body, $paths),
        ];
    }

    /**
     * After WooCommerce saved: diff and log.
     */
    public static function complete(WC_Product $product, WP_REST_Request $request): void
    {
        $key = spl_object_id($request);
        $pending = self::$pending[$key] ?? null;

        if ($pending === null) {
            return;
        }

        unset(self::$pending[$key]);

        $after = self::snapshot($product, $pending['paths']);
        $changes = self::diff($pending['before'], $after);

        if ($changes === []) {
            return;
        }

        Logger::log(self::rows($changes, [
            'action' => $pending['creating'] ? 'create' : 'update',
            'object_type' => $product instanceof WC_Product_Variation ? 'variation' : 'product',
            'object_id' => (int) $product->get_id(),
            'parent_id' => (int) $product->get_parent_id(),
            'context' => $pending['context'],
        ]));
    }

    /**
     * The request is over: whatever WooCommerce rejected gets an error row.
     *
     * Two sources. Snapshots that never completed (the save failed after
     * `pre_insert`), and errors in the response for items that never got
     * that far: a bad SKU or price throws while the request is applied to
     * the product, before any hook, so for those the touched fields come
     * from the request body.
     *
     * @param  mixed  $response
     */
    public static function abandon($response, WP_REST_Request $request): void
    {
        $pending = self::$pending;
        self::$pending = [];

        $errors = self::errorsFromResponse($response);

        if ($pending === [] && $errors === []) {
            return;
        }

        $rows = [];
        $seen = [];

        foreach ($pending as $item) {
            $error = $errors[$item['object_id']] ?? $errors[0] ?? null;
            $seen[$item['object_id']] = true;
            self::$loggedErrors[$item['object_id'].'|'.($error['code'] ?? '')] = true;

            $rows[] = self::errorRow($item['object_type'], $item['object_id'], $item['parent_id'], $item['creating'], $item['paths'], $item['context'], $error, $item['before'], $item['attempted']);
        }

        if ($errors !== []) {
            $isVariation = str_contains($request->get_route(), '/variations');
            $parentId = (int) ($request['product_id'] ?? 0);
            $bodies = self::bodiesById($request);

            foreach ($errors as $id => $error) {
                if ($id === 0) {
                    $id = (int) ($request['id'] ?? 0);
                }

                if ($id === 0 || isset($seen[$id]) || isset(self::$loggedErrors[$id.'|'.$error['code']])) {
                    continue;
                }

                self::$loggedErrors[$id.'|'.$error['code']] = true;
                $body = $bodies[$id] ?? [];
                $paths = self::paths($body);
                // The plugin's cross-parent variations batch has no parent in
                // the route: a variation deleted meanwhile is named by the
                // parent the editor sent along (never used to address a write).
                $rowParent = $parentId > 0 ? $parentId : (int) ($body['parent_id'] ?? 0);

                $stored = $paths !== [] ? wc_get_product($id) : null;
                $before = $stored instanceof WC_Product && $stored->get_id() > 0 ? self::snapshot($stored, $paths) : [];

                $rows[] = self::errorRow($isVariation ? 'variation' : 'product', $id, $rowParent, false, $paths, self::context($request, array_keys($body)), $error, $before, self::attempted($body, $paths));
            }
        }

        Logger::log($rows);
    }

    /**
     * @param  array<int, string>  $paths
     * @param  array<string, mixed>  $context
     * @param  array{code: string, message: string}|null  $error
     * @param  array<string, ?string>  $before  stored values of the paths when the save was attempted
     * @param  array<string, ?string>  $attempted  the values the request asked for
     * @return array<string, mixed>
     */
    private static function errorRow(string $objectType, int $objectId, int $parentId, bool $creating, array $paths, array $context, ?array $error, array $before = [], array $attempted = []): array
    {
        $single = count($paths) === 1 ? $paths[0] : null;
        $context += ['code' => $error['code'] ?? '', 'fields' => $paths];

        // One error row per rejected item: with one field the values are
        // the row's own columns, with several they ride along in the context.
        if ($single === null && $attempted !== []) {
            $context['before'] = $before;
            $context['attempted'] = $attempted;
        }

        return [
            'action' => $creating ? 'create' : 'update',
            'object_type' => $objectType,
            'object_id' => $objectId,
            'parent_id' => $parentId,
            'field' => $single ?? '',
            'old_value' => $single !== null ? ($before[$single] ?? null) : null,
            'new_value' => $single !== null ? ($attempted[$single] ?? null) : null,
            'status' => 'error',
            'message' => $error['message'] ?? __('The save was rejected.', 'wp-woocommerce-products-list'),
            'context' => $context,
        ];
    }

    /**
     * The values a request body asks for, per field path, in stored form
     * (masked fields masked), so an error row shows what was tried.
     *
     * @param  array<string, mixed>  $body
     * @param  array<int, string>  $paths
     * @return array<string, ?string>
     */
    public static function attempted(array $body, array $paths): array
    {
        $values = [];

        foreach ($paths as $path) {
            $value = self::serialize(self::valueAt($body, $path));

            if ($path === 'stock_quantity' && ! array_key_exists('stock_quantity', $body) && is_numeric($body[self::INVENTORY_DELTA] ?? null)) {
                // A relative write: the change asked for, signed.
                $delta = (float) $body[self::INVENTORY_DELTA];
                $value = ($delta >= 0 ? '+' : '').self::serialize(floor($delta) === $delta ? (int) $delta : $delta);
            }

            $values[$path] = self::isMasked($path) ? self::mask($value) : $value;
        }

        return $values;
    }

    /**
     * The value at a field path of a request body: `meta_data.{key}` is
     * the entry with that key, other paths walk the nested keys.
     *
     * @param  array<string, mixed>  $body
     */
    private static function valueAt(array $body, string $path): mixed
    {
        $segments = explode('.', $path);

        if ($segments[0] === 'meta_data') {
            $key = implode('.', array_slice($segments, 1));

            foreach (is_array($body['meta_data'] ?? null) ? $body['meta_data'] : [] as $meta) {
                if (is_array($meta) && isset($meta['key']) && is_scalar($meta['key']) && (string) $meta['key'] === $key) {
                    return $meta['value'] ?? null;
                }
            }

            return null;
        }

        if (array_key_exists($path, $body)) {
            return $body[$path];
        }

        $value = $body;

        foreach ($segments as $segment) {
            if (! is_array($value) || ! array_key_exists($segment, $value)) {
                return null;
            }

            $value = $value[$segment];
        }

        return $value;
    }

    /**
     * The per-item bodies of a write request keyed by id: the `update`
     * entries of a batch, or the single request's own body.
     *
     * @return array<int, array<string, mixed>>
     */
    private static function bodiesById(WP_REST_Request $request): array
    {
        $body = self::body($request);
        $bodies = [];

        if (isset($body['update']) && is_array($body['update'])) {
            foreach ($body['update'] as $item) {
                if (is_array($item) && isset($item['id'])) {
                    $bodies[(int) $item['id']] = $item;
                }
            }

            return $bodies;
        }

        $id = (int) ($request['id'] ?? 0);

        if ($id > 0) {
            $bodies[$id] = $body;
        }

        return $bodies;
    }

    /**
     * Drop the snapshots of a request that is over without logging them:
     * it was refused before anything was attempted.
     */
    public static function discard(): void
    {
        self::$pending = [];
    }

    /**
     * Whether an error is a refusal (not logged in, not allowed) rather
     * than a failed save: a refused item was never attempted, so it gets
     * no log row. By code (`rest_forbidden`, `rest_cannot_*`,
     * `woocommerce_rest_cannot_*`, ...) or by a 401/403 status.
     */
    public static function isRefusal(string $code, mixed $data = null): bool
    {
        if (preg_match('/^(rest_forbidden|rest_cannot_|rest_not_logged_in|woocommerce_rest_cannot_|woocommerce_rest_authentication_)/', $code) === 1) {
            return true;
        }

        $status = is_array($data) ? (int) ($data['status'] ?? 0) : 0;

        return $status === 401 || $status === 403;
    }

    public static function hasPending(): bool
    {
        return self::$pending !== [];
    }

    public static function reset(): void
    {
        self::$pending = [];
        self::$loggedErrors = [];
    }

    /**
     * Forget which errors were logged: at the start of an outermost
     * request, so a nested dispatch's rows are only deduplicated against
     * the request that contains it.
     */
    public static function forgetLoggedErrors(): void
    {
        self::$loggedErrors = [];
    }

    /**
     * The stored values of the given fields on a product.
     *
     * @param  array<int, string>  $paths
     * @return array<string, ?string>
     */
    public static function snapshot(WC_Product $product, array $paths): array
    {
        $values = [];

        foreach ($paths as $path) {
            $value = self::serialize(self::read($product, $path));
            $values[$path] = self::isMasked($path) ? self::mask($value) : $value;
        }

        return $values;
    }

    /**
     * The current value of one field, in the shape wc/v3 takes on input.
     */
    public static function read(WC_Product $product, string $path): mixed
    {
        $segments = explode('.', $path);
        $key = $segments[0];

        if ($key === 'meta_data') {
            $metaKey = implode('.', array_slice($segments, 1));
            $meta = $product->get_meta($metaKey, false);
            // array_values: get_meta() keeps the keys of the object's meta
            // list, which has gaps once a key was deleted.
            $values = array_values(array_map(static fn ($item) => $item->value, is_array($meta) ? $meta : []));

            return match (count($values)) {
                0 => null,
                1 => $values[0],
                default => $values,
            };
        }

        if (count($segments) > 1 || ! in_array($key, self::CORE_KEYS, true)) {
            return self::readExtension($product, $path, $segments);
        }

        return match ($key) {
            'categories' => self::ids($product->get_category_ids()),
            'tags' => self::ids($product->get_tag_ids()),
            'brands' => self::ids(wc_get_product_term_ids($product->get_id(), 'product_brand')),
            // The list drops the gallery (Rows::dropGallery); the log must hold the stored one.
            'images' => Rows::withGallery(static fn (): array => self::ids(array_filter(array_merge([$product->get_image_id()], $product->get_gallery_image_ids())))),
            'image' => $product->get_image_id() ? ['id' => (int) $product->get_image_id()] : null,
            'dimensions' => [
                'length' => (string) $product->get_length(),
                'width' => (string) $product->get_width(),
                'height' => (string) $product->get_height(),
            ],
            'shipping_class' => (string) $product->get_shipping_class(),
            'attributes' => self::attributes($product),
            'default_attributes' => self::defaultAttributes($product),
            'grouped_products' => array_map('intval', $product->get_children()),
            'upsell_ids' => array_map('intval', $product->get_upsell_ids()),
            'cross_sell_ids' => array_map('intval', $product->get_cross_sell_ids()),
            'downloads' => array_values(array_map(static fn ($download) => [
                'id' => $download->get_id(),
                'name' => $download->get_name(),
                'file' => $download->get_file(),
            ], $product->get_downloads())),
            'date_created', 'date_on_sale_from', 'date_on_sale_to' => self::date($product->{'get_'.$key}()),
            'date_created_gmt', 'date_on_sale_from_gmt', 'date_on_sale_to_gmt' => self::date($product->{'get_'.substr($key, 0, -4)}(), true),
            'cost_of_goods_sold' => ['value' => $product->get_cogs_value()],
            'type' => $product->get_type(),
            default => method_exists($product, 'get_'.$key) ? $product->{'get_'.$key}() : null,
        };
    }

    /**
     * Values an extension wrote: by default the gds-woo-i18n convention
     * (`i18n.{lang}.{field}` lives in meta `_i18n_{field}_{lang}`), and
     * whatever `wc_products_list/log_value` returns for anything else.
     *
     * @param  array<int, string>  $segments
     */
    private static function readExtension(WC_Product $product, string $path, array $segments): mixed
    {
        $value = null;

        if ($segments[0] === 'i18n' && count($segments) === 3) {
            $value = $product->get_meta('_i18n_'.$segments[2].'_'.$segments[1], true);
        }

        /**
         * Filters the logged value of an extension field.
         *
         * @param  mixed  $value  null when the plugin cannot read it
         * @param  string  $path  dot path in the request body, e.g. `i18n.se.name`
         * @param  WC_Product  $product
         * @param  array<int, string>  $segments
         */
        return apply_filters(self::FILTER_VALUE, $value, $path, $product, $segments);
    }

    /**
     * @param  array<int, int|string>  $ids
     * @return array<int, array{id: int}>
     */
    private static function ids(array $ids): array
    {
        return array_values(array_map(static fn ($id): array => ['id' => (int) $id], $ids));
    }

    private static function date(mixed $date, bool $gmt = false): ?string
    {
        if (! $date instanceof \WC_DateTime) {
            return null;
        }

        return $gmt ? gmdate('Y-m-d\TH:i:s', $date->getTimestamp()) : $date->date('Y-m-d\TH:i:s');
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private static function attributes(WC_Product $product): array
    {
        $list = [];

        if ($product instanceof WC_Product_Variation) {
            foreach ($product->get_attributes() as $name => $option) {
                $list[] = ['name' => (string) $name, 'option' => (string) $option];
            }

            return $list;
        }

        foreach ($product->get_attributes() as $attribute) {
            if (! $attribute instanceof \WC_Product_Attribute) {
                continue;
            }

            $list[] = [
                'id' => $attribute->get_id(),
                'name' => $attribute->get_name(),
                'position' => $attribute->get_position(),
                'visible' => $attribute->get_visible(),
                'variation' => $attribute->get_variation(),
                'options' => $attribute->is_taxonomy()
                    ? array_map(static fn ($term) => $term->name, $attribute->get_terms() ?: [])
                    : $attribute->get_options(),
            ];
        }

        return $list;
    }

    /**
     * @return array<int, array{name: string, option: string}>
     */
    private static function defaultAttributes(WC_Product $product): array
    {
        $list = [];

        foreach ($product->get_default_attributes() as $name => $option) {
            $list[] = ['name' => (string) $name, 'option' => (string) $option];
        }

        return $list;
    }

    /**
     * @return array<string, mixed>
     */
    private static function body(WP_REST_Request $request): array
    {
        return array_merge($request->get_body_params(), $request->get_json_params() ?: []);
    }

    /**
     * @param  array<int, int|string>  $keys
     * @return array<string, mixed>
     */
    private static function context(WP_REST_Request $request, array $keys): array
    {
        $context = [
            'keys' => array_values(array_filter(array_map('strval', $keys), static fn (string $key): bool => ! in_array($key, self::IGNORED_KEYS, true))),
            'route' => $request->get_route(),
            'ip' => isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash((string) $_SERVER['REMOTE_ADDR'])) : '',
            'ua' => isset($_SERVER['HTTP_USER_AGENT']) ? substr(sanitize_text_field(wp_unslash((string) $_SERVER['HTTP_USER_AGENT'])), 0, 255) : '',
        ];

        /**
         * Filters the context stored with every log row of a save. Unset
         * `ip` and `ua` to keep no personal data beyond the user id.
         *
         * @param  array<string, mixed>  $context
         * @param  WP_REST_Request  $request
         */
        return (array) apply_filters(self::FILTER_CONTEXT, $context, $request);
    }

    /**
     * Error messages by object id from a (batch) response, 0 for a single error.
     *
     * @param  mixed  $response
     * @return array<int, array{code: string, message: string}>
     */
    private static function errorsFromResponse($response): array
    {
        $error = is_wp_error($response) ? $response : ($response instanceof \WP_REST_Response ? $response->as_error() : null);

        if (is_wp_error($error)) {
            $code = (string) $error->get_error_code();

            if (self::isRefusal($code, $error->get_error_data()) || ($response instanceof \WP_REST_Response && in_array($response->get_status(), [401, 403], true))) {
                return [];
            }

            return [0 => ['code' => $code, 'message' => $error->get_error_message()]];
        }

        // `rest_request_after_callbacks` sees what the handler returned: a
        // batch handler returns a plain array, not yet a WP_REST_Response.
        /** @var array<string, mixed> $data */
        $data = $response instanceof \WP_REST_Response ? (array) $response->get_data() : (is_array($response) ? $response : []);
        $errors = [];

        foreach (['create', 'update', 'delete'] as $type) {
            $list = $data[$type] ?? null;

            foreach (is_array($list) ? $list : [] as $item) {
                if (is_array($item) && isset($item['error']) && is_array($item['error'])) {
                    if (self::isRefusal((string) ($item['error']['code'] ?? ''), $item['error']['data'] ?? null)) {
                        continue;
                    }

                    $errors[(int) ($item['id'] ?? 0)] = [
                        'code' => (string) ($item['error']['code'] ?? ''),
                        'message' => (string) ($item['error']['message'] ?? ''),
                    ];
                }
            }
        }

        return $errors;
    }
}
