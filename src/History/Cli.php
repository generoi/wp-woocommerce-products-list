<?php

namespace GeneroWP\ProductsList\History;

/**
 * SPIKE: `wp wc-products-list revisions <command>`.
 */
final class Cli
{
    /**
     * Put down a baseline revision for every product and variation that has none.
     *
     * ## OPTIONS
     *
     * [--chunk=<n>]
     * : Objects per round. Default 500.
     *
     * @param  array<int, string>  $args
     * @param  array<string, string>  $assoc
     */
    public function backfill(array $args, array $assoc): void
    {
        global $wpdb;

        $chunk = max(1, (int) ($assoc['chunk'] ?? 500));
        $done = 0;
        $last = 0;

        do {
            $ids = array_map('intval', $wpdb->get_col($wpdb->prepare(
                "SELECT p.ID FROM {$wpdb->posts} p WHERE p.post_type IN ('product', 'product_variation') AND p.post_status NOT IN ('auto-draft', 'trash') AND p.ID > %d
                 AND NOT EXISTS (SELECT 1 FROM {$wpdb->posts} r WHERE r.post_parent = p.ID AND r.post_type = 'revision')
                 ORDER BY p.ID LIMIT %d",
                $last,
                $chunk
            )));

            if ($ids === []) {
                break;
            }

            _prime_post_caches($ids, true, true);
            Revisions::primeRevisionIds($ids);

            foreach ($ids as $id) {
                $post = get_post($id);

                if ($post instanceof \WP_Post) {
                    Revisions::baseline($post);
                    $done++;
                }

                $last = $id;
            }

            Revisions::forget();
            wp_cache_flush_runtime();
            // @phpstan-ignore class.notFound
            \WP_CLI::log(sprintf('%d baselines', $done));
        } while (true);

        // @phpstan-ignore class.notFound
        \WP_CLI::success(sprintf('%d baselines written.', $done));
    }

    /**
     * Undo a batch.
     *
     * ## OPTIONS
     *
     * <batch>
     * : The batch uuid.
     *
     * [--force]
     * : Write over later changes.
     *
     * @param  array<int, string>  $args
     * @param  array<string, string>  $assoc
     */
    public function undo(array $args, array $assoc): void
    {
        $result = Restore::undoAll((string) $args[0], isset($assoc['force']));
        // @phpstan-ignore class.notFound
        \WP_CLI::success((string) wp_json_encode($result));
    }
}
