<?php

namespace GeneroWP\ProductsList\Rest;

use Automattic\WooCommerce\Internal\Caches\ProductCache;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Log\Revert;
use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Server-side protection of list-mode writes against concurrent edits
 * (docs/contracts.md §3.6). Three small checks, each run in
 * `Saves::guardInsert()` (the first `pre_insert` filter,
 * `Saves::GUARD_PRIORITY`, so extension filters after it read the
 * stored state under the lock), right before WooCommerce saves one
 * product or variation:
 *
 * 1. A short MySQL named lock per object (`GET_LOCK`), held from the
 *    check until the save's insert hooks are done. Every write the app
 *    makes (quick edit, bulk save, History revert) passes through here,
 *    so two of them never interleave on the same object. Released when
 *    the item is done, when the next item starts, at the end of the
 *    request, and by MySQL itself when the connection goes away.
 * 2. A freshness check: the batch primes caches for all its items up
 *    front (`Saves::primeBatch()`), and an item saved a minute later
 *    must not be saved from that copy. Under the lock, the post row and
 *    the meta are read once more; when they differ from the cache, the
 *    caches are dropped and the request's changes are put on a freshly
 *    loaded object, so WooCommerce's derived values (`_price`, sale <
 *    regular, stock status, lookups) come from the stored state.
 * 3. An optimistic check: an item may carry `_wcpl_expect`, a flat map of
 *    field path => the value the editor based the change on. When a
 *    stored value differs, the item is refused with
 *    `wc_products_list_conflict` (409) and the current values, and is
 *    logged as skipped (reason `conflict`). This also catches writes
 *    made outside the app (classic editor, orders, imports).
 *
 * An item open in WordPress's product editor by another user (core's post
 * lock, `_edit_lock`, on the product or on a variation's parent) is
 * refused with `wc_products_list_editing` (409): their Update would put
 * the form's values back over the save without a word.
 *
 * Writes to a product in the Trash (or a variation of one) are refused
 * with `wc_products_list_trashed` (409) unless the request sets `status`.
 * A row deleted for good after the request loaded it is refused with
 * `wc_products_list_deleted` (404), so nothing is written for it.
 */
final class Concurrency
{
    /** The per-item request key with the expected values. */
    public const EXPECT_KEY = '_wcpl_expect';

    public const CONFLICT_ERROR = 'wc_products_list_conflict';

    public const LOCKED_ERROR = 'wc_products_list_locked';

    public const TRASHED_ERROR = 'wc_products_list_trashed';

    public const DELETED_ERROR = 'wc_products_list_deleted';

    public const REVERT_RUNNING_ERROR = 'wc_products_list_revert_running';

    public const EDITING_ERROR = 'wc_products_list_editing';

    /** Seconds a save waits for another save of the same object to finish. */
    public const FILTER_LOCK_TIMEOUT = 'wc_products_list/lock_timeout';

    public const LOCK_TIMEOUT = 10;

    /** @var array<string, true> lock names this process holds */
    private static array $held = [];

    /** @var array<int, string> object id => its lock name, for the object locks held */
    private static array $objects = [];

    /**
     * A lock name, at most 64 characters (MySQL's limit), scoped to this
     * site's database and table prefix so two sites on one server do not
     * share locks.
     */
    public static function lockName(string $kind, string $key): string
    {
        global $wpdb;

        $site = substr(md5((defined('DB_NAME') ? (string) DB_NAME : '').'|'.$wpdb->prefix), 0, 10);

        return substr('wcpl_'.$site.'_'.$kind.'_'.$key, 0, 64);
    }

    /**
     * Take a named lock, waiting up to `$timeout` seconds. True when held
     * (or when the database has no named locks: the checks below still run).
     */
    public static function acquire(string $name, int $timeout): bool
    {
        global $wpdb;

        if (isset(self::$held[$name])) {
            return true;
        }

        $suppress = $wpdb->suppress_errors(true);
        $result = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, %d)', $name, max(0, $timeout)));
        $wpdb->suppress_errors($suppress);

        if ($result === null) {
            // No named locks on this server, or the call failed: carry on unlocked.
            return true;
        }

        if ((string) $result !== '1') {
            return false;
        }

        self::$held[$name] = true;

