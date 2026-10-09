<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Log\Table;

/**
 * POC: one batch as the field log saw it and as revisions captured it.
 *
 * In `both` mode a save made by the app is recorded twice under the same
 * batch id: log rows (`batch_id`) and revisions with the `wcpl_batch`
 * term of that slug. This lines the two up per object, says what an undo
 * from each would do (dry run, no writes), and what each costs to store
 * and to read.
 */
final class Compare
{
    /**
     * wc/v3 field path (as the log stores it) => revision key.
     */
    public const FIELD_KEYS = [
        'regular_price' => 'meta:_regular_price',
        'sale_price' => 'meta:_sale_price',
        'date_on_sale_from' => 'meta:_sale_price_dates_from',
        'date_on_sale_from_gmt' => 'meta:_sale_price_dates_from',
        'date_on_sale_to' => 'meta:_sale_price_dates_to',
        'date_on_sale_to_gmt' => 'meta:_sale_price_dates_to',
        'sku' => 'meta:_sku',
        'global_unique_id' => 'meta:_global_unique_id',
        'manage_stock' => 'meta:_manage_stock',
        'stock_quantity' => 'meta:_stock',
        'stock_status' => 'meta:_stock_status',
        'backorders' => 'meta:_backorders',
        'low_stock_amount' => 'meta:_low_stock_amount',
        'weight' => 'meta:_weight',
        'dimensions.length' => 'meta:_length',
        'dimensions.width' => 'meta:_width',
        'dimensions.height' => 'meta:_height',
        'tax_class' => 'meta:_tax_class',
        'tax_status' => 'meta:_tax_status',
        'virtual' => 'meta:_virtual',
        'downloadable' => 'meta:_downloadable',
        'sold_individually' => 'meta:_sold_individually',
        'purchase_note' => 'meta:_purchase_note',
        'image' => 'meta:_thumbnail_id',
        'upsell_ids' => 'meta:_upsell_ids',
        'cross_sell_ids' => 'meta:_crosssell_ids',
        'default_attributes' => 'meta:_default_attributes',
        'name' => 'post:post_title',
        'short_description' => 'post:post_excerpt',
        'categories' => 'terms:product_cat',
        'tags' => 'terms:product_tag',
        'brands' => 'terms:product_brand',
        'shipping_class' => 'terms:product_shipping_class',
        'featured' => 'terms:product_visibility',
        'catalog_visibility' => 'terms:product_visibility',
    ];

    public static function key(string $field, string $objectType): ?string
    {
        if ($field === 'description') {
            return $objectType === 'variation' ? 'meta:_variation_description' : 'post:post_content';
        }

        if ($field === 'images') {
            return 'meta:_thumbnail_id';
        }

        if (preg_match('/^i18n\.([a-z]{2})\.(.+)$/', $field, $m)) {
            return 'meta:_i18n_'.$m[2].'_'.$m[1];
        }

        if (str_starts_with($field, 'meta_data.')) {
            return 'meta:'.substr($field, strlen('meta_data.'));
        }

        return self::FIELD_KEYS[$field] ?? null;
    }

