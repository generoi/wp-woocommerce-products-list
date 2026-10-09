<?php

namespace GeneroWP\ProductsList\History;

/**
 * Removes what the revisions POC stored: the revisions of products and
 * variations (with their meta and batch relationships, through core's
 * wp_delete_post_revision()) and the `wcpl_batch` terms with their term
 * meta. Works in every mode, so a site switched back to `log` can clean
 * up; `uninstall.php` runs it too. Products and variations have no
 * revisions without the POC (WooCommerce does not enable them).
 */
final class Purge
{
    public const CHUNK = 500;

    /**
     * @param  bool  $keepBaselines  keep revisions that belong to no batch (the baselines)
     * @param  callable(int): void|null  $progress  called with the revisions deleted so far, per chunk
     * @return array{revisions: int, terms: int}
     */
    public static function run(bool $keepBaselines = false, int $chunk = self::CHUNK, ?callable $progress = null): array
    {
        global $wpdb;

        Batches::registerTaxonomy();
        $chunk = max(1, $chunk);
        $deleted = 0;
        $last = 0;
        $keep = $keepBaselines
            ? $wpdb->prepare(
                " AND EXISTS (SELECT 1 FROM {$wpdb->term_relationships} tr JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id WHERE tr.object_id = r.ID AND tt.taxonomy = %s)",
                Batches::TAXONOMY
            )
            : '';

        do {
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
            $ids = array_map('intval', (array) $wpdb->get_col($wpdb->prepare(
                "SELECT r.ID FROM {$wpdb->posts} r JOIN {$wpdb->posts} p ON p.ID = r.post_parent
                 WHERE r.post_type = 'revision' AND p.post_type IN ('product', 'product_variation') AND r.ID > %d{$keep}
                 ORDER BY r.ID LIMIT %d",
                $last,
                $chunk
            )));

            foreach ($ids as $id) {
                if (wp_delete_post_revision($id)) {
                    $deleted++;
                }

                $last = $id;
            }

            if ($progress !== null) {
                $progress($deleted);
            }

            wp_cache_flush_runtime();
        } while ($ids !== []);

        $terms = 0;
        $lastTerm = 0;

        do {
            $termIds = array_map('intval', (array) $wpdb->get_col($wpdb->prepare(
                "SELECT term_id FROM {$wpdb->term_taxonomy} WHERE taxonomy = %s AND term_id > %d ORDER BY term_id LIMIT %d",
                Batches::TAXONOMY,
                $lastTerm,
                $chunk
            )));

            foreach ($termIds as $termId) {
                if (wp_delete_term($termId, Batches::TAXONOMY) === true) {
                    $terms++;
                }

                $lastTerm = $termId;
            }
        } while ($termIds !== []);

        return ['revisions' => $deleted, 'terms' => $terms];
    }
}
