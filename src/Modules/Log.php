<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\History\History;
use GeneroWP\ProductsList\History\PurgeCommand;
use GeneroWP\ProductsList\Log\BatchState;
use GeneroWP\ProductsList\Log\Prune;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Module;
use GeneroWP\ProductsList\Plugin;
use GeneroWP\ProductsList\Rest\LogController;

/**
 * The change log: table install on `wc_products_list/activate` and on
 * version change, the daily prune and the log REST routes. The recorder
 * that fills the table hangs off the save hooks in the Actions module.
 */
class Log implements Module
{
    public function register(): void
    {
        add_action(Plugin::ACTION_ACTIVATE, [Table::class, 'install']);
        add_action(Plugin::ACTION_ACTIVATE, [Prune::class, 'schedule']);
        add_action(Plugin::ACTION_DEACTIVATE, [Prune::class, 'unschedule']);

        // A plugin update that changes the schema lands without a
        // re-activation; the version option is autoloaded so this is a
        // string compare on most requests. REST requests are only known
        // to be such after `init` (REST_REQUEST is defined on
        // `parse_request`), so they get their own hook.
        add_action('init', [$this, 'maybeUpgrade'], 20);
        add_action('rest_api_init', [$this, 'maybeUpgrade'], 1);

        add_action(Prune::HOOK, static function (): void {
            Prune::run();
            // Markers of batches nobody closed (docs/contracts.md §3.6).
            BatchState::prune(Prune::retentionDays());
        });
        add_action('rest_api_init', [$this, 'registerRoutes']);

        // The revisions POC's data can be removed in every mode; in `both`
        // and `revisions` the command is part of History\Cli.
        if (defined('WP_CLI') && WP_CLI && class_exists(\WP_CLI::class) && ! History::enabled()) {
            \WP_CLI::add_command('wc-products-list history', PurgeCommand::class);
        }
    }

    public function maybeUpgrade(): void
    {
        if (! is_admin() && ! wp_doing_cron() && ! wp_is_serving_rest_request() && ! doing_action('rest_api_init')) {
            return;
        }

        Table::maybeInstall();

        if (is_admin() || wp_doing_cron()) {
            Prune::schedule();
        }
    }

    public function registerRoutes(): void
    {
        (new LogController)->register();
    }
}
