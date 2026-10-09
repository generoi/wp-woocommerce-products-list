<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\Rest\Concurrency;
use WC_Product;
use WC_Product_Variation;
use WP_Post;

/**
 * SPIKE: undo a batch (and core's Restore button) through WooCommerce CRUD.
 *
 * Undoing a batch restores, per object, the revision before the batch's
 * first revision of it (its predecessor), for the keys that differ
 * between that predecessor and the batch's last revision. Values are
 * mapped to WooCommerce props and saved, so `_price`, the variable
 * parent's price range and the lookup tables are maintained by
 * WooCommerce. The writes take new revisions under a new batch term with
 * `reverts`, so an undo can itself be undone (redo).
 *
 * A key whose current value is no longer what the batch left is a
 * conflict: the object is left alone unless forced. Each object is
 * checked and written under its `Rest\Concurrency` object lock, from
 * the stored state, so a save made while the undo runs is either
 * finished first (and then a conflict) or waits for the undo; an object
 * still locked after the lock timeout is skipped with reason `locked`.
 */
final class Restore
{
    public const CHUNK = 100;

    public const POST_FIELDS = ['post_title' => 'name', 'post_content' => 'description', 'post_excerpt' => 'short_description'];

    /**
     * The objects of a batch, in undo order.
     *
     * @return array<int, array<int, int>> object id => revision ids of the batch (ascending)
     */
    public static function objects(string $uuid): array
    {
        $objects = [];

        foreach (Batches::revisions($uuid) as $row) {
            $objects[$row['parent']][] = $row['id'];
        }

        return $objects;
    }

    /**
     * Undo one chunk of a batch.
     *
     * @param  array{offset?: int, limit?: int, force?: bool, dry?: bool, batch?: string|null}  $args
     * @return array{batch: string, total: int, pruned: int, next: ?int, restored: array<int, int>, unchanged: array<int, int>, conflicts: array<int, array{id: int, keys: array<int, string>}>, skipped: array<int, array{id: int, reason: string}>}
     */
    public static function undo(string $uuid, array $args = []): array
    {
        $offset = (int) ($args['offset'] ?? 0);
        $limit = (int) ($args['limit'] ?? self::CHUNK);
        $force = (bool) ($args['force'] ?? false);
        $dry = (bool) ($args['dry'] ?? false);
        $batch = (string) ($args['batch'] ?? '') !== '' ? (string) $args['batch'] : wp_generate_uuid4();

        $objects = self::objects($uuid);
        $total = count($objects);
        $chunk = array_slice($objects, $offset, $limit, true);
        $result = ['batch' => $batch, 'total' => $total, 'pruned' => self::pruned($uuid, $objects), 'next' => $offset + $limit < $total ? $offset + $limit : null, 'restored' => [], 'unchanged' => [], 'conflicts' => [], 'skipped' => []];

        if ($chunk === []) {
            return $result;
        }

        $ids = array_map('intval', array_keys($chunk));
        $pairs = self::pairs($chunk);
        $load = [];

        foreach ($ids as $id) {
            if (! isset($pairs[$id])) {
                $result['skipped'][] = ['id' => $id, 'reason' => 'no_predecessor'];

                continue;
            }

            $load[] = $pairs[$id][0];
            $load[] = $pairs[$id][1];
        }

        _prime_post_caches(array_merge($ids, $load), true, true);
        update_meta_cache('post', $load);

        if (! $dry) {
            Batches::begin($batch, 'revert', $uuid);
        }

        try {
            foreach ($pairs as $id => [$predecessor, $last]) {
                $before = self::state($predecessor, $id);
                $after = self::state($last, $id);
                $keys = self::diffKeys($before, $after);

                if ($keys === []) {
                    $result['unchanged'][] = $id;

                    continue;
                }

                // Under the object lock every list-mode save takes
                // (Rest\Concurrency, docs/contracts.md §3.6), and from the
                // stored state rather than the caches primed for the chunk:
                // a save of the object made since then is a conflict, and
                // one running now finishes first.
                if (! $dry && ! Concurrency::lockObject($id)) {
                    $result['skipped'][] = ['id' => $id, 'reason' => 'locked'];

                    continue;
                }

                try {
                    if (! $dry) {
                        Concurrency::forget($id);
                    }

                    // Another user's open product editor would put its
                    // values back over the undo (docs/contracts.md §3.6).
                    if (Concurrency::editingUser($id, (int) wp_get_post_parent_id($id)) > 0) {
                        $result['skipped'][] = ['id' => $id, 'reason' => 'editing'];

                        continue;
                    }

                    if (! $force) {
                        $current = self::current($id);
                        $conflicts = [];

                        foreach ($keys as $key) {
                            $name = explode(':', $key, 2)[1];

                            if (self::normal($name, self::value($current, $key)) !== self::normal($name, self::value($after, $key))) {
                                $conflicts[] = $key;
                            }
                        }

                        if ($conflicts !== []) {
                            $result['conflicts'][] = ['id' => $id, 'keys' => $conflicts];

                            continue;
                        }
                    }

                    if ($dry) {
                        $result['restored'][] = $id;

                        continue;
                    }

                    if (self::apply($id, $before, $keys)) {
                        $result['restored'][] = $id;
                    } else {
                        $result['skipped'][] = ['id' => $id, 'reason' => 'missing'];
                    }
                } finally {
                    Concurrency::unlockObject($id);
                }
            }

            if (! $dry && class_exists(\WC_Post_Data::class)) {
                \WC_Post_Data::do_deferred_product_sync();
            }
        } finally {
            if (! $dry) {
                Batches::end();
            }
        }

        return $result;
    }

