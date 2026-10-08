<?php

use GeneroWP\ProductsList\Plugin;

/**
 * Boots WordPress, WooCommerce and the plugin for the integration suite.
 *
 * What the plugin does is defined by WooCommerce's REST hooks — how a row is
 * prepared, when a save fires, what a batch returns. None of that is
 * observable against mocks, so the suite runs against the real thing. The
 * unit suite needs none of this and is left alone.
 */
$autoload = dirname(__DIR__).'/vendor/autoload.php';

if (! file_exists($autoload)) {
    exit("Run `composer install` first.\n");
}

require_once $autoload;

$wpPhpunit = getenv('WP_PHPUNIT__DIR') ?: dirname(__DIR__).'/vendor/wp-phpunit/wp-phpunit';

require_once $wpPhpunit.'/includes/functions.php';

tests_add_filter('muplugins_loaded', function (): void {
    /*
     * WooCommerce itself, not a double.
     *
     * In wp-env the plugins directory is WP_PLUGIN_DIR. On a Bedrock site
     * WordPress lives in its own directory and the test config may not point
     * WP_PLUGIN_DIR at the real one, so the directory this plugin sits in is
     * tried as well: wherever the plugin is installed, WooCommerce is its
     * sibling.
     */
    $candidates = array_unique(array_filter([
        defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR : null,
        dirname(__DIR__, 2),
    ]));

    $woocommerce = null;

    foreach ($candidates as $plugins) {
        if (file_exists($plugins.'/woocommerce/woocommerce.php')) {
            $woocommerce = $plugins.'/woocommerce/woocommerce.php';

            break;
        }
    }

    if (! $woocommerce) {
        exit('WooCommerce was not found in: '.implode(', ', $candidates)."\n");
    }

    require_once $woocommerce;

    require dirname(__DIR__).'/wp-woocommerce-products-list.php';
});

tests_add_filter('init', function (): void {
    /*
     * A test site is a fresh database on every run, so nothing has been
     * activated: WooCommerce's tables, roles and pages have to be installed,
     * and this plugin's activation run (the Log module creates its table
     * on `wc_products_list/activate`), before the first test.
     *
     * On init rather than setup_theme, and after priority 5: WooCommerce's
     * installer schedules actions and looks for existing orders, and it
     * complains when Action Scheduler's store (init, 1) or the order post
     * types (init, 5) are not there yet.
     */
    WC_Install::install();

    // The roles WooCommerce just added are not in the object WordPress built
    // before the install.
    $GLOBALS['wp_roles'] = null;
    wp_roles();

    Plugin::activate();
}, 6);

require $wpPhpunit.'/includes/bootstrap.php';
