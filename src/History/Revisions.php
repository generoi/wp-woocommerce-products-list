<?php

namespace GeneroWP\ProductsList\History;

use Genero\WooI18n\Meta;
use Genero\WooI18n\Plugin;
use WC_Product;
use WP_Post;

/**
 * SPIKE: revisions that match what WooCommerce saved.
 *
 * - The revision is taken on `woocommerce_after_product_object_save`
 *   (priority 99, products and variations alike), when meta and terms are
 *   written. Core's own revision during WooCommerce's `wp_update_post`
 *   would copy the meta one save behind, so it is suppressed with a
 *   per-id flag that makes `wp_revisions_to_keep` 0 for the duration.
 * - Before the first change of an object that has no revision yet, the
 *   pre-save state is put down as a baseline (`_wp_put_post_revision`),
 *   so the first change can be undone.
 * - The revisioned keys are WooCommerce's editable product meta, the
 *   variation's `attribute_*` keys and whatever
 *   `wc_products_list/revision_meta_keys` adds (gds-woo-i18n's
 *   `_i18n_{field}_{lang}`). Terms are a `_wcpl_terms` JSON snapshot.
 * - Revision meta is written with one INSERT per revision (core copies
 *   key by key with add_metadata()).
 */
final class Revisions
{
    public const POST_TYPES = ['product', 'product_variation'];

    public const TERMS_KEY = '_wcpl_terms';

    public const PACKED_KEY = '_wcpl_snapshot';

    public const FILTER_META_KEYS = 'wc_products_list/revision_meta_keys';

    /** Keys revisioned on both products and variations. */
    public const COMMON_KEYS = [
        '_sku', '_global_unique_id',
        '_regular_price', '_sale_price', '_sale_price_dates_from', '_sale_price_dates_to',
        '_manage_stock', '_stock', '_stock_status', '_backorders', '_low_stock_amount',
        '_weight', '_length', '_width', '_height',
        '_tax_class', '_thumbnail_id', '_virtual', '_downloadable',
    ];

    public const PRODUCT_KEYS = [
        '_tax_status', '_sold_individually', '_product_image_gallery', '_purchase_note',
        '_default_attributes', '_upsell_ids', '_crosssell_ids',
    ];

    public const VARIATION_KEYS = ['_variation_description'];

    /** Taxonomies whose state a revision snapshots, per post type. */
    public const PRODUCT_TAXONOMIES = ['product_cat', 'product_tag', 'product_brand', 'product_shipping_class', 'product_visibility'];

    public const VARIATION_TAXONOMIES = ['product_shipping_class'];

    /** product_visibility terms that are edited (the others are derived from stock and ratings). */
    public const VISIBILITY_TERMS = ['exclude-from-catalog', 'exclude-from-search', 'featured'];

    /** @var array<int, true> ids being saved through CRUD: core's own revision is suppressed */
    private static array $saving = [];

    /** @var array<int, array<int, string>> id => the fields the pending save changes */
    private static array $pendingFields = [];

    /** @var array<int, array<int, int>> id => revision ids, newest first (per-request memo) */
    private static array $memo = [];

    /** @var array<int, true> spl_object_id of products being created */
    private static array $creating = [];

    /** Set while a baseline is written: it gets no batch term. */
    private static bool $baseline = false;

    /** @var array<int, int> post id => the last revision core created outside a CRUD save (for restore cleanup) */
    private static array $coreCreated = [];

    private static bool $inCrudRevision = false;

    /** @var array<int, int> revision ids created in this request, for tests and the benchmark */
    public static array $created = [];

    public static function register(): void
    {
        if (! did_action('init')) {
            add_action('init', static function (): void {
                foreach (self::POST_TYPES as $type) {
                    add_post_type_support($type, 'revisions');
                }
            }, 20);
        }

        self::hooks(true);
    }

