<?php

namespace GeneroWP\ProductsList\History;

/**
 * `wp wc-products-list history purge`, in every mode (in `both` and
 * `revisions` it is one of `Cli`'s commands).
 */
final class PurgeCommand
{
    /**
     * Delete the revisions of products and variations and the batch terms
     * the revisions POC stored.
     *
     * ## OPTIONS
     *
     * [--keep-baselines]
     * : Keep revisions that belong to no batch (the baselines).
     *
     * [--chunk=<n>]
     * : Revisions per round. Default 500.
     *
     * [--yes]
     * : Do not ask for confirmation.
     *
     * @param  array<int, string>  $args
     * @param  array<string, string>  $assoc
     */
    public function purge(array $args, array $assoc): void
    {
        // @phpstan-ignore class.notFound
        \WP_CLI::confirm('Delete the revisions of every product and variation and all batch terms?', $assoc);

        $result = Purge::run(isset($assoc['keep-baselines']), (int) ($assoc['chunk'] ?? Purge::CHUNK), static function (int $done): void {
            // @phpstan-ignore class.notFound
            \WP_CLI::log(sprintf('%d revisions deleted', $done));
        });

        // @phpstan-ignore class.notFound
        \WP_CLI::success(sprintf('%d revisions and %d batch terms deleted.', $result['revisions'], $result['terms']));
    }
}
