<?php

namespace GeneroWP\ProductsList\Rest;

use Automattic\WooCommerce\Internal\Caches\ProductCache;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Log\Revert;
use WC_Product;
use WP_Error;

/**
 * Server-side protection of list-mode writes against concurrent edits
 * (docs/contracts.md §3.6). Three small checks, each run in
 * `Saves::preInsert()`, right before WooCommerce saves one product or
 * variation:
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
 * Writes to a product in the Trash (or a variation of one) are refused
 * with `wc_products_list_trashed` (409) unless the request sets `status`.
 */
final class Concurrency
{
    /** The per-item request key with the expected values. */
    public const EXPECT_KEY = '_wcpl_expect';

    public const CONFLICT_ERROR = 'wc_products_list_conflict';

    public const LOCKED_ERROR = 'wc_products_list_locked';

    public const TRASHED_ERROR = 'wc_products_list_trashed';

    public const REVERT_RUNNING_ERROR = 'wc_products_list_revert_running';

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
     * The product WooCommerce is about to save, loaded from the stored
     * state: the object as given when its caches are current, otherwise
     * a fresh load with the request's changes (props and meta) applied.
     */
    public static function refresh(WC_Product $product): WC_Product
    {
        $id = $product->get_id();

        if ($id <= 0 || ! self::stale($id)) {
            return $product;
        }

        self::forget($id);
        $fresh = wc_get_product($id);

        if (! $fresh instanceof WC_Product || get_class($fresh) !== get_class($product)) {
            // A type change is applied as WooCommerce built it.
            return $product;
        }

        $fresh->set_props($product->get_changes());

        foreach ($product->get_meta_data() as $meta) {
            $data = $meta->get_data();

            if (! empty($data['id']) && $meta->get_changes() === []) {
                continue;
            }

            if ($data['value'] === null) {
                $fresh->delete_meta_data((string) $data['key']);
            } else {
                $fresh->update_meta_data((string) $data['key'], $data['value']);
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
            if (! self::same($value, $current[$path] ?? null)) {
                $conflicts[$path] = $current[$path] ?? null;
            }
        }

        return $conflicts;
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