    /**
     * Add (or, for tests, remove) the hooks; core's own meta copy, change
     * check and meta restore are swapped out for ours and back.
     */
    public static function hooks(bool $on): void
    {
        $add = $on ? 'add_filter' : 'remove_filter';
        $core = $on ? 'remove_filter' : 'add_filter';

        $add('wp_revisions_to_keep', [self::class, 'toKeep'], 99, 2);
        $add('wp_post_revision_meta_keys', [self::class, 'coreMetaKeys'], 10, 2);

        // Core's per-key meta copy, change check and raw meta restore are
        // replaced for products and variations, and left alone otherwise.
        $core('_wp_put_post_revision', 'wp_save_revisioned_meta_fields', 10, 2);
        $add('_wp_put_post_revision', [self::class, 'writeRevisionMeta'], 10, 2);
        $core('wp_save_post_revision_post_has_changed', 'wp_check_revisioned_meta_fields_have_changed', 10, 3);
        $add('wp_save_post_revision_post_has_changed', [self::class, 'hasChanged'], 10, 3);
        $core('wp_restore_post_revision', 'wp_restore_post_revision_meta', 10, 2);
        $add('wp_restore_post_revision', [self::class, 'restored'], 10, 2);

        $add('_wp_put_post_revision', [self::class, 'putRevision'], 20, 2);
        $add('wp_delete_post_revision', [self::class, 'deletedRevision'], 10, 2);

        $add('woocommerce_before_product_object_save', [self::class, 'beforeSave'], 99, 1);
        $add('woocommerce_after_product_object_save', [self::class, 'afterSave'], 99, 1);

        // The classic editor writes post fields with wp_update_post before
        // WooCommerce's meta box saves: the baseline has to come first.
        $add('pre_post_update', [self::class, 'prePostUpdate'], 1, 1);

        $add(self::FILTER_META_KEYS, [self::class, 'i18nKeys'], 5, 2);

        if (did_action('init')) {
            foreach (self::POST_TYPES as $type) {
                $on ? add_post_type_support($type, 'revisions') : remove_post_type_support($type, 'revisions');
            }
        }
    }

    public static function isOurs(mixed $post): bool
    {
        $type = $post instanceof WP_Post ? $post->post_type : get_post_type((int) $post);

        return in_array($type, self::POST_TYPES, true);
    }

    /**
     * @param  mixed  $num
     * @param  mixed  $post
     */
    public static function toKeep($num, $post): int
    {
        if (! $post instanceof WP_Post || ! in_array($post->post_type, self::POST_TYPES, true)) {
            return (int) $num;
        }

        if (isset(self::$saving[$post->ID])) {
            return 0;
        }

        $options = History::options();

        return $post->post_type === 'product_variation' ? $options['keep_variation'] : $options['keep_product'];
    }

    /**
     * Core's list of revisioned keys (used by its compare and restore
     * code): the static keys. `attribute_*` and the filter's keys are
     * per object and added where the object is known.
     *
     * @param  mixed  $keys
     * @return array<int, string>
     */
    public static function coreMetaKeys($keys, string $postType): array
    {
        $keys = is_array($keys) ? $keys : [];

        if (! in_array($postType, self::POST_TYPES, true)) {
            return $keys;
        }

        return array_values(array_unique(array_merge($keys, self::staticKeys($postType))));
    }

    /**
     * @return array<int, string>
     */
    public static function staticKeys(string $postType): array
    {
        $keys = array_merge(self::COMMON_KEYS, $postType === 'product_variation' ? self::VARIATION_KEYS : self::PRODUCT_KEYS);

        /**
         * Filters the meta keys revisioned for products or variations.
         *
         * @param  array<int, string>  $keys
         * @param  string  $postType
         */
        return array_values(array_unique((array) apply_filters(self::FILTER_META_KEYS, $keys, $postType)));
    }

    /**
     * gds-woo-i18n's translation keys. In Phase 1 this filter callback
     * belongs in gds-woo-i18n; here it is a compat shim so the spike can
     * be measured without touching that plugin.
     *
     * @param  array<int, string>  $keys
     * @return array<int, string>
     */
    public static function i18nKeys(array $keys, string $postType): array
    {
        if (! class_exists('Genero\\WooI18n\\Plugin') || ! class_exists('Genero\\WooI18n\\Meta')) {
            return $keys;
        }

        static $cache = [];

        if (! isset($cache[$postType])) {
            $cache[$postType] = [];

            try {
                $plugin = Plugin::getInstance();

                foreach (array_keys($plugin->meta()->fields($postType)) as $field) {
                    foreach ($plugin->languages()->others() as $lang) {
                        $cache[$postType][] = Meta::key((string) $field, (string) $lang);
                    }
                }
            } catch (\Throwable) {
                $cache[$postType] = [];
            }
        }

        return array_merge($keys, $cache[$postType]);
    }