    /**
     * @return array<string, mixed>
     */
    public static function run(string $batch): array
    {
        global $wpdb;

        $table = Table::name();

        // The log.
        $start = microtime(true);
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $rows = (array) $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id", $batch), ARRAY_A);
        $logRead = microtime(true) - $start;
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $logBytes = (int) $wpdb->get_var($wpdb->prepare("SELECT COALESCE(SUM(LENGTH(batch_id) + LENGTH(field) + COALESCE(LENGTH(old_value), 0) + COALESCE(LENGTH(new_value), 0) + LENGTH(message) + COALESCE(LENGTH(context), 0) + 80), 0) FROM {$table} WHERE batch_id = %s", $batch));

        $start = microtime(true);
        $logCheck = Revert::check($rows, $batch);
        $logCheckTime = microtime(true) - $start;

        $log = [];

        foreach ($rows as $row) {
            if (($row['status'] ?? 'ok') !== 'ok' || ! Revert::revertable((string) $row['action']) || $row['field'] === '') {
                continue;
            }

            $id = (int) $row['object_id'];
            $key = self::key((string) $row['field'], (string) $row['object_type']) ?? 'unmapped:'.$row['field'];
            $log[$id]['type'] = (string) $row['object_type'];
            $log[$id]['keys'][$key] = (string) ($row['new_value'] ?? '');
        }

        // Revisions.
        $start = microtime(true);
        $objects = Restore::objects($batch);
        $pairs = Restore::pairs($objects);
        $revisions = [];
        $revisionIds = [];

        foreach ($pairs as $id => [$predecessor, $last]) {
            $revisions[$id] = Restore::diffKeys(Restore::state($predecessor, $id), Restore::state($last, $id));
        }

        foreach ($objects as $ids) {
            array_push($revisionIds, ...$ids);
        }

        $revisionRead = microtime(true) - $start;

        $start = microtime(true);
        $dry = ['restored' => 0, 'conflicts' => 0, 'skipped' => 0, 'unchanged' => 0];
        $offset = 0;

        do {
            $chunk = Restore::undo($batch, ['offset' => $offset, 'limit' => Restore::CHUNK, 'dry' => true]);
            $dry['restored'] += count($chunk['restored']);
            $dry['conflicts'] += count($chunk['conflicts']);
            $dry['skipped'] += count($chunk['skipped']);
            $dry['unchanged'] += count($chunk['unchanged']);
            $offset = $chunk['next'];
        } while ($offset !== null);

        $revisionCheckTime = microtime(true) - $start;

        $storage = ['revisions' => count($revisionIds), 'meta_rows' => 0, 'meta_bytes' => 0, 'post_bytes' => 0];

        foreach (array_chunk($revisionIds, 1000) as $chunk) {
            $in = implode(',', array_map('intval', $chunk));
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $meta = $wpdb->get_row("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(meta_key) + LENGTH(meta_value) + 16), 0) AS bytes FROM {$wpdb->postmeta} WHERE post_id IN ({$in})");
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $posts = $wpdb->get_var("SELECT COALESCE(SUM(LENGTH(post_title) + LENGTH(post_content) + LENGTH(post_excerpt) + LENGTH(post_name) + 200), 0) FROM {$wpdb->posts} WHERE ID IN ({$in})");
            $storage['meta_rows'] += (int) $meta->n;
            $storage['meta_bytes'] += (int) $meta->bytes;
            $storage['post_bytes'] += (int) $posts;
        }

        // Side by side.
        $ids = array_unique(array_merge(array_keys($log), array_keys($objects)));
        sort($ids);
        $objectsOut = [];
        $summary = ['objects' => count($ids), 'match' => 0, 'log_only_objects' => 0, 'revisions_only_objects' => 0, 'key_mismatch' => 0, 'value_mismatch' => 0];

        foreach ($ids as $id) {
            $logKeys = array_keys($log[$id]['keys'] ?? []);
            $revKeys = $revisions[$id] ?? [];
            sort($logKeys);
            sort($revKeys);
            $status = 'match';
            $values = [];

            if (! isset($log[$id])) {
                $status = 'revisions only';
                $summary['revisions_only_objects']++;
            } elseif (! isset($objects[$id])) {
                $status = 'log only';
                $summary['log_only_objects']++;
            } elseif ($logKeys !== $revKeys) {
                $status = 'keys differ';
                $summary['key_mismatch']++;
            } else {
                // Plain numeric values (prices, stock) are compared too.
                $last = isset($pairs[$id]) ? Restore::state($pairs[$id][1], $id) : null;

                foreach ($log[$id]['keys'] as $key => $new) {
                    $captured = $last === null ? null : Restore::value($last, $key);

                    if (is_numeric($new) && (! is_numeric($captured) || (float) $new !== (float) $captured)) {
                        $values[] = $key;
                    }
                }

                if ($values !== []) {
                    $status = 'values differ';
                    $summary['value_mismatch']++;
                } else {
                    $summary['match']++;
                }
            }

            $objectsOut[] = [
                'id' => $id,
                'type' => $log[$id]['type'] ?? (get_post_type($id) === 'product_variation' ? 'variation' : 'product'),
                'log' => implode(' ', $logKeys),
                'revisions' => implode(' ', $revKeys),
                'status' => $status.($values !== [] ? ' ('.implode(' ', $values).')' : ''),
            ];
        }

        return [
            'batch' => $batch,
            'mode' => History::mode(),
            'term' => Batches::meta($batch),
            'summary' => $summary,
            'log' => [
                'rows' => count($rows),
                'bytes' => $logBytes,
                'read_ms' => round($logRead * 1000, 1),
                'undo_check_ms' => round($logCheckTime * 1000, 1),
                'undo_would_skip_changed' => count($logCheck),
            ],
            'revisions' => $storage + [
                'read_and_diff_ms' => round($revisionRead * 1000, 1),
                'undo_check_ms' => round($revisionCheckTime * 1000, 1),
                'undo_dry_run' => $dry,
            ],
            'objects' => $objectsOut,
        ];
    }
}