    /**
     * Revisions of the batch that retention (or a purge) deleted since it
     * was recorded: they can no longer be undone.
     *
     * @param  array<int, array<int, int>>  $objects  object id => the batch's revision ids still there
     */
    public static function pruned(string $uuid, array $objects): int
    {
        $left = array_sum(array_map('count', $objects));

        return max(0, Batches::recorded($uuid) - $left);
    }

    /**
     * Per object: the revision before the batch's first one of it and the
     * batch's last one. Objects without a predecessor (pruned, or no
     * baseline) are left out.
     *
     * @param  array<int, array<int, int>>  $objects  object id => the batch's revision ids
     * @return array<int, array{0: int, 1: int}>
     */
    public static function pairs(array $objects): array
    {
        $pairs = [];

        foreach ($objects as $id => $batchRevisions) {
            $first = min($batchRevisions);

            foreach (Revisions::revisionIds((int) $id) as $revisionId) {
                if ($revisionId < $first) {
                    $pairs[(int) $id] = [$revisionId, max($batchRevisions)];

                    break;
                }
            }
        }

        return $pairs;
    }

    /**
     * Undo a whole batch, chunk by chunk.
     *
     * @return array{batch: string, restored: int, conflicts: int, skipped: int, unchanged: int, pruned: int}
     */
    public static function undoAll(string $uuid, bool $force = false): array
    {
        $batch = wp_generate_uuid4();
        $offset = 0;
        $totals = ['batch' => $batch, 'restored' => 0, 'conflicts' => 0, 'skipped' => 0, 'unchanged' => 0, 'pruned' => 0];

        do {
            $result = self::undo($uuid, ['offset' => $offset, 'limit' => self::CHUNK, 'force' => $force, 'batch' => $batch]);
            $totals['pruned'] = $result['pruned'];
            $totals['restored'] += count($result['restored']);
            $totals['conflicts'] += count($result['conflicts']);
            $totals['skipped'] += count($result['skipped']);
            $totals['unchanged'] += count($result['unchanged']);
            $offset = $result['next'];
        } while ($offset !== null);

        return $totals;
    }

    /**
     * Core's Restore button (wp_restore_post_revision): make the object
     * what the revision holds, through CRUD.
     */
    public static function toRevision(int $postId, int $revisionId): void
    {
        $target = self::state($revisionId, $postId);
        $keys = self::diffKeys(self::current($postId), $target);

        if ($keys !== []) {
            self::apply($postId, $target, $keys);
        }
    }

