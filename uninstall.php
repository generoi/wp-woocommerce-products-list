<?php

/**
 * Deleting the plugin from wp-admin removes its data: the change log
 * table, the running-batch markers, the scheduled prune and what the
 * revisions POC stored (product and variation revisions, `wcpl_batch`
 * terms). Deactivating keeps everything. See docs/revisions.md.
 */

use GeneroWP\ProductsList\History\Purge;
use GeneroWP\ProductsList\Log\BatchState;
use GeneroWP\ProductsList\Log\Prune;
use GeneroWP\ProductsList\Log\Table;

if (! defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

if (file_exists(__DIR__.'/vendor/autoload.php')) {
    require_once __DIR__.'/vendor/autoload.php';
}

spl_autoload_register(static function (string $class): void {
    $prefix = 'GeneroWP\\ProductsList\\';

    if (strncmp($class, $prefix, strlen($prefix)) === 0) {
        $file = __DIR__.'/src/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';

        if (is_file($file)) {
            require_once $file;
        }
    }
});

global $wpdb;

Prune::unschedule();
Purge::run();
Table::drop();

$wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like(BatchState::OPTION_PREFIX).'%'));
