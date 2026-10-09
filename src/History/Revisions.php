<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\ListMode;
use WC_Product;
use WP_Post;

/**
 * SPIKE: core revisions for WooCommerce products and variations.
 *
 * Core does the work: `revisions` post type support, meta registered with
 * `revisions_enabled`, wp_save_post_revision(), core's meta copy, change
 * check and restore. What is added, and why, is listed in
 * docs/revisions.md:
 *
 * 1. The revision is taken after WooCommerce's save, not during its
 *    wp_update_post (which runs before the meta is written), and core's
 *    revision in between is suppressed with wp_revisions_to_keep = 0.
 * 2. A baseline before the first change of an object with no revision.
 * 3. Terms: a `_wcpl_terms` revision meta snapshot and a change check.
 * 4. Restore re-saves through WooCommerce CRUD before core's raw meta copy.
 */
final class Revisions
{
    public const POST_TYPES = ['product', 'product_variation'];

    public const TERMS_KEY = '_wcpl_terms';

    /** Meta revisioned on both products and variations: what the editor can change. */
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

    public const PRODUCT_TAXONOMIES = ['product_cat', 'product_tag', 'product_brand', 'product_shipping_class', 'product_visibility'];

    public const VARIATION_TAXONOMIES = ['product_shipping_class'];

    /** product_visibility terms that are edited (outofstock and rated-* are derived). */
    public const VISIBILITY_TERMS = ['exclude-from-catalog', 'exclude-from-search', 'featured'];

    /** gds-woo-i18n's translated values, `_i18n_{field}_{lang}` (not its reviewed/machine markers). */
    public const I18N_PATTERN = '/^_i18n_(?!reviewed_|machine_).+_[a-z]{2}$/';

    /**
     * Props whose change alone takes no revision outside an explicit
     * context: what an order (stock), a review (rating) or a sale count
     * writes. Every checkout would otherwise add a revision per line and
     * push a campaign's revisions out of the retention window.
     */
    public const DERIVED_ONLY = ['stock_quantity', 'stock_status', 'date_modified', 'total_sales', 'rating_counts', 'average_rating', 'review_count'];

    /** @var array<int, true> ids being saved through CRUD: core's own revision is suppressed */
    private static array $saving = [];

    /** @var array<int, array<int, string>> id => the fields the pending save changes */
    private static array $pendingFields = [];

    /** @var array<int, true> ids whose pending save takes no revision (DERIVED_ONLY) */
    private static array $skipping = [];

    /** @var array<int, true> ids a REST controller is saving: the revision waits for its insert listeners */
    private static array $rest = [];

    /** @var array<int, array<int, string>> id => fields of a REST save whose revision is deferred */
    private static array $deferred = [];

    /** @var array<int, true> spl_object_id of products being created */
    private static array $creating = [];

    /** Set while a baseline is written: it gets no batch term. */
    private static bool $baseline = false;

    private static bool $inCrudRevision = false;

    /** @var array<int, int> post id => a revision core took outside a CRUD save (restore cleanup) */
    private static array $coreCreated = [];

    /** @var array<string, array<int, string>> post type => meta keys this module registered */
    private static array $registered = [];

    public static function register(): void
    {
        // After WooCommerce registers its post types and attribute
        // taxonomies (init 5), before gds-woo-i18n registers its meta (init 20).
        did_action('init') ? self::registerMeta() : add_action('init', [self::class, 'registerMeta'], 6);
        add_filter('register_meta_args', [self::class, 'i18nArgs'], 10, 4);

        self::hooks(true);
    }

    /**
     * `revisions` support and the revisioned meta, with core's own API.
     */
    public static function registerMeta(): void
    {
        foreach (self::POST_TYPES as $type) {
            add_post_type_support($type, 'revisions');
            $keys = array_merge(self::COMMON_KEYS, $type === 'product_variation' ? self::VARIATION_KEYS : self::PRODUCT_KEYS);

            if ($type === 'product_variation') {
                // Global attributes; a variation of a custom (product-level)
                // attribute keeps `attribute_{name}` unrevisioned (docs/revisions.md).
                foreach (wc_get_attribute_taxonomy_names() as $taxonomy) {
                    $keys[] = 'attribute_'.$taxonomy;
                }
            }

            foreach ($keys as $key) {
                if (registered_meta_key_exists('post', $key, $type)) {
                    continue;
                }

                register_post_meta($type, $key, ['single' => true, 'type' => 'string', 'revisions_enabled' => true]);
                self::$registered[$type][] = $key;
            }
        }
    }