    /**
     * What a revision holds: meta, terms, (products) post fields, and the
     * status and menu order when the revision has their snapshot.
     *
     * @return array{meta: array<string, string>, terms: array<string, array<int, int>>, post: array<string, string>}
     */
    public static function state(int $revisionId, int $postId): array
    {
        $snapshot = Revisions::revisionSnapshot($revisionId, $postId);
        $revision = get_post($revisionId);
        $post = [];

        if ($revision instanceof WP_Post && get_post_type($postId) === 'product') {
            foreach (array_keys(self::POST_FIELDS) as $field) {
                $post[$field] = (string) $revision->$field;
            }
        }

        $snapshot['post'] = $post + $snapshot['post'];

        return $snapshot;
    }

    /**
     * The live state, in the same shape.
     *
     * @return array{meta: array<string, string>, terms: array<string, array<int, int>>, post: array<string, string>}
     */
    public static function current(int $postId): array
    {
        $type = (string) get_post_type($postId);
        $post = [];
        $live = get_post($postId);

        if ($live instanceof WP_Post && $type === 'product') {
            foreach (array_keys(self::POST_FIELDS) as $field) {
                $post[$field] = (string) $live->$field;
            }
        }

        return ['meta' => Revisions::currentMeta($postId, $type), 'terms' => Revisions::currentTerms($postId, $type), 'post' => $post + Revisions::currentPost($postId)];
    }

    /**
     * Keys (`meta:_regular_price`, `terms:product_cat`, `post:post_title`,
     * `post:post_status`, `post:menu_order`) that differ.
     *
     * @param  array{meta: array<string, string>, terms: array<string, array<int, int>>, post: array<string, string>}  $a
     * @param  array{meta: array<string, string>, terms: array<string, array<int, int>>, post: array<string, string>}  $b
     * @return array<int, string>
     */
    public static function diffKeys(array $a, array $b): array
    {
        $keys = [];

        foreach (['meta', 'terms', 'post'] as $group) {
            foreach (array_unique(array_merge(array_keys($a[$group]), array_keys($b[$group]))) as $key) {
                // Status and menu order are compared only when both sides
                // hold them: a revision taken before `_wcpl_post` existed
                // does not say what they were.
                if ($group === 'post' && in_array($key, Revisions::POST_SNAPSHOT, true) && (! isset($a[$group][$key]) || ! isset($b[$group][$key]))) {
                    continue;
                }

                if (self::normal($key, $a[$group][$key] ?? null) !== self::normal($key, $b[$group][$key] ?? null)) {
                    $keys[] = $group.':'.$key;
                }
            }
        }

        return $keys;
    }

    /**
     * A missing key and an empty value are the same to WooCommerce (it
     * writes `_thumbnail_id` 0 on a variation's first REST save, where
     * there was no row): not a change.
     */
    private static function normal(string $key, mixed $value): mixed
    {
        if ($value === null || $value === '' || ($key === '_thumbnail_id' && $value === '0')) {
            return '';
        }

        return $value;
    }

    /**
     * @param  array{meta: array<string, string>, terms: array<string, array<int, int>>, post: array<string, string>}  $state
     */
    public static function value(array $state, string $key): mixed
    {
        [$group, $name] = explode(':', $key, 2);

        return $state[$group][$name] ?? null;
    }

    /**
     * Set the given keys of an object to the values in `$state` and save
     * through CRUD.
     *
     * @param  array{meta: array<string, string>, terms: array<string, array<int, int>>, post: array<string, string>}  $state
     * @param  array<int, string>  $keys
     */
    public static function apply(int $id, array $state, array $keys): bool
    {
        $product = wc_get_product($id);

        if (! $product instanceof WC_Product) {
            return false;
        }

        $attributes = null;

        foreach ($keys as $key) {
            [$group, $name] = explode(':', $key, 2);
            $value = $state[$group][$name] ?? null;

            if ($group === 'post' && $name === 'post_status') {
                if ($value !== null && $value !== '') {
                    $product->set_status((string) $value);
                }

                continue;
            }

            if ($group === 'post' && $name === 'menu_order') {
                if ($value !== null && $value !== '') {
                    $product->set_menu_order((int) $value);
                }

                continue;
            }

            if ($group === 'post') {
                $product->{'set_'.self::POST_FIELDS[$name]}((string) $value);

                continue;
            }

            if ($group === 'terms') {
                self::applyTerms($product, $name, is_array($value) ? array_map('intval', $value) : []);

                continue;
            }

            if (str_starts_with($name, 'attribute_') && $product instanceof WC_Product_Variation) {
                $attributes ??= $product->get_attributes('edit');
                $attribute = substr($name, strlen('attribute_'));

                if ($value === null) {
                    unset($attributes[$attribute]);
                } else {
                    $attributes[$attribute] = (string) $value;
                }

                continue;
            }

            self::applyMeta($product, $name, $value === null ? null : (string) $value);
        }

        if ($attributes !== null && $product instanceof WC_Product_Variation) {
            $product->set_attributes($attributes);
        }

        $product->save();

        return true;
    }

