<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\Module;

/**
 * SPIKE (Phase 0): product history on native WordPress revisions.
 *
 * Off unless `WC_PRODUCTS_LIST_HISTORY === 'revisions'`. When on, the
 * REST-layer field log recorder stays quiet and every product and
 * variation save made through the WooCommerce CRUD layer leaves a
 * revision that matches the saved state, grouped by a `wcpl_batch` term.
 *
 * Options (constants, or the `wc_products_list/history_options` filter):
 * - WC_PRODUCTS_LIST_HISTORY_WRITER: `core` (wp_save_post_revision, as the
 *   plan says) or `lean` (id-only lookups and pruning, same data).
 * - WC_PRODUCTS_LIST_HISTORY_STORAGE: `meta` (one revision meta row per
 *   key, core's revisioned meta) or `packed` (one JSON row per revision).
 */
final class History implements Module
{
    public const MODE = 'revisions';

    public const FILTER_OPTIONS = 'wc_products_list/history_options';

    /** @var array{writer: string, storage: string, keep_product: int, keep_variation: int}|null */
    private static ?array $options = null;

    /** For tests: the constant is process-wide, the suite is not. */
    private static bool $suspended = false;

    public static function enabled(): bool
    {
        return ! self::$suspended && defined('WC_PRODUCTS_LIST_HISTORY') && constant('WC_PRODUCTS_LIST_HISTORY') === self::MODE;
    }

    /**
     * For tests that define the constant after the plugin booted: hook
     * the module in (true) or take it out again (false), so the rest of
     * the suite runs as without it.
     */
    public static function toggle(bool $on): void
    {
        self::$suspended = ! $on;
        Revisions::hooks($on);
        Batches::hooks($on);
        self::resetOptions();
    }

    /**
     * @return array{writer: string, storage: string, keep_product: int, keep_variation: int}
     */
    public static function options(): array
    {
        if (self::$options !== null) {
            return self::$options;
        }

        $options = [
            'writer' => defined('WC_PRODUCTS_LIST_HISTORY_WRITER') ? (string) constant('WC_PRODUCTS_LIST_HISTORY_WRITER') : 'core',
            'storage' => defined('WC_PRODUCTS_LIST_HISTORY_STORAGE') ? (string) constant('WC_PRODUCTS_LIST_HISTORY_STORAGE') : 'meta',
            'keep_product' => 50,
            'keep_variation' => 20,
        ];

        /** @var array{writer: string, storage: string, keep_product: int, keep_variation: int} $filtered */
        $filtered = apply_filters(self::FILTER_OPTIONS, $options);

        return self::$options = $filtered;
    }

    /** For tests: read the options again. */
    public static function resetOptions(): void
    {
        self::$options = null;
    }

    public function register(): void
    {
        Revisions::register();
        Batches::register();
        Restore::register();

        if (defined('WP_CLI') && WP_CLI && class_exists(\WP_CLI::class)) {
            \WP_CLI::add_command('wc-products-list revisions', Cli::class);
        }
    }
}