    /** For tests: undo registerMeta(). */
    public static function unregisterMeta(): void
    {
        foreach (self::$registered as $type => $keys) {
            foreach ($keys as $key) {
                unregister_post_meta((string) $type, $key);
            }

            remove_post_type_support((string) $type, 'revisions');
        }

        self::$registered = [];
    }

    /**
     * `register_meta_args`: gds-woo-i18n's translation keys become
     * revisioned. Spike shim: in Phase 1 gds-woo-i18n passes
     * `'revisions_enabled' => true` itself.
     *
     * @param  array<string, mixed>  $args
     * @param  array<string, mixed>  $defaults
     * @return array<string, mixed>
     */
    public static function i18nArgs($args, $defaults, $objectType, $metaKey): array
    {
        $args = (array) $args;

        if ($objectType === 'post' && in_array($args['object_subtype'] ?? '', self::POST_TYPES, true) && preg_match(self::I18N_PATTERN, (string) $metaKey)) {
            $args['revisions_enabled'] = true;
        }

        return $args;
    }

    public static function hooks(bool $on): void
    {
        $add = $on ? 'add_filter' : 'remove_filter';

        // 1. Suppress core's revision during WooCommerce's save; take it after.
        $add('wp_revisions_to_keep', [self::class, 'toKeep'], 99, 2);
        $add('woocommerce_before_product_object_save', [self::class, 'beforeSave'], 99, 1);
        $add('woocommerce_after_product_object_save', [self::class, 'afterSave'], 99, 1);

        // 2. Baseline for the classic editor's wp_update_post, before the row changes.
        $add('pre_post_update', [self::class, 'prePostUpdate'], 1, 1);

        // 3. Terms.
        $add('_wp_put_post_revision', [self::class, 'putRevision'], 20, 2);
        $add('wp_save_post_revision_post_has_changed', [self::class, 'termsChanged'], 20, 3);

        // 4. Restore through CRUD, before core's raw meta copy (10).
        $add('wp_restore_post_revision', [self::class, 'restored'], 5, 2);

        // 5. A REST save: the revision is taken after the controller's insert
        //    listeners (WooCommerce Brands writes `brands` at 10, the log at 20).
        $add('woocommerce_rest_pre_insert_product_object', [self::class, 'restSaving'], PHP_INT_MAX, 1);
        $add('woocommerce_rest_pre_insert_product_variation_object', [self::class, 'restSaving'], PHP_INT_MAX, 1);
        $add('woocommerce_rest_insert_product_object', [self::class, 'restInserted'], 30, 1);
        $add('woocommerce_rest_insert_product_variation_object', [self::class, 'restInserted'], 30, 1);
        $add('rest_request_after_callbacks', [self::class, 'restDone'], 998, 1);

        // 6. Variation descriptions and their translations are not revisioned by default.
        $add('wp_post_revision_meta_keys', [self::class, 'metaKeys'], 10, 2);
    }

    /**
     * `wp_post_revision_meta_keys`: without the `variation_text` option,
     * a variation's revision leaves out its description and translations,
     * most of a revision's size (about 5.7 KB of 6 per variation on the
     * production copy; docs/revisions.md).
     *
     * @param  mixed  $keys
     * @return mixed
     */
    public static function metaKeys($keys, $postType = '')
    {
        if ($postType !== 'product_variation' || ! is_array($keys) || History::options()['variation_text']) {
            return $keys;
        }

        return array_values(array_filter($keys, static fn ($key): bool => $key !== '_variation_description' && preg_match(self::I18N_PATTERN, (string) $key) !== 1));
    }

    /**
     * @param  mixed  $product
     * @return mixed
     */
    public static function restSaving($product)
    {
        if ($product instanceof WC_Product && $product->get_id() > 0) {
            self::$rest[$product->get_id()] = true;
        }

        return $product;
    }

    /**
     * @param  mixed  $product
     */
    public static function restInserted($product): void
    {
        if (! $product instanceof WC_Product) {
            return;
        }

        $id = $product->get_id();
        unset(self::$rest[$id]);

        if (array_key_exists($id, self::$deferred)) {
            $fields = self::$deferred[$id];
            unset(self::$deferred[$id]);
            self::take($id, $fields);
        }
    }

    /**
     * The request is over: a REST save whose insert listeners never ran
     * (an error after the save) still gets its revision.
     *
     * @param  mixed  $response
     * @return mixed
     */
    public static function restDone($response)
    {
        $deferred = self::$deferred;
        self::$deferred = [];
        self::$rest = [];

        foreach ($deferred as $id => $fields) {
            self::take((int) $id, $fields);
        }

        return $response;
    }

