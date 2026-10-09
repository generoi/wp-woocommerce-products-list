<?php

/*
Plugin Name:  WooCommerce Products List
Plugin URI:   https://github.com/generoi/wp-woocommerce-products-list
Description:  A fast DataViews product catalog for WooCommerce with variations inline, bulk editing, scheduled sales and a change log.
Version:      0.1.2
Requires at least: 6.8
Requires PHP: 8.2
Requires Plugins: woocommerce
WC requires at least: 11.0
Author:       Genero
Author URI:   https://genero.fi/
License:      MIT
Text Domain:  wp-woocommerce-products-list
Domain Path:  /languages
*/

use GeneroWP\ProductsList\Plugin;

if (! defined('ABSPATH')) {
    exit;
}

define('WC_PRODUCTS_LIST_VERSION', '0.1.3');
define('WC_PRODUCTS_LIST_FILE', __FILE__);
define('WC_PRODUCTS_LIST_PATH', __DIR__);

if (file_exists(__DIR__.'/vendor/autoload.php')) {
    require_once __DIR__.'/vendor/autoload.php';
}

// Installed without its own vendor/ and outside a site-wide composer install
// (a source zip, or a plain checkout into plugins/): load the classes from
// src/ directly rather than fatal.
if (! class_exists(Plugin::class)) {
    spl_autoload_register(static function (string $class): void {
        $prefix = 'GeneroWP\\ProductsList\\';

        if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
            return;
        }

        $file = __DIR__.'/src/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';

        if (is_file($file)) {
            require_once $file;
        }
    });
}

register_activation_hook(__FILE__, [Plugin::class, 'activate']);
register_deactivation_hook(__FILE__, [Plugin::class, 'deactivate']);

Plugin::getInstance();
