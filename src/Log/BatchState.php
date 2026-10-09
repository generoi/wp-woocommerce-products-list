<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\ListMode;
use WP_REST_Request;

/**
 * Which batches are still being written (docs/contracts.md §3.6).
 *
 * Every outermost list-mode write that carries a batch id sets one
 * non-autoloaded option, `wcpl_batch_{id}`, while it runs: who writes
 * it, when it was last written to, how many items the client planned
 * and the variable parents of the request in flight.
 *
 * - A write without a plan is one request: the marker goes when the
 *   request ends.
 * - A job of several requests sends `X-WC-Products-List-Batch-Planned: N`
 *   on each of them; the marker then stays between its requests until
 *   the client closes the batch (`POST /log/batch/{id}/close`).
 * - While it was written to within `ttl()` seconds the batch is
 *   `running`: History's plan, check and revert answer 409
 *   `wc_products_list_batch_running`, so a revert never runs against
 *   rows that are still being written.
 * - A batch that registered a planned count and was never closed is
 *   `interrupted` once the TTL has passed (tab closed, network lost, the
 *   PHP process killed): History can say "312 of 900 written". When the
 *   request in flight died, WooCommerce's deferred parent sync never ran;
 *   `repair()` runs it for the parents that request named.
 * - A marker without a plan left behind by a killed request expires.
 *
 * @phpstan-type Marker array{user: int, planned: int, started: int, updated: int, parents: array<int, int>}
 */
final class BatchState
{
    public const OPTION_PREFIX = 'wcpl_batch_';

    public const PLANNED_HEADER = 'X-WC-Products-List-Batch-Planned';

    public const RUNNING_ERROR = 'wc_products_list_batch_running';

    public const FILTER_TTL = 'wc_products_list/batch_running_ttl';

    public const TTL = 120;

    public const STATE_RUNNING = 'running';

    public const STATE_INTERRUPTED = 'interrupted';

    public static function ttl(): int
    {
        /**
         * Filters how many seconds after its last write a batch still
         * counts as running.
         *
         * @param  int  $seconds
         */
        return max(1, (int) apply_filters(self::FILTER_TTL, self::TTL));
    }

    public static function option(string $batchId): string
    {
        return self::OPTION_PREFIX.$batchId;
    }

    /**
     * @return Marker|null
     */
    public static function get(string $batchId): ?array
    {
        if (! ListMode::isBatchId($batchId)) {
            return null;
        }

        $marker = get_option(self::option($batchId), null);

        if (! is_array($marker)) {
            return null;
        }

        return [
            'user' => (int) ($marker['user'] ?? 0),
            'planned' => (int) ($marker['planned'] ?? 0),
            'started' => (int) ($marker['started'] ?? 0),
            'updated' => (int) ($marker['updated'] ?? 0),
            'parents' => array_values(array_map('intval', (array) ($marker['parents'] ?? []))),
        ];
    }

    /**
     * @param  Marker|null  $marker
     */
    public static function stateOf(?array $marker): ?string
    {
        if ($marker === null) {
            return null;
        }

        if (time() - $marker['updated'] <= self::ttl()) {
            return self::STATE_RUNNING;
        }

        return $marker['planned'] > 0 ? self::STATE_INTERRUPTED : null;
    }

    /**
     * The state of a batch; a stale marker is repaired (parents synced)
     * on the way, and one without a planned count is dropped.
     */
    public static function state(string $batchId): ?string
    {
        $marker = self::get($batchId);
        $state = self::stateOf($marker);

        if ($marker !== null && $state !== self::STATE_RUNNING) {
            self::repair($batchId, $marker);

            if ($state === null) {
                delete_option(self::option($batchId));
            }
        }

        return $state;
    }

    public static function running(string $batchId): bool
    {
        return self::state($batchId) === self::STATE_RUNNING;
    }

    /**
     * An outermost list-mode write is about to run: mark its batch.
     */
    public static function begin(WP_REST_Request $request): void
    {
        $batchId = ListMode::batchId();

        if ($batchId === null || ! self::marks($request) || get_current_user_id() <= 0 || Logger::isOthers($batchId)) {
            return;
        }

        $marker = self::get($batchId);

        if ($marker !== null && $marker['user'] !== get_current_user_id()) {
            return;
        }

        $planned = max((int) $request->get_header(self::PLANNED_HEADER), $marker['planned'] ?? 0);
        $now = time();

        update_option(self::option($batchId), [
            'user' => get_current_user_id(),
            'planned' => $planned,
            'started' => $marker['started'] ?? $now,
            'updated' => $now,
            'parents' => self::parentsOf($request),
        ], false);
    }