    /**
     * Whether the save happens where a revision is wanted for any change:
     * the app, a REST write other than the Store API, a forced batch
     * (undo), WP-CLI, an import or the admin's own screens. Elsewhere
     * (the storefront, a checkout, a cron job) only a change beyond
     * DERIVED_ONLY takes one.
     */
    public static function explicitContext(): bool
    {
        $rest = ListMode::request();

        return ListMode::active()
            // A REST write (wc/v3 by an integration), but not the Store API's checkout.
            || ($rest !== null && ! str_starts_with($rest->get_route(), '/wc/store'))
            || Batches::forced()
            || Batches::importingNow()
            || (defined('WP_CLI') && WP_CLI)
            || (is_admin() && ! wp_doing_ajax() && ! wp_doing_cron());
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
     * The revisioned meta of a live object: key => value, existing keys only.
     *
     * @return array<string, string>
     */
    public static function currentMeta(int $id, ?string $postType = null): array
    {
        $postType ??= (string) get_post_type($id);

        return self::pick((array) get_post_meta($id), $postType);
    }

    /**
     * @param  array<string, array<int, mixed>>  $all
     * @return array<string, string>
     */
    private static function pick(array $all, string $postType): array
    {
        $values = [];

        foreach (wp_post_revision_meta_keys($postType) as $key) {
            if (isset($all[$key][0])) {
                $values[(string) $key] = (string) $all[$key][0];
            }
        }

        ksort($values);

        return $values;
    }

    /**
     * Terms of a live object: taxonomy => sorted term ids, empty ones left out.
     *
     * @return array<string, array<int, int>>
     */
    public static function currentTerms(int $id, ?string $postType = null): array
    {
        $postType ??= (string) get_post_type($id);
        $snapshot = [];

        foreach ($postType === 'product_variation' ? self::VARIATION_TAXONOMIES : self::PRODUCT_TAXONOMIES as $taxonomy) {
            if (! taxonomy_exists($taxonomy)) {
                continue;
            }

            $terms = get_the_terms($id, $taxonomy);
            $ids = [];

            foreach (is_array($terms) ? $terms : [] as $term) {
                if ($taxonomy !== 'product_visibility' || in_array($term->slug, self::VISIBILITY_TERMS, true)) {
                    $ids[] = (int) $term->term_id;
                }
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
     * What a revision holds: its revisioned meta and its terms.
     *
     * @return array{meta: array<string, string>, terms: array<string, array<int, int>>}
     */
    public static function revisionSnapshot(int $revisionId, int $postId): array
    {
        $all = (array) get_metadata('post', $revisionId);
        $terms = json_decode((string) ($all[self::TERMS_KEY][0] ?? ''), true);
        $terms = is_array($terms) ? $terms : [];
        ksort($terms);

        return ['meta' => self::pick($all, (string) get_post_type($postId)), 'terms' => $terms];
    }

    /**
     * `_wp_put_post_revision`, 20 (after core copied the meta at 10):
     * the terms snapshot and the batch term.
     */
    public static function putRevision(int $revisionId, int $postId = 0): void
    {
        $postId = $postId > 0 ? $postId : (int) wp_get_post_parent_id($revisionId);

        if (! self::isOurs($postId)) {
            return;
        }

        $terms = self::currentTerms($postId);

        if ($terms !== []) {
            // add_metadata, not add_post_meta: the latter writes to the parent of a revision.
            add_metadata('post', $revisionId, self::TERMS_KEY, wp_slash((string) wp_json_encode($terms)));
        }

        if (self::$baseline) {
            return;
        }

        if (! self::$inCrudRevision) {
            self::$coreCreated[$postId] = $revisionId;
        }

        Batches::assign($revisionId);
    }

    /**
     * `wp_save_post_revision_post_has_changed`, 20 (core's meta check is at 10).
     *
     * @param  mixed  $changed
     */
    public static function termsChanged($changed, WP_Post $latest, WP_Post $post): bool
    {
        if ($changed || ! in_array($post->post_type, self::POST_TYPES, true)) {
            return (bool) $changed;
        }

        return self::revisionSnapshot($latest->ID, $post->ID)['terms'] !== self::currentTerms($post->ID, $post->post_type);
    }

    /**
     * Revision ids of a post, newest first. Core's own lookup; it answers
     * nothing while revisions are off for the post (during a CRUD save).
     *
     * @return array<int, int>
     */
    public static function revisionIds(int $postId, int $limit = -1): array
    {
        return array_values(array_map('intval', wp_get_post_revisions($postId, ['fields' => 'ids', 'posts_per_page' => $limit])));
    }

    public static function hasRevision(int $postId): bool
    {
        return wp_get_post_revisions($postId, ['fields' => 'ids', 'posts_per_page' => 1]) !== [];
    }

    public static function forget(): void
    {
        self::$saving = [];
        self::$pendingFields = [];
        self::$coreCreated = [];
        self::$creating = [];
        self::$skipping = [];
        self::$rest = [];
        self::$deferred = [];
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
            $data = $meta->get_data();

            if (empty($data['id']) || $meta->get_changes() !== []) {
                $fields[] = 'meta:'.$data['key'];
            }
        }

        return array_values(array_unique(array_map('strval', $fields)));
    }

    /**
     * @param  mixed  $product
     */
    public static function beforeSave($product): void
    {
        if (! $product instanceof WC_Product) {
            return;
        }

        if ($product->get_id() <= 0) {
            // A create takes no revision: the first change puts the created state down as the baseline.
            self::$creating[spl_object_id($product)] = true;

            return;
        }

        $post = get_post($product->get_id());

        if (! $post instanceof WP_Post || ! in_array($post->post_type, self::POST_TYPES, true)) {
            return;
        }

        $fields = self::changedFields($product);

        // Nothing tracked changed or only DERIVED_ONLY: an order's stock change
        // (written with SQL before the save), a review's rating. No revision, no batch term.
        if (array_diff($fields, self::DERIVED_ONLY) === [] && ! self::explicitContext()) {
            self::$skipping[$post->ID] = true;
            self::$saving[$post->ID] = true;

            return;
        }

        unset(self::$skipping[$post->ID]);
        self::$pendingFields[$post->ID] = $fields;

        // Before the flag: while it is set, core reports no revisions (toKeep() is 0).
        if ($fields !== [] && $post->post_status !== 'auto-draft') {
            self::baseline($post);
        }

        self::$saving[$post->ID] = true;
    }

    /**
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

        if (isset(self::$skipping[$id])) {
            unset(self::$skipping[$id], self::$pendingFields[$id]);

            return;
        }

        $fields = self::$pendingFields[$id] ?? [];
        unset(self::$pendingFields[$id]);

        if (isset(self::$rest[$id])) {
            // After the REST controller's insert listeners (restInserted()).
            unset(self::$rest[$id]);
            self::$deferred[$id] = array_values(array_unique(array_merge(self::$deferred[$id] ?? [], $fields)));

            return;
        }

        self::take($id, $fields);
    }

    /**
     * Take the revision of a CRUD save (core's wp_save_post_revision()).
     *
     * @param  array<int, string>  $fields
     */
    public static function take(int $id, array $fields): void
    {
        // Nothing changed and nothing recorded: core would take a first
        // revision of an unchanged object.
        if ($fields === [] && ! self::hasRevision($id)) {
            return;
        }

        self::$inCrudRevision = true;

        try {
            $revisionId = (int) wp_save_post_revision($id);
        } finally {
            self::$inCrudRevision = false;
        }

        if ($revisionId > 0) {
            Batches::addFields($fields === [] ? ['terms'] : $fields);
        }
    }

    public static function prePostUpdate(int $postId): void
    {
        if (isset(self::$saving[$postId])) {
            return;
        }

        $post = get_post($postId);

        if ($post instanceof WP_Post && in_array($post->post_type, self::POST_TYPES, true) && $post->post_status !== 'auto-draft') {
            self::baseline($post);
        }
    }

    public static function baseline(WP_Post $post): void
    {
        if (self::hasRevision($post->ID)) {
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
     * `wp_restore_post_revision`, 5: core restored the post fields with
     * wp_update_post; the meta and terms go through CRUD so WooCommerce
     * keeps `_price`, the parent's range and the lookup tables right.
     * Core's raw meta copy at 10 then writes the same values again.
     */
    public static function restored(int $postId, int $revisionId): void
    {
        if (! self::isOurs($postId)) {
            return;
        }

        // Core's wp_update_post took a revision with the restored post
        // fields and the old meta; the CRUD save below takes the right one.
        if (isset(self::$coreCreated[$postId]) && self::$coreCreated[$postId] !== $revisionId) {
            wp_delete_post_revision(self::$coreCreated[$postId]);
            unset(self::$coreCreated[$postId]);
        }

        Restore::toRevision($postId, $revisionId);
    }
}