        return true;
    }

    public static function release(string $name): void
    {
        global $wpdb;

        if (! isset(self::$held[$name])) {
            return;
        }

        unset(self::$held[$name]);
        $suppress = $wpdb->suppress_errors(true);
        $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $name));
        $wpdb->suppress_errors($suppress);
    }

    public static function lockTimeout(): int
    {
        /**
         * Filters how many seconds a list-mode save waits for another save
         * of the same product or variation before it is refused with
         * `wc_products_list_locked`.
         *
         * @param  int  $seconds
         */
        return max(0, (int) apply_filters(self::FILTER_LOCK_TIMEOUT, self::LOCK_TIMEOUT));
    }

    /**
     * Lock one object for the save about to happen. A save is one item at
     * a time, so the lock of an earlier item still held (its save failed
     * before the insert hooks) is let go first: a process never holds two
     * object locks, and two processes cannot deadlock on them.
     */
    public static function lockObject(int $id): bool
    {
        foreach (array_keys(self::$objects) as $held) {
            if ($held !== $id) {
                self::unlockObject($held);
            }
        }

        $name = self::lockName('o', (string) $id);

        if (! self::acquire($name, self::lockTimeout())) {
            return false;
        }

        self::$objects[$id] = $name;

        return true;
    }

    public static function unlockObject(int $id): void
    {
        if (! isset(self::$objects[$id])) {
            return;
        }

        self::release(self::$objects[$id]);
        unset(self::$objects[$id]);
    }

    public static function unlockObjects(): void
    {
        foreach (array_keys(self::$objects) as $id) {
            self::unlockObject($id);
        }
    }

    /** For tests. */
    public static function heldObjects(): array
    {
        return array_keys(self::$objects);
    }

    /**
     * Whether the cached post row or meta of an object differ from the
     * database: one indexed read of each. An object with nothing cached
     * was just loaded and counts as fresh.
     */
    public static function stale(int $id): bool
    {
        global $wpdb;

        $cachedPost = wp_cache_get($id, 'posts');
        $cachedMeta = wp_cache_get($id, 'post_meta');

        if (! is_object($cachedPost) || ! is_array($cachedMeta)) {
            return $cachedPost !== false || $cachedMeta !== false;
        }

        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$wpdb->posts} WHERE ID = %d", $id), ARRAY_A);

        if (! is_array($row)) {
            return true;
        }

        foreach ($row as $column => $value) {
            if ((string) ($cachedPost->{$column} ?? '') !== (string) $value) {
                return true;
            }
        }

        $rows = $wpdb->get_results($wpdb->prepare("SELECT meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id = %d ORDER BY meta_id ASC", $id), ARRAY_A);
        $meta = [];

        foreach (is_array($rows) ? $rows : [] as $metaRow) {
            $meta[(string) $metaRow['meta_key']][] = (string) $metaRow['meta_value'];
        }

        $cached = [];

        foreach ($cachedMeta as $key => $values) {
            $cached[(string) $key] = array_map('strval', (array) $values);
        }

        ksort($meta);
        ksort($cached);

        return $meta !== $cached;
    }

    /**
     * Drop every cache an object is loaded from: the post, its meta and
     * terms (`clean_post_cache()`), WooCommerce's raw meta cache and its
     * product instance cache.
     */
    public static function forget(int $id): void
    {
        clean_post_cache($id);

        if (class_exists(\WC_Data::class)) {
            wp_cache_delete(\WC_Data::generate_meta_cache_key($id, 'products'), 'products');
        }

        if (class_exists(ProductCache::class) && function_exists('wc_get_container')) {
            try {
                wc_get_container()->get(ProductCache::class)->remove($id);
            } catch (\Throwable) {
                // No product cache: nothing to drop.
            }
        }
    }

    /**
     * Request keys of the WooCommerce REST API whose prop has another name
     * (or several). Other keys are their prop's name. `dimensions` is
     * handled by its sub-keys, `inventory_delta` by `refresh()`.
     */
    private const REQUEST_PROPS = [
        'categories' => ['category_ids'],
        'tags' => ['tag_ids'],
        'shipping_class' => ['shipping_class_id'],
        'images' => ['image_id', 'gallery_image_ids'],
        'image' => ['image_id'],
        'date_on_sale_from_gmt' => ['date_on_sale_from'],
        'date_on_sale_to_gmt' => ['date_on_sale_to'],
        'grouped_products' => ['children'],
    ];

    /**
     * The props a request body names: what WooCommerce's
     * prepare_object_for_database() set from it, changed or not.
     *
     * @param  array<string, mixed>  $body
     * @param  array<string, mixed>  $data  the prepared object's get_data()
     * @return array<int, string>
     */
    public static function requestedProps(array $body, array $data): array
    {
        $props = [];

        foreach ($body as $key => $value) {
            $key = (string) $key;

            if ($key === 'dimensions') {
                $props = array_merge($props, array_intersect(['length', 'width', 'height'], array_keys(is_array($value) ? $value : [])));
            } elseif (isset(self::REQUEST_PROPS[$key])) {
                $props = array_merge($props, self::REQUEST_PROPS[$key]);
            } elseif ($key !== 'meta_data' && $key !== 'id' && array_key_exists($key, $data) && self::took($value, $data[$key])) {
                $props[] = $key;
            }
        }

        return array_values(array_unique($props));
    }

    /**
     * Whether WooCommerce took a scalar request value for its prop: a
     * value it ignored (a stock quantity on an object that does not
     * manage stock) is left alone, so the stale copy's value is not put
     * back over the stored one. Lists and objects count as taken.
     */
    private static function took(mixed $requested, mixed $prepared): bool
    {
        if (! is_scalar($requested) && $requested !== null) {
            return true;
        }

        if (is_bool($prepared)) {
            // WooCommerce's wc_string_to_bool(), for a request's true, 1, "yes", "true".
            return ($requested === true || in_array(strtolower((string) $requested), ['1', 'yes', 'true'], true)) === $prepared;
        }

        return ! is_scalar($prepared) && $prepared !== null ? true : self::same($requested === null ? null : (string) $requested, $prepared === null ? null : (string) $prepared);
    }

    /**
     * The product WooCommerce is about to save, loaded from the stored
     * state: the object as given when its caches are current, otherwise
     * a fresh load with the request's values applied.
     *
     * Every prop and meta key the request names is put on the fresh
     * object, not only the ones WooCommerce recorded as changes: those
     * were measured against the stale copy, so a requested value equal
     * to it (but not to the stored one) would otherwise be dropped and
     * the other writer's value kept without a word. A relative stock
     * write (`inventory_delta`) is added to the stored quantity again.
     *
     * Null when the row is gone: deleted for good since the request
     * loaded it (another tab's Delete, wp-admin's "Remove variation").
     * Saving the cached copy (or the empty variation WooCommerce loads for
     * a missing post) would write meta and a lookup row for a post
     * that no longer exists, so the caller refuses the item instead.
     */
    public static function refresh(WC_Product $product, ?WP_REST_Request $request = null): ?WC_Product
    {
        $id = $product->get_id();

        if ($id <= 0 || ! self::stale($id)) {
            return $product;
        }

        self::forget($id);

        // Before the reload: WooCommerce's variation data store loads an
        // empty variation for a missing post instead of failing.
        if (get_post($id) === null) {
            return null;
        }

        $fresh = wc_get_product($id);

        if (! $fresh instanceof WC_Product || get_class($fresh) !== get_class($product)) {
            // A type change is applied as WooCommerce built it.
            return $product;
        }

        $body = $request instanceof WP_REST_Request ? array_merge($request->get_body_params(), $request->get_json_params() ?: []) : [];
        $data = $product->get_data();
        $props = $product->get_changes() + array_intersect_key($data, array_flip(self::requestedProps($body, $data)));
        $storedStock = $fresh->get_stock_quantity('edit');
        $fresh->set_props($props);

        if (isset($body['inventory_delta']) && ! isset($body['stock_quantity']) && $fresh->get_manage_stock()) {
            $fresh->set_stock_quantity(wc_stock_amount(wc_stock_amount($storedStock) + wc_stock_amount($body['inventory_delta'])));
        }

        $requestedMeta = [];

        foreach (is_array($body['meta_data'] ?? null) ? $body['meta_data'] : [] as $meta) {
            if (is_array($meta) && isset($meta['key']) && is_scalar($meta['key'])) {
                $requestedMeta[(string) $meta['key']] = true;
            }
        }

        foreach ($product->get_meta_data() as $meta) {
            $data = $meta->get_data();
            $key = (string) $data['key'];

            if (! empty($data['id']) && $meta->get_changes() === [] && ! isset($requestedMeta[$key])) {
                continue;
            }

            unset($requestedMeta[$key]);

            if ($data['value'] === null) {
                $fresh->delete_meta_data($key);
            } else {
                $fresh->update_meta_data($key, $data['value']);
            }
        }

        return $fresh;
    }

    /**
     * The expected values of a request, path => stored form: the flat
     * `_wcpl_expect` map. Masked fields are left out (their value is not
     * known to the client).
     *
     * @return array<string, ?string>
     */
    public static function expected(mixed $expect): array
    {
        if (! is_array($expect)) {
            return [];
        }

        $values = [];

        foreach ($expect as $path => $value) {
            $path = (string) $path;

            if ($path === '' || Recorder::isMasked($path)) {
                continue;
            }

            $values[$path] = is_string($value) || $value === null ? $value : Recorder::serialize($value);
        }

        return $values;
    }

    /**
     * The fields whose stored value is not the expected one: path => the
     * value now (stored form).
     *
     * @param  array<string, ?string>  $expected
     * @return array<string, ?string>
     */
    public static function conflicts(WC_Product $stored, array $expected): array
    {
        if ($expected === []) {
            return [];
        }

        $current = Recorder::snapshot($stored, array_keys($expected));
        $conflicts = [];

        foreach ($expected as $path => $value) {
            if (! self::matches($stored, $path, $value, $current[$path] ?? null)) {
                $conflicts[$path] = $current[$path] ?? null;
            }
        }

        return $conflicts;
    }

    /**
     * Whether an expected value matches the stored one. Most fields
     * compare in their stored form (`same()`); a few are shown by wc/v3
     * in another form than they are stored, and the editor sends what it
     * loaded, so either form counts:
     *
     * - `description`: raw, or as wc/v3's view context renders it
     *   (`wpautop(do_shortcode())` for a product, `wc_format_content()`
     *   for a variation);
     * - `short_description`: raw, or through `woocommerce_short_description`;
     * - a variation's `name`: the stored title, or wc/v3's attribute summary
     *   (`wc_get_formatted_variation($v, true, false, false)`);
     * - a variation's `tax_class`: the stored `parent`, or the parent's
     *   class that the view context shows for it;
     * - `cost_of_goods_sold`: by its number, from `{value}`, wc/v3's
     *   `{values: [{defined_value}]}` (summed, as WooCommerce does) or a
     *   bare number; no value is 0;
     * - `images`: the full id list, or only the featured image (the list
     *   rows drop the gallery): a list of at most one entry matches when
     *   it names the stored featured image (or none when there is none).
     *
     * - `attributes` / `default_attributes`: the stored form
     *   (`Recorder::read()`) or wc/v3's (`{id, name, options|option}`),
     *   compared field by field (`attributesMatch()`), never by ids only.
     *
     * The rendered forms are computed only when the plain comparison fails.
     */
    public static function matches(WC_Product $stored, string $path, ?string $expected, ?string $current): bool
    {
        if ($path === 'attributes' || $path === 'default_attributes') {
            return ($expected ?? '') === ($current ?? '') || self::attributesMatch($stored, $path, (string) $expected);
        }

        if (self::same($expected, $current)) {
            return true;
        }

        $expected ??= '';
        $isVariation = $stored->is_type('variation');

        switch ($path) {
            case 'description':
                $raw = (string) $stored->get_description('edit');
                $rendered = $isVariation ? wc_format_content($raw) : wpautop(do_shortcode($raw));

                return trim($expected) === trim((string) $rendered);
            case 'short_description':
                if ($isVariation) {
                    return false;
                }

                return trim($expected) === trim((string) apply_filters('woocommerce_short_description', (string) $stored->get_short_description('edit')));
            case 'name':
                return $isVariation && $stored instanceof \WC_Product_Variation
                    && trim($expected) === trim((string) wc_get_formatted_variation($stored, true, false, false));
            case 'tax_class':
                // A variation's `parent` as wc/v3 shows it in view context:
                // the parent's class.
                return $isVariation && $current === 'parent' && $expected === (string) $stored->get_tax_class('view');
            case 'cost_of_goods_sold':
                $want = self::cogsNumber($expected);
                $have = self::cogsNumber((string) $current);

                return $want !== null && $have !== null && abs($want - $have) < 0.0000001;
            case 'images':
                $list = $expected === '' ? [] : json_decode($expected, true);

                if (! is_array($list) || ! array_is_list($list) || count($list) > 1) {
                    return false;
                }

                $featured = isset($list[0]) && is_array($list[0]) && is_numeric($list[0]['id'] ?? null) ? (int) $list[0]['id'] : 0;

                return $featured === (int) $stored->get_image_id('edit');
        }

        return false;
    }

    /**
     * Whether an expected attribute list matches the stored attributes, in
     * the stored form or in wc/v3's. An attribute is identified by its
     * global attribute id (taxonomy `pa_*`; wc/v3's `id`, or the taxonomy
     * name of the stored form) or, for a custom one, by its sanitised
     * name. Order does not matter.
     *
     * - A product's `attributes`: the same attributes with the same
     *   options (names, any order), visibility, "used for variations" and
     *   position.
     * - A variation's `attributes` and a product's `default_attributes`:
     *   the same attribute => option pairs, an option given as the stored
     *   value (the term slug) or as wc/v3 shows it (the term name); "any"
     *   (empty) options are left out, as wc/v3 leaves them out.
     */
    public static function attributesMatch(WC_Product $stored, string $path, string $expected): bool
    {
        $list = trim($expected) === '' ? [] : json_decode($expected, true);

        if (! is_array($list) || ! array_is_list($list)) {
            return false;
        }

        $key = static function (array $entry): ?string {
            $id = is_numeric($entry['id'] ?? null) ? (int) $entry['id'] : 0;
            $name = is_string($entry['name'] ?? null) ? $entry['name'] : '';

            if ($id <= 0 && str_starts_with($name, 'pa_')) {
                $id = (int) wc_attribute_taxonomy_id_by_name($name);
            }

            if ($id > 0) {
                return 't:'.$id;
            }

            $slug = sanitize_title($name);

            return $slug === '' ? null : 'c:'.$slug;
        };

        $pairs = $path === 'default_attributes' || ($path === 'attributes' && $stored->is_type('variation'));

        if ($pairs) {
            $have = [];
            $source = $path === 'default_attributes' ? $stored->get_default_attributes('edit') : $stored->get_attributes('edit');

            foreach ((array) $source as $name => $option) {
                $option = (string) $option;

                if ($option === '') {
                    continue;
                }

                $name = (string) $name;
                $forms = [$option];

                if (taxonomy_exists($name)) {
                    $term = get_term_by('slug', $option, $name);

                    if ($term instanceof \WP_Term) {
                        $forms[] = $term->name;
                    }
                }

                $id = $key(['name' => $name]);

                if ($id !== null) {
                    $have[$id] = $forms;
                }
            }

            $want = [];

            foreach ($list as $entry) {
                if (! is_array($entry) || ! is_scalar($entry['option'] ?? null)) {
                    return false;
                }

                $option = (string) $entry['option'];

                if ($option === '') {
                    continue;
                }

                $id = $key($entry);

                if ($id === null || isset($want[$id])) {
                    return false;
                }

                $want[$id] = $option;
            }

            if (count($want) !== count($have)) {
                return false;
            }

            foreach ($want as $id => $option) {
                if (! isset($have[$id]) || ! in_array(html_entity_decode($option, ENT_QUOTES), array_map(static fn (string $form): string => html_entity_decode($form, ENT_QUOTES), $have[$id]), true)) {
                    return false;
                }
            }

            return true;
        }

        $shape = static function (string $id, array $options, bool $visible, bool $variation, int $position): string {
            $options = array_map(static fn ($option): string => html_entity_decode(trim((string) $option), ENT_QUOTES), $options);
            sort($options);

            return $id.'|'.wp_json_encode([$options, $visible, $variation, $position]);
        };

        $have = [];

        foreach ($stored->get_attributes('edit') as $attribute) {
            if (! $attribute instanceof \WC_Product_Attribute) {
                continue;
            }

            $id = $attribute->is_taxonomy() ? 't:'.$attribute->get_id() : $key(['name' => $attribute->get_name()]);
            $options = $attribute->is_taxonomy() ? array_map(static fn ($term): string => $term->name, $attribute->get_terms() ?: []) : $attribute->get_options();

            if ($id !== null) {
                $have[] = $shape($id, $options, (bool) $attribute->get_visible(), (bool) $attribute->get_variation(), (int) $attribute->get_position());
            }
        }

        $want = [];

        foreach ($list as $entry) {
            $id = is_array($entry) ? $key($entry) : null;

            if ($id === null || ! is_array($entry['options'] ?? null)) {
                return false;
            }

            $want[] = $shape($id, $entry['options'], (bool) ($entry['visible'] ?? false), (bool) ($entry['variation'] ?? false), (int) ($entry['position'] ?? 0));
        }

        sort($have);
        sort($want);

        return $have === $want;
    }

    /**
     * The number of a cost-of-goods value in any of its forms, null when
     * it is none of them. No value counts as 0, as WooCommerce reads it.
     */
    public static function cogsNumber(string $value): ?float
    {
        $value = trim($value);

        if ($value === '' || $value === 'null') {
            return 0.0;
        }

        if (is_numeric($value)) {
            return (float) $value;
        }

        $decoded = json_decode($value, true);

        if (! is_array($decoded)) {
            return null;
        }

        if (array_key_exists('value', $decoded)) {
            return is_numeric($decoded['value']) ? (float) $decoded['value'] : ($decoded['value'] === null || $decoded['value'] === '' ? 0.0 : null);
        }

        if (is_array($decoded['values'] ?? null)) {
            $sum = 0.0;

            foreach ($decoded['values'] as $info) {
                $sum += is_array($info) && is_numeric($info['defined_value'] ?? null) ? (float) $info['defined_value'] : 0.0;
            }

            return $sum;
        }

        return null;
    }

    /**
     * Whether two stored-form values are the same: null and '' alike,
     * numbers by value ("15" and "15.00"), term and image lists by their
     * ids in any order ([{"id":3,"name":"X"}] and [{"id":3}]).
     */
    public static function same(?string $a, ?string $b): bool
    {
        $a ??= '';
        $b ??= '';

        if ($a === $b) {
            return true;
        }

        if (is_numeric($a) && is_numeric($b)) {
            return abs((float) $a - (float) $b) < 0.0000001;
        }

        $ids = static function (string $value): ?array {
            if ($value === '' || $value[0] !== '[') {
                return null;
            }

            $list = json_decode($value, true);

            if (! is_array($list) || ! array_is_list($list)) {
                return null;
            }

            $out = [];

            foreach ($list as $item) {
                if (! is_array($item) || ! isset($item['id']) || ! is_numeric($item['id'])) {
                    return null;
                }

                $out[] = (int) $item['id'];
            }

            sort($out);

            return $out;
        };

        $left = $ids($a);

        return $left !== null && $left === $ids($b);
    }

    public static function conflictError(int $id, array $conflicts, array $expected): WP_Error
    {
        $labels = array_map([Revert::class, 'fieldLabel'], array_keys($conflicts));

        return new WP_Error(
            self::CONFLICT_ERROR,
            sprintf(
                /* translators: %s: comma-separated field names */
                _n(
                    '%s was changed by someone else since this edit was started. Nothing was saved for this item; reload it and apply the change again.',
                    '%s were changed by someone else since this edit was started. Nothing was saved for this item; reload it and apply the change again.',
                    count($conflicts),
                    'wp-woocommerce-products-list'
                ),
                implode(', ', $labels)
            ),
            [
                'status' => 409,
                'id' => $id,
                'fields' => array_keys($conflicts),
                'current' => $conflicts,
                'expected' => array_intersect_key($expected, $conflicts),
            ]
        );
    }

    public static function lockedError(int $id): WP_Error
    {
        return new WP_Error(
            self::LOCKED_ERROR,
            __('Another save of this item is still running (another tab, another user or an undo). Nothing was saved for this item; try again in a moment.', 'wp-woocommerce-products-list'),
            ['status' => 409, 'id' => $id]
        );
    }

    public static function deletedError(int $id): WP_Error
    {
        return new WP_Error(
            self::DELETED_ERROR,
            __('This item was deleted meanwhile (in another tab or by another user). Nothing was saved for it.', 'wp-woocommerce-products-list'),
            ['status' => 404, 'id' => $id]
        );
    }

    /**
     * The other user who holds WordPress's post lock on an object, or on
     * the parent of a variation (the product editor's variations panel
     * saves them too), 0 when there is none. Core's lock (`_edit_lock`,
     * "time:user", set by post.php and its heartbeat, removed when the
     * screen is left) and core's window (`wp_check_post_lock_window`,
     * 150 s), as wp_check_post_lock() reads them; read from the database,
     * since a heartbeat may have set it after this request primed its
     * caches. The current user's own lock counts too: their product editor
     * in another tab would put its form's values back over the save just
     * the same (an Update re-posts every field of the product data box).
     */
    public static function editingUser(int $id, int $parentId = 0): int
    {
        global $wpdb;

        $ids = array_values(array_filter([$id, $parentId], static fn (int $postId): bool => $postId > 0));

        if ($ids === []) {
            return 0;
        }

        $placeholders = implode(',', array_fill(0, count($ids), '%d'));
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $locks = $wpdb->get_col($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_edit_lock' AND post_id IN ({$placeholders})", ...$ids));

        /** This filter is documented in wp-admin/includes/ajax-actions.php */
        $window = (int) apply_filters('wp_check_post_lock_window', 150);

        foreach (is_array($locks) ? $locks : [] as $lock) {
            $parts = explode(':', (string) $lock);
            $time = (int) $parts[0];
            $user = (int) ($parts[1] ?? 0);

            if ($time > 0 && $user > 0 && $time > time() - $window) {
                return $user;
            }
        }

        return 0;
    }

    public static function editingError(int $id, int $user): WP_Error
    {
        $who = get_userdata($user);

        if ($user === get_current_user_id()) {
            return new WP_Error(
                self::EDITING_ERROR,
                __('You have this product open in the product editor (in another tab or window). Its Update would put the editor\'s values back, so nothing was saved for this item; save or close it there, then try again.', 'wp-woocommerce-products-list'),
                ['status' => 409, 'id' => $id, 'user' => $user]
            );
        }

        return new WP_Error(
            self::EDITING_ERROR,
            sprintf(
                /* translators: %s: user's display name */
                __('%s is editing this product in the product editor. Nothing was saved for this item; try again when they are done.', 'wp-woocommerce-products-list'),
                $who instanceof \WP_User ? $who->display_name : __('Another user', 'wp-woocommerce-products-list')
            ),
            ['status' => 409, 'id' => $id, 'user' => $user]
        );
    }

    /** @var array<string, true> lock names taken by `lockCoreChange()`, released by `unlockCoreChange()` */
    private static array $coreChanges = [];

    /**
     * Core's own trash, restore and delete (wp-admin, WP-CLI, another
     * plugin) wait for a list-mode save of the same product or variation
     * to finish, and a save that starts meanwhile waits for them, then
     * sees the row trashed or gone (§3.6). Without it a save that passed
     * its checks a moment before would write its loaded status back over
     * the Trash (the product published again, its variations left in the
     * Trash) or write meta for a post deleted under it.
     */
    public static function registerCoreChanges(): void
    {
        foreach (['pre_trash_post', 'pre_untrash_post', 'pre_delete_post'] as $filter) {
            add_filter($filter, [self::class, 'lockCoreChange'], 10, 2);
        }

        foreach (['trashed_post', 'untrashed_post', 'deleted_post'] as $action) {
            add_action($action, [self::class, 'unlockCoreChange'], 10, 1);
        }
    }

    /**
     * `pre_{trash,untrash,delete}_post`: take the object's lock (waiting
     * up to `lockTimeout()`); on a timeout the change goes ahead as it
     * would without the plugin. Never changes `$check`.
     */
    public static function lockCoreChange(mixed $check, mixed $post = null): mixed
    {
        if ($check !== null || ! $post instanceof \WP_Post || ! in_array($post->post_type, ['product', 'product_variation'], true)) {
            return $check;
        }

        $name = self::lockName('o', (string) $post->ID);

        if (isset(self::$held[$name])) {
            // This process holds it already (a row action's own object lock).
            return $check;
        }

        if (self::acquire($name, self::lockTimeout()) && isset(self::$held[$name])) {
            self::$coreChanges[$name] = true;
        }

        // Core loaded the post before this filter, and a save may have
        // changed it while this waited: wp_update_post() would write the
        // cached title, content and the rest back with the new status.
        self::forget($post->ID);

        return $check;
    }

    public static function unlockCoreChange(mixed $postId): void
    {
        $name = self::lockName('o', (string) (int) $postId);

        if (isset(self::$coreChanges[$name])) {
            unset(self::$coreChanges[$name]);
            self::release($name);
        }
    }

    public static function trashedError(int $id): WP_Error
    {
        return new WP_Error(
            self::TRASHED_ERROR,
            __('This item is in the Trash. Nothing was saved; restore it first.', 'wp-woocommerce-products-list'),
            ['status' => 409, 'id' => $id]
        );
    }

    /**
     * Whether an object (or the parent of a variation) is in the Trash,
     * by its loaded status.
     */
    public static function trashed(WC_Product $product): bool
    {
        $data = $product->get_data();

        if (($data['status'] ?? '') === 'trash') {
            return true;
        }

        $parent = (int) $product->get_parent_id();

        return $product->is_type('variation') && $parent > 0 && get_post_status($parent) === 'trash';
    }

    /** Seconds a revert keeps its claim on a batch after its last chunk. */
    public const REVERT_CLAIM_TTL = 30;

    /**
     * Claim a batch for one revert: one revert of a batch at a time,
     * server-wide. A revert is posted in chunks, several at once, under
     * one revert batch id: those chunks share the claim, while a revert
     * with another id (another tab, another user) is refused until the
     * claim lapses, `REVERT_CLAIM_TTL` seconds after its last chunk. The
     * claim is a transient, read and written under a short named lock.
     */
    public static function claimRevert(string $batchId, string $revertBatchId): bool
    {
        $name = self::lockName('r', md5($batchId));

        if (! self::acquire($name, 3)) {
            return false;
        }

        try {
            $owner = get_transient(self::revertClaim($batchId));

            if (is_string($owner) && $owner !== '' && $owner !== $revertBatchId) {
                return false;
            }

            set_transient(self::revertClaim($batchId), $revertBatchId, self::REVERT_CLAIM_TTL);

            return true;
        } finally {
            self::release($name);
        }
    }

    /**
     * A chunk of the revert is done: the claim runs from now (`$keep`), or
     * is dropped (a revert posted without its own id is one request).
     */
    public static function releaseRevert(string $batchId, string $revertBatchId, bool $keep): void
    {
        if (get_transient(self::revertClaim($batchId)) !== $revertBatchId) {
            return;
        }

        if ($keep) {
            set_transient(self::revertClaim($batchId), $revertBatchId, self::REVERT_CLAIM_TTL);
        } else {
            delete_transient(self::revertClaim($batchId));
        }
    }

    /**
     * The revert of several requests posted under `$revertBatchId` is
     * closed: the claim it keeps between its chunks is let go at once,
     * rather than `REVERT_CLAIM_TTL` seconds later (a revert started
     * right after, from History or another tab, is not refused as
     * still running).
     */
    public static function releaseRevertOf(string $revertBatchId): void
    {
        $batchId = get_transient(self::revertOf($revertBatchId));

        delete_transient(self::revertOf($revertBatchId));

        if (is_string($batchId) && $batchId !== '') {
            self::releaseRevert($batchId, $revertBatchId, false);
        }
    }

    /** The batch a revert of several requests reverts, kept while it holds the claim. */
    public static function rememberRevertOf(string $revertBatchId, string $batchId): void
    {
        set_transient(self::revertOf($revertBatchId), $batchId, self::REVERT_CLAIM_TTL);
    }

    public static function revertOf(string $revertBatchId): string
    {
        return 'wcpl_revert_of_'.md5($revertBatchId);
    }

    public static function revertClaim(string $batchId): string
    {
        return 'wcpl_revert_'.md5($batchId);
    }

    public static function revertRunningError(): WP_Error
    {
        return new WP_Error(
            self::REVERT_RUNNING_ERROR,
            __('A revert of this batch is already running (in another tab or by another user). Wait for it to finish, then check the batch again.', 'wp-woocommerce-products-list'),
            ['status' => 409]
        );
    }
}