    /**
     * The write is over (whatever its outcome): its parents were synced
     * by WooCommerce, the batch was written to just now.
     */
    public static function end(WP_REST_Request $request): void
    {
        $batchId = ListMode::batchId();

        if ($batchId === null || ! self::marks($request)) {
            return;
        }

        $marker = self::get($batchId);

        if ($marker === null || $marker['user'] !== get_current_user_id()) {
            return;
        }

        if ($marker['planned'] <= 0) {
            // A write that registered no plan is one request: done now.
            delete_option(self::option($batchId));

            return;
        }

        $marker['updated'] = time();
        $marker['parents'] = [];
        update_option(self::option($batchId), $marker, false);
    }

    /**
     * The client is done with the batch. True when there was a marker.
     */
    public static function close(string $batchId): bool
    {
        $marker = self::get($batchId);

        if ($marker === null) {
            return false;
        }

        self::repair($batchId, $marker);
        delete_option(self::option($batchId));

        return true;
    }

    /**
     * A write that died left its variable parents unsynced (`_price`,
     * the price range, the lookup table): sync them now.
     *
     * @param  Marker  $marker
     */
    public static function repair(string $batchId, array $marker): void
    {
        if ($marker['parents'] === [] || time() - $marker['updated'] <= self::ttl()) {
            return;
        }

        foreach ($marker['parents'] as $parent) {
            if ($parent > 0 && class_exists(\WC_Product_Variable::class) && get_post_type($parent) === 'product') {
                \WC_Product_Variable::sync($parent);
            }
        }

        $marker['parents'] = [];
        update_option(self::option($batchId), $marker, false);
    }

    /**
     * Markers by batch id for a list of batches, in one query.
     *
     * @param  array<int, string>  $batchIds
     * @return array<string, Marker>
     */
    public static function many(array $batchIds): array
    {
        global $wpdb;

        $names = [];

        foreach ($batchIds as $batchId) {
            if (ListMode::isBatchId($batchId)) {
                $names[] = self::option($batchId);
            }
        }

        if ($names === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($names), '%s'));
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $rows = $wpdb->get_results($wpdb->prepare("SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name IN ({$placeholders})", $names), ARRAY_A);
        $markers = [];

        foreach (is_array($rows) ? $rows : [] as $row) {
            $value = maybe_unserialize((string) $row['option_value']);

            if (! is_array($value)) {
                continue;
            }

            $markers[substr((string) $row['option_name'], strlen(self::OPTION_PREFIX))] = [
                'user' => (int) ($value['user'] ?? 0),
                'planned' => (int) ($value['planned'] ?? 0),
                'started' => (int) ($value['started'] ?? 0),
                'updated' => (int) ($value['updated'] ?? 0),
                'parents' => array_values(array_map('intval', (array) ($value['parents'] ?? []))),
            ];
        }

        return $markers;
    }

    /**
     * Drop markers nobody will close: those without a planned count once
     * stale, interrupted ones after `$days`. Run by the daily log prune.
     */
    public static function prune(int $days): int
    {
        global $wpdb;

        $names = $wpdb->get_col($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like(self::OPTION_PREFIX).'%'));
        $deleted = 0;

        foreach (is_array($names) ? $names : [] as $name) {
            $batchId = substr((string) $name, strlen(self::OPTION_PREFIX));
            $marker = self::get($batchId);

            if ($marker === null) {
                continue;
            }

            $state = self::stateOf($marker);

            if ($state === self::STATE_RUNNING) {
                continue;
            }

            self::repair($batchId, $marker);

            if ($state === null || ($days > 0 && time() - $marker['updated'] > $days * DAY_IN_SECONDS)) {
                delete_option((string) $name);
                $deleted++;
            }
        }

        return $deleted;
    }

    /**
     * Writes that mark their batch: the app's saves and actions, not the
     * log routes (a revert is its own batch, guarded by its own lock).
     */
    private static function marks(WP_REST_Request $request): bool
    {
        return $request->get_method() !== 'GET'
            && ListMode::source() !== 'revert'
            && ! str_starts_with($request->get_route(), '/wc-products-list/v1/log');
    }

    /**
     * The variable parents whose sync WooCommerce defers to the end of
     * this request.
     *
     * @return array<int, int>
     */
    private static function parentsOf(WP_REST_Request $request): array
    {
        if (preg_match('#^/wc/v3/products/(\d+)/variations#', $request->get_route(), $match) === 1) {
            return [(int) $match[1]];
        }

        if ($request->get_route() !== '/wc-products-list/v1/variations/batch') {
            return [];
        }

        $body = array_merge($request->get_body_params(), $request->get_json_params() ?: []);
        $parents = [];

        foreach (is_array($body['update'] ?? null) ? $body['update'] : [] as $item) {
            $id = is_array($item) ? (int) ($item['id'] ?? 0) : 0;
            $parent = $id > 0 ? (int) wp_get_post_parent_id($id) : 0;

            if ($parent > 0) {
                $parents[$parent] = $parent;
            }
        }

        return array_values($parents);
    }
}