    /**
     * The revisioned meta of a live product or variation: key => value,
     * only keys that exist (as core copies them).
     *
     * @return array<string, string>
     */
    public static function currentMeta(int $id, ?string $postType = null): array
    {
        $postType ??= (string) get_post_type($id);
        $all = get_post_meta($id);
        $all = is_array($all) ? $all : [];
        $values = [];

        foreach (self::staticKeys($postType) as $key) {
            if (isset($all[$key][0])) {
                $values[$key] = (string) $all[$key][0];
            }
        }

        if ($postType === 'product_variation') {
            foreach ($all as $key => $list) {
                if (str_starts_with((string) $key, 'attribute_') && isset($list[0])) {
                    $values[(string) $key] = (string) $list[0];
                }
            }
        }

        ksort($values);

        return $values;
    }

    /**
     * The terms of a live object: taxonomy => sorted term ids, empty
     * taxonomies left out.
     *
     * @return array<string, array<int, int>>
     */
    public static function currentTerms(int $id, ?string $postType = null): array
    {
        $postType ??= (string) get_post_type($id);
        $taxonomies = $postType === 'product_variation' ? self::VARIATION_TAXONOMIES : self::PRODUCT_TAXONOMIES;
        $snapshot = [];

        foreach ($taxonomies as $taxonomy) {
            if (! taxonomy_exists($taxonomy)) {
                continue;
            }

            $terms = get_the_terms($id, $taxonomy);

            if (! is_array($terms) || $terms === []) {
                continue;
            }

            $ids = [];

            foreach ($terms as $term) {
                if ($taxonomy === 'product_visibility' && ! in_array($term->slug, self::VISIBILITY_TERMS, true)) {
                    continue;
                }

                $ids[] = (int) $term->term_id;
            }

            if ($ids !== []) {
                sort($ids);
                $snapshot[$taxonomy] = $ids;
            }
        }

        ksort($snapshot);

        return $snapshot;
    }

    /**
     * What a revision holds: meta (revisioned keys) and terms.
     *
     * @return array{meta: array<string, string>, terms: array<string, array<int, int>>}
     */
    public static function revisionSnapshot(int $revisionId): array
    {
        $all = get_metadata('post', $revisionId);
        $all = is_array($all) ? $all : [];

        if (isset($all[self::PACKED_KEY][0])) {
            $packed = json_decode((string) $all[self::PACKED_KEY][0], true);

            return [
                'meta' => is_array($packed['meta'] ?? null) ? array_map('strval', $packed['meta']) : [],
                'terms' => is_array($packed['terms'] ?? null) ? $packed['terms'] : [],
            ];
        }

        $meta = [];
        $terms = [];

        foreach ($all as $key => $list) {
            if ($key === self::TERMS_KEY) {
                $decoded = json_decode((string) ($list[0] ?? ''), true);
                $terms = is_array($decoded) ? $decoded : [];

                continue;
            }

            if (str_starts_with((string) $key, '_wcpl_') || ! isset($list[0])) {
                continue;
            }

            $meta[(string) $key] = (string) $list[0];
        }

        ksort($meta);
        ksort($terms);

        return ['meta' => $meta, 'terms' => $terms];
    }

    /**
     * Replaces core's `wp_save_revisioned_meta_fields` (`_wp_put_post_revision`, 10).
     */
    public static function writeRevisionMeta(int $revisionId, int $postId = 0): void
    {
        global $wpdb;

        $postId = $postId > 0 ? $postId : (int) wp_get_post_parent_id($revisionId);

        if (! self::isOurs($postId)) {
            wp_save_revisioned_meta_fields($revisionId, $postId);

            return;
        }

        $postType = (string) get_post_type($postId);
        $meta = self::currentMeta($postId, $postType);
        $terms = self::currentTerms($postId, $postType);
        $rows = [];

        if (History::options()['storage'] === 'packed') {
            $rows[self::PACKED_KEY] = (string) wp_json_encode(['meta' => $meta, 'terms' => $terms]);
        } else {
            $rows = $meta;

            if ($terms !== []) {
                $rows[self::TERMS_KEY] = (string) wp_json_encode($terms);
            }
        }

        if ($rows === []) {
            return;
        }

        $values = [];

        foreach ($rows as $key => $value) {
            $values[] = $wpdb->prepare('(%d, %s, %s)', $revisionId, $key, $value);
        }

        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $wpdb->query("INSERT INTO {$wpdb->postmeta} (post_id, meta_key, meta_value) VALUES ".implode(',', $values));
        wp_cache_delete($revisionId, 'post_meta');
    }

    /**
     * Replaces core's `wp_check_revisioned_meta_fields_have_changed`.
     *
     * @param  mixed  $changed
     */
    public static function hasChanged($changed, WP_Post $latest, WP_Post $post): bool
    {
        if (! in_array($post->post_type, self::POST_TYPES, true)) {
            return wp_check_revisioned_meta_fields_have_changed((bool) $changed, $latest, $post);
        }

        if ($changed) {
            return true;
        }

        return self::snapshotDiffers($post->ID, $post->post_type, $latest->ID);
    }

