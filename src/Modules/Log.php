<?php

namespace GeneroWP\ProductsList\Modules;

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
        // string compare on most requests.
        add_action('init', [$this, 'maybeUpgrade'], 20);

        add_action(Prune::HOOK, static function (): void {
            Prune::run();
        });
        add_action('rest_api_init', [$this, 'registerRoutes']);
    }

    public function maybeUpgrade(): void
    {
        if (! is_admin() && ! wp_doing_cron() && ! wp_is_serving_rest_request()) {
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
