<?php

namespace GeneroWP\ProductsList\Log;

/**
 * Drops log rows older than the retention period, daily. 180 days by
 * default; `wc_products_list/log_retention_days` changes it, 0 keeps
 * everything.
 */
final class Prune
{
    public const HOOK = 'wc_products_list_prune_log';

    public const FILTER_RETENTION = 'wc_products_list/log_retention_days';

    public const DEFAULT_DAYS = 180;

    public const CHUNK = 5000;

    public static function schedule(): void
    {
        if (! wp_next_scheduled(self::HOOK)) {
            wp_schedule_event(time() + DAY_IN_SECONDS, 'daily', self::HOOK);
        }
    }

    public static function unschedule(): void
    {
        $timestamp = wp_next_scheduled(self::HOOK);

        if ($timestamp) {
            wp_unschedule_event($timestamp, self::HOOK);
        }
    }

    public static function retentionDays(): int
    {
        /**
         * Filters how many days of change log are kept. 0 disables pruning.
         *
         * @param  int  $days
         */
        return max(0, (int) apply_filters(self::FILTER_RETENTION, self::DEFAULT_DAYS));
    }

    /**
     * @return int rows deleted
     */
    public static function run(): int
    {
        global $wpdb;

        $days = self::retentionDays();

        if ($days === 0 || ! Table::exists()) {
            return 0;
        }

        $cutoff = gmdate('Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS);
        $table = Table::name();
        $deleted = 0;

        do {
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $count = (int) $wpdb->query($wpdb->prepare("DELETE FROM {$table} WHERE created_at < %s LIMIT %d", $cutoff, self::CHUNK));
            $deleted += $count;
        } while ($count === self::CHUNK);

        return $deleted;
    }
}