    public static function snapshotDiffers(int $postId, string $postType, int $revisionId): bool
    {
        $revision = self::revisionSnapshot($revisionId);

        return $revision['meta'] !== self::currentMeta($postId, $postType)
            || $revision['terms'] !== self::currentTerms($postId, $postType);
    }

    /**
     * `_wp_put_post_revision`, 20: memo, batch term.
     */
    public static function putRevision(int $revisionId, int $postId = 0): void
    {
        $postId = $postId > 0 ? $postId : (int) wp_get_post_parent_id($revisionId);

        if (! self::isOurs($postId)) {
            return;
        }

        if (isset(self::$memo[$postId])) {
            array_unshift(self::$memo[$postId], $revisionId);
        }

        self::$created[] = $revisionId;

        if (self::$baseline) {
            return;
        }

        if (! self::$inCrudRevision) {
            self::$coreCreated[$postId] = $revisionId;
        }

        Batches::assign($revisionId);
    }

    /**
     * @param  mixed  $revision
     */
    public static function deletedRevision(int $revisionId, $revision = null): void
    {
        $parent = $revision instanceof WP_Post ? (int) $revision->post_parent : 0;

        if ($parent > 0 && isset(self::$memo[$parent])) {
            self::$memo[$parent] = array_values(array_diff(self::$memo[$parent], [$revisionId]));
        }
    }

    /**
     * Revision ids of a post, newest first (autosaves left out).
     *
     * @return array<int, int>
     */
    public static function revisionIds(int $postId): array
    {
        global $wpdb;

        if (! isset(self::$memo[$postId])) {
            $ids = $wpdb->get_col($wpdb->prepare(
                "SELECT ID FROM {$wpdb->posts} WHERE post_parent = %d AND post_type = 'revision' AND post_name NOT LIKE %s ORDER BY ID DESC",
                $postId,
                '%autosave%'
            ));
            self::$memo[$postId] = array_map('intval', $ids);
        }

        return self::$memo[$postId];
    }

    /**
     * Load the revision id lists of many posts in one query.
     *
     * @param  array<int, int>  $postIds
     */
    public static function primeRevisionIds(array $postIds): void
    {
        global $wpdb;

        $postIds = array_values(array_diff(array_unique(array_map('intval', $postIds)), array_keys(self::$memo)));

        if ($postIds === []) {
            return;
        }

        foreach ($postIds as $id) {
            self::$memo[$id] = [];
        }

        $in = implode(',', $postIds);
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $rows = $wpdb->get_results("SELECT ID, post_parent FROM {$wpdb->posts} WHERE post_parent IN ({$in}) AND post_type = 'revision' AND post_name NOT LIKE '%autosave%' ORDER BY ID DESC");

        foreach ((array) $rows as $row) {
            self::$memo[(int) $row->post_parent][] = (int) $row->ID;
        }
    }

    public static function forget(): void
    {
        self::$memo = [];
        self::$saving = [];
        self::$pendingFields = [];
        self::$coreCreated = [];
        self::$created = [];
        self::$creating = [];
    }

    /**
     * The props and meta keys a pending CRUD save changes.
     *
     * @return array<int, string>
     */
    public static function changedFields(WC_Product $product): array
    {
        $fields = array_keys($product->get_changes());

        foreach ($product->get_meta_data() as $meta) {
            if (! $meta instanceof \WC_Meta_Data) {
                continue;
            }

            $data = $meta->get_data();

            if (empty($data['id']) || $meta->get_changes() !== []) {
                $fields[] = 'meta:'.$data['key'];
            }
        }

        return array_values(array_unique(array_map('strval', $fields)));
    }

    /**
     * `woocommerce_before_product_object_save`, 99.
     *
     * @param  mixed  $product
     */
    public static function beforeSave($product): void
    {
        if (! $product instanceof WC_Product) {
            return;
        }

        if ($product->get_id() <= 0) {
            // Creating: the first change of the object puts the created
            // state down as its baseline, so a create costs nothing here.
            self::$creating[spl_object_id($product)] = true;

            return;
        }

        $id = $product->get_id();
        $post = get_post($id);

        if (! $post instanceof WP_Post || ! in_array($post->post_type, self::POST_TYPES, true)) {
            return;
        }

        self::$saving[$id] = true;
        $fields = self::changedFields($product);
        self::$pendingFields[$id] = $fields;

        if ($fields !== [] && $post->post_status !== 'auto-draft') {
            self::baseline($post);
        }
    }

