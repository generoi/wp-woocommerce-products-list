<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\ListMode;

/**
 * The change log table. One row per changed field of one object within one
 * batch; see docs/contracts.md §3.5 for the columns.
 *
 * Installed on `wc_products_list/activate` and again on `init` whenever the
 * stored schema version differs from VERSION, so a plugin update that adds a
 * column lands without a re-activation. dbDelta is idempotent.
 */
final class Table
{
    /** Bump when the schema changes; dbDelta applies the difference. */
    public const VERSION = '1';

    public const OPTION = 'wc_products_list_log_version';

    public const SOURCES = ListMode::SOURCES;

    public static function name(): string
    {
        global $wpdb;

        return $wpdb->prefix.'wc_products_list_log';
    }

    public static function exists(): bool
    {
        global $wpdb;

        $table = self::name();

        return $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;
    }

    public static function installed(): bool
    {
        return get_option(self::OPTION) === self::VERSION && self::exists();
    }

    /**
     * Create or upgrade the table. Safe to call on every request; it only
     * runs dbDelta when the version differs or the table is missing.
     */
    public static function maybeInstall(): void
    {
        if (self::installed()) {
            return;
        }

        self::install();
    }

    public static function install(): void
    {
        global $wpdb;

        require_once ABSPATH.'wp-admin/includes/upgrade.php';

        $table = self::name();
        $collate = $wpdb->get_charset_collate();

        // dbDelta is picky: two spaces after PRIMARY KEY, one column per line,
        // lower-case types, no backticks around the table name.
        $sql = "CREATE TABLE {$table} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  batch_id varchar(64) NOT NULL DEFAULT '',
  created_at datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  user_id bigint(20) unsigned NOT NULL DEFAULT 0,
  source varchar(20) NOT NULL DEFAULT 'quick',
  action varchar(40) NOT NULL DEFAULT 'update',
  object_type varchar(20) NOT NULL DEFAULT 'product',
  object_id bigint(20) unsigned NOT NULL DEFAULT 0,
  parent_id bigint(20) unsigned NOT NULL DEFAULT 0,
  field varchar(100) NOT NULL DEFAULT '',
  old_value longtext NULL,
  new_value longtext NULL,
  status varchar(10) NOT NULL DEFAULT 'ok',
  message text NOT NULL,
  context longtext NULL,
  PRIMARY KEY  (id),
  KEY batch_id (batch_id),
  KEY object_created (object_id,created_at),
  KEY user_id (user_id),
  KEY created_at (created_at)
) {$collate};";

        dbDelta($sql);

        update_option(self::OPTION, self::VERSION);
    }

    public static function drop(): void
    {
        global $wpdb;

        $wpdb->query('DROP TABLE IF EXISTS '.self::name()); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        delete_option(self::OPTION);
    }
}