    private static function applyMeta(WC_Product $product, string $key, ?string $value): void
    {
        $text = $value ?? '';
        $array = static function (?string $value): array {
            $decoded = maybe_unserialize((string) $value);

            return is_array($decoded) ? $decoded : [];
        };

        match ($key) {
            '_regular_price' => $product->set_regular_price($text),
            '_sale_price' => $product->set_sale_price($text),
            '_sale_price_dates_from' => $product->set_date_on_sale_from($text === '' ? null : $text),
            '_sale_price_dates_to' => $product->set_date_on_sale_to($text === '' ? null : $text),
            '_sku' => $product->set_sku($text),
            '_global_unique_id' => $product->set_global_unique_id($text),
            '_manage_stock' => $product->set_manage_stock(wc_string_to_bool($text)),
            '_stock' => $product->set_stock_quantity($value === null ? null : (float) $text),
            '_stock_status' => $product->set_stock_status($text === '' ? 'instock' : $text),
            '_backorders' => $product->set_backorders($text === '' ? 'no' : $text),
            '_low_stock_amount' => $product->set_low_stock_amount($text),
            '_weight' => $product->set_weight($text),
            '_length' => $product->set_length($text),
            '_width' => $product->set_width($text),
            '_height' => $product->set_height($text),
            '_tax_class' => $product->set_tax_class($text),
            '_tax_status' => $product->set_tax_status($text === '' ? 'taxable' : $text),
            '_thumbnail_id' => $product->set_image_id($text),
            '_virtual' => $product->set_virtual($text),
            '_downloadable' => $product->set_downloadable($text),
            '_sold_individually' => $product->set_sold_individually(wc_string_to_bool($text)),
            '_product_image_gallery' => $product->set_gallery_image_ids(array_filter(explode(',', $text))),
            '_purchase_note' => $product->set_purchase_note($text),
            '_default_attributes' => $product->set_default_attributes($array($value)),
            '_upsell_ids' => $product->set_upsell_ids($array($value)),
            '_crosssell_ids' => $product->set_cross_sell_ids($array($value)),
            '_variation_description' => $product->set_description($text),
            default => $value === null ? $product->delete_meta_data($key) : $product->update_meta_data($key, $value),
        };
    }

    /**
     * @param  array<int, int>  $ids
     */
    private static function applyTerms(WC_Product $product, string $taxonomy, array $ids): void
    {
        switch ($taxonomy) {
            case 'product_cat':
                $product->set_category_ids($ids);
                break;
            case 'product_tag':
                $product->set_tag_ids($ids);
                break;
            case 'product_shipping_class':
                $product->set_shipping_class_id($ids[0] ?? 0);
                break;
            case 'product_visibility':
                $slugs = [];

                foreach ($ids as $termId) {
                    $term = get_term($termId, 'product_visibility');

                    if ($term instanceof \WP_Term) {
                        $slugs[] = $term->slug;
                    }
                }

                $catalog = in_array('exclude-from-catalog', $slugs, true);
                $search = in_array('exclude-from-search', $slugs, true);
                $product->set_featured(in_array('featured', $slugs, true));
                $product->set_catalog_visibility(match (true) {
                    $catalog && $search => 'hidden',
                    $catalog => 'search',
                    $search => 'catalog',
                    default => 'visible',
                });
                break;
            default:
                // No WooCommerce prop (brands): written before the save, so
                // the revision the save takes includes it.
                wp_set_object_terms($product->get_id(), $ids, $taxonomy);
        }
    }
}