    /**
     * `woocommerce_after_product_object_save`, 99.
     *
     * @param  mixed  $product
     */
    public static function afterSave($product): void
    {
        if (! $product instanceof WC_Product || $product->get_id() <= 0) {
            return;
        }

        $id = $product->get_id();
        unset(self::$saving[$id]);

        if (isset(self::$creating[spl_object_id($product)])) {
            unset(self::$creating[spl_object_id($product)]);

            return;
        }

        if (! self::isOurs($id)) {
            return;
        }

        $fields = self::$pendingFields[$id] ?? [];
        unset(self::$pendingFields[$id]);

        // Nothing changed and nothing recorded yet: core would take a
        // first revision of an unchanged object; the first change will
        // take the baseline instead.
        if ($fields === [] && self::revisionIds($id) === []) {
            return;
        }

        $revisionId = self::save($id);

        if ($revisionId > 0) {
            Batches::addFields($fields === [] ? ['create'] : $fields);
        }
    }

    /**
     * `pre_post_update`: an update through wp_update_post (the classic
     * editor, quick edit) of an object with no revision gets its baseline
     * before the post row changes.
     */
    public static function prePostUpdate(int $postId): void
    {
        if (isset(self::$saving[$postId])) {
            return;
        }

        $post = get_post($postId);

        if (! $post instanceof WP_Post || ! in_array($post->post_type, self::POST_TYPES, true) || $post->post_status === 'auto-draft') {
            return;
        }

        self::baseline($post);
    }

    /**
     * Put the stored (pre-save) state down as the first revision, when
     * the object has none.
     */
    public static function baseline(WP_Post $post): void
    {
        if (self::revisionIds($post->ID) !== []) {
            return;
        }

        self::$baseline = true;

        try {
            _wp_put_post_revision($post);
        } finally {
            self::$baseline = false;
        }
    }

    /**
     * Take the revision of what was just saved. Returns the revision id,
     * or 0 when nothing changed.
     */
    public static function save(int $id): int
    {
        self::$inCrudRevision = true;

        try {
            return History::options()['writer'] === 'lean' ? self::saveLean($id) : (int) wp_save_post_revision($id);
        } finally {
            self::$inCrudRevision = false;
        }
    }

    /**
     * Same result as wp_save_post_revision() for our types, with id-only
     * lookups: the memo gives the latest revision and the count.
     */
    private static function saveLean(int $id): int
    {
        $post = get_post($id);

        if (! $post instanceof WP_Post || $post->post_status === 'auto-draft' || ! wp_revisions_enabled($post)) {
            return 0;
        }

        $ids = self::revisionIds($id);

        if ($ids !== []) {
            $latest = get_post($ids[0]);

            if ($latest instanceof WP_Post) {
                $changed = false;

                foreach (array_keys(_wp_post_revision_fields($post)) as $field) {
                    if (normalize_whitespace(maybe_serialize($post->$field)) !== normalize_whitespace(maybe_serialize($latest->$field))) {
                        $changed = true;

                        break;
                    }
                }

                if (! $changed && ! self::snapshotDiffers($id, $post->post_type, $latest->ID)) {
                    return 0;
                }
            }
        }

        $revisionId = _wp_put_post_revision($post);

        if (! is_int($revisionId) || $revisionId <= 0) {
            return 0;
        }

        $keep = wp_revisions_to_keep($post);
        $ids = self::revisionIds($id);

        if ($keep >= 0 && count($ids) > $keep) {
            foreach (array_slice($ids, $keep) as $old) {
                wp_delete_post_revision($old);
            }
        }

        return $revisionId;
    }

    /**
     * `wp_restore_post_revision`: core restored the post fields with
     * wp_update_post; the rest goes through WooCommerce CRUD so derived
     * data (`_price`, the parent's range, lookup tables) follows.
     */
    public static function restored(int $postId, int $revisionId): void
    {
        if (! self::isOurs($postId)) {
            wp_restore_post_revision_meta($postId, $revisionId);

            return;
        }

        // The revision core took during its wp_update_post holds the
        // restored post fields with the old meta: it is replaced by the
        // one the CRUD save below takes.
        if (isset(self::$coreCreated[$postId]) && self::$coreCreated[$postId] !== $revisionId) {
            wp_delete_post_revision(self::$coreCreated[$postId]);
            unset(self::$coreCreated[$postId]);
        }

        Restore::toRevision($postId, $revisionId);
    }
}
