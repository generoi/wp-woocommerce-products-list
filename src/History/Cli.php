<?php

namespace GeneroWP\ProductsList\History;

/**
 * POC: `wp wc-products-list history <command>`. Loaded in `both` and
 * `revisions` modes only.
 */
final class Cli
{
    /**
     * Compare one batch as the log recorded it with what revisions captured.
     *
     * ## OPTIONS
     *
     * --batch=<id>
     * : The batch id (the app's X-WC-Products-List-Batch uuid).
     *
     * [--limit=<n>]
     * : Objects to list. Default 50; 0 for none.
     *
     * [--format=<format>]
     * : table or json. Default table.
     *
     * @param  array<int, string>  $args
     * @param  array<string, string>  $assoc
     */
    public function compare(array $args, array $assoc): void
    {
        $result = Compare::run((string) ($assoc['batch'] ?? ''));

        if (($assoc['format'] ?? 'table') === 'json') {
            // @phpstan-ignore class.notFound
            \WP_CLI::line((string) wp_json_encode($result, JSON_PRETTY_PRINT));

            return;
        }

        $objects = $result['objects'];
        unset($result['objects']);
        // @phpstan-ignore class.notFound
        \WP_CLI::line((string) wp_json_encode($result, JSON_PRETTY_PRINT));

        $limit = (int) ($assoc['limit'] ?? 50);

        if ($limit > 0 && $objects !== []) {
            // @phpstan-ignore function.notFound
            \WP_CLI\Utils\format_items('table', array_slice($objects, 0, $limit), ['id', 'type', 'log', 'revisions', 'status']);
        }
    }

    /**
     * Undo a batch from its revisions (through WooCommerce CRUD).
     *
     * ## OPTIONS
     *
     * <batch>
     * : The batch id.
     *
     * [--force]
     * : Write over later changes.
     *
     * [--dry-run]
     * : Say what would be written.
     *
     * @param  array<int, string>  $args
     * @param  array<string, string>  $assoc
     */
    public function undo(array $args, array $assoc): void
    {
        if (isset($assoc['dry-run'])) {
            $result = Restore::undo((string) $args[0], ['limit' => PHP_INT_MAX, 'dry' => true, 'force' => isset($assoc['force'])]);
            unset($result['restored'], $result['unchanged']);
        } else {
            $result = Restore::undoAll((string) $args[0], isset($assoc['force']));
        }

        // @phpstan-ignore class.notFound
        \WP_CLI::success((string) wp_json_encode($result));
    }

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
        } while ($ids !== []);

        // @phpstan-ignore class.notFound
        \WP_CLI::success(sprintf('%d baselines written.', $done));
    }
}
