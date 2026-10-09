<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\Log\Prune;
use GeneroWP\ProductsList\Module;

/**
 * POC: native WordPress revisions as product history, next to the
 * custom field log. `WC_PRODUCTS_LIST_HISTORY` picks the mode:
 *
 * - unset or `log` (default): today's behaviour; this module is not loaded.
 * - `both`: the log records as today and revisions are recorded for the
 *   same saves, under the same batch id, so the two can be compared
 *   (`wp wc-products-list history compare --batch=<id>`).
 * - `revisions`: only revisions are recorded (the log recorder is quiet);
 *   undo reads from revisions (`wp wc-products-list history undo`).
 *
 * See docs/revisions.md.
 */
final class History implements Module
{
    public const MODES = ['log', 'both', 'revisions'];

    public const FILTER_OPTIONS = 'wc_products_list/history_options';

    /** @var array{keep_product: int, keep_variation: int, variation_text: bool}|null */
    private static ?array $options = null;

    /** For tests: the constant is process-wide, the suite is not. */
    private static ?string $override = null;

    public static function mode(): string
    {
        if (self::$override !== null) {
            return self::$override;
        }

        $mode = defined('WC_PRODUCTS_LIST_HISTORY') ? (string) constant('WC_PRODUCTS_LIST_HISTORY') : 'log';

        return in_array($mode, self::MODES, true) ? $mode : 'log';
    }

    /** Whether revisions are recorded (`both`, `revisions`). */
    public static function enabled(): bool
    {
        return self::mode() !== 'log';
    }

    /** Whether the custom field log records (`log`, `both`). */
    public static function logs(): bool
    {
        return self::mode() !== 'revisions';
    }

    /**
     * `keep_product`, `keep_variation`: revisions kept per object (counted
     * against every save of the object that takes one). `variation_text`:
     * whether a variation's description and its translations are
     * revisioned (off: they are most of a revision's size).
     *
     * @return array{keep_product: int, keep_variation: int, variation_text: bool}
     */
    public static function options(): array
    {
        if (self::$options !== null) {
            return self::$options;
        }

        $defaults = ['keep_product' => 50, 'keep_variation' => 20, 'variation_text' => false];
        $options = (array) apply_filters(self::FILTER_OPTIONS, $defaults) + $defaults;

        return self::$options = [
            'keep_product' => (int) $options['keep_product'],
            'keep_variation' => (int) $options['keep_variation'],
            'variation_text' => (bool) $options['variation_text'],
        ];
    }

    public static function resetOptions(): void
    {
        self::$options = null;
    }

    /**
     * For tests, which cannot redefine the constant: switch the mode and
     * hook the module in or out, so the rest of the suite runs as without it.
     */
    public static function switchTo(string $mode): void
    {
        $was = self::enabled();
        self::$override = $mode;
        $on = self::enabled();
        self::resetOptions();

        if ($on && ! $was) {
            Revisions::registerMeta();
            Revisions::hooks(true);
            Batches::hooks(true);
        } elseif (! $on && $was) {
            Revisions::unregisterMeta();
            Revisions::hooks(false);
            Batches::hooks(false);
        }
    }

    public function register(): void
    {
        Revisions::register();
        Batches::register();

        // Batch terms left empty by retention pruning go with the daily log prune.
        add_action(Prune::HOOK, static function (): void {
            Batches::pruneEmpty();
        });

        if (defined('WP_CLI') && WP_CLI && class_exists(\WP_CLI::class)) {
            \WP_CLI::add_command('wc-products-list history', Cli::class);
        }
    }
}
