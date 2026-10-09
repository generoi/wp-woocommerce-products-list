<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Rest\Concurrency;
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
 * `parents` is kept as a list with one entry per parent per request in
 * flight: `begin()` adds the request's parents, `end()` takes away one
 * entry of each of its own, so the requests of one batch sent at the same
 * time (three by default) never drop each other's parents, and a request
 * that died leaves its parents behind. `close()` repairs every parent
 * still listed, whatever the TTL: the client says the job is over. Every
 * change to the marker is read fresh and written under a named lock per
 * batch.
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

        return self::normalize($marker);
    }

    /**
     * @param  array<string, mixed>  $marker
     * @return Marker parents without repeats
     */
    private static function normalize(array $marker): array
    {
        return [
            'user' => (int) ($marker['user'] ?? 0),
            'planned' => (int) ($marker['planned'] ?? 0),
            'started' => (int) ($marker['started'] ?? 0),
            'updated' => (int) ($marker['updated'] ?? 0),
            'parents' => array_values(array_unique(array_map('intval', (array) ($marker['parents'] ?? [])))),
        ];
    }

    /**
     * Change a batch's marker: under a named lock per batch, from the
     * stored value (not this process's option cache, which another
     * request of the batch may have outdated). `$change` gets the stored
     * marker (parents with one entry per request in flight) or null and
     * returns the new one, null to delete it or false to leave it.
     *
     * @param  callable(array<string, mixed>|null): (array<string, mixed>|null|false)  $change
     */
    private static function mutate(string $batchId, callable $change): void
    {
        $lock = Concurrency::lockName('m', md5($batchId));
        // Best effort: without the lock the write still happens, as before.
        $locked = Concurrency::acquire($lock, 5);

        try {
            wp_cache_delete(self::option($batchId), 'options');
            $stored = get_option(self::option($batchId), null);
            $next = $change(is_array($stored) ? $stored : null);

            if ($next === null) {
                delete_option(self::option($batchId));
            } elseif ($next !== false) {
                update_option(self::option($batchId), $next, false);
            }
        } finally {
            if ($locked) {
                Concurrency::release($lock);
            }
        }
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

        $user = get_current_user_id();
        $planned = (int) $request->get_header(self::PLANNED_HEADER);
        $parents = self::parentsOf($request);

        self::mutate($batchId, static function (?array $marker) use ($user, $planned, $parents) {
            if ($marker !== null && (int) ($marker['user'] ?? 0) !== $user) {
                return false;
            }

            $now = time();

            return [
                'user' => $user,
                'planned' => max($planned, (int) ($marker['planned'] ?? 0)),
                'started' => (int) ($marker['started'] ?? $now),
                'updated' => $now,
                'parents' => array_merge(array_map('intval', (array) ($marker['parents'] ?? [])), $parents),
            ];
        });
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

        $user = get_current_user_id();
        $parents = self::parentsOf($request);

        self::mutate($batchId, static function (?array $marker) use ($user, $parents) {
            if ($marker === null || (int) ($marker['user'] ?? 0) !== $user) {
                return false;
            }

            if ((int) ($marker['planned'] ?? 0) <= 0) {
                // A write that registered no plan is one request: done now.
                return null;
            }

            // Only this request's parents: a sibling still running, or one
            // that died, keeps its own.
            $left = array_map('intval', (array) ($marker['parents'] ?? []));

            foreach ($parents as $parent) {
                $at = array_search($parent, $left, true);

                if ($at !== false) {
                    unset($left[$at]);
                }
            }

            $marker['updated'] = time();
            $marker['parents'] = array_values($left);

            return $marker;
        });
    }

    /**
     * The client is done with the batch. True when there was a marker.
     */
    public static function close(string $batchId): bool
    {
        $closed = false;
        $parents = [];

        self::mutate($batchId, static function (?array $marker) use (&$closed, &$parents) {
            if ($marker === null) {
                return false;
            }

            $closed = true;
            $parents = self::normalize($marker)['parents'];

            return null;
        });

        // The client says the job is over: a parent still listed belongs
        // to a request that died, however recently.
        self::syncParents($parents);

        return $closed;
    }

    /**
     * A write that died left its variable parents unsynced (`_price`,
     * the price range, the lookup table): sync them now, once the batch
     * is no longer running.
     *
     * @param  Marker  $marker
     */
    public static function repair(string $batchId, array $marker): void
    {
        if ($marker['parents'] === [] || time() - $marker['updated'] <= self::ttl()) {
            return;
        }

        self::syncParents($marker['parents']);

        self::mutate($batchId, static function (?array $stored) {
            if ($stored === null) {
                return false;
            }

            $stored['parents'] = [];

            return $stored;
        });
    }

    /**
     * @param  array<int, int>  $parents
     */
    private static function syncParents(array $parents): void
    {
        foreach (array_unique($parents) as $parent) {
            if ($parent > 0 && class_exists(\WC_Product_Variable::class) && get_post_type($parent) === 'product') {
                \WC_Product_Variable::sync($parent);
                wc_delete_product_transients($parent);
            }
        }
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

            $markers[substr((string) $row['option_name'], strlen(self::OPTION_PREFIX))] = self::normalize($value);
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
     * Writes that mark their batch: the app's saves and actions, and the
     * chunks of a History revert posted in several requests. Other log
     * routes do not; a one-request revert is guarded by its revert claim
     * alone (`Concurrency::claimRevert()`).
     */
    private static function marks(WP_REST_Request $request): bool
    {
        if ($request->get_method() === 'GET') {
            return false;
        }

        if (str_starts_with($request->get_route(), '/wc-products-list/v1/log')) {
            return self::revertChunk($request);
        }

        return ListMode::source() !== 'revert';
    }

    /**
     * A chunk of a revert of several requests: `POST /log/batch/{id}/revert`
     * whose batch header is its `revert_batch_id` and that names a planned
     * count. Its marker sits on the revert batch, so History reports a revert
     * cut short as `interrupted`; the chunks themselves are only checked
     * against the reverted batch, never against their own marker.
     */
    private static function revertChunk(WP_REST_Request $request): bool
    {
        if (preg_match('#^/wc-products-list/v1/log/batch/[A-Za-z0-9_-]{1,64}/revert$#', $request->get_route()) !== 1) {
            return false;
        }

        $revertBatchId = $request->get_param('revert_batch_id');

        return is_string($revertBatchId)
            && $revertBatchId === ListMode::batchId()
            && (int) $request->get_header(self::PLANNED_HEADER) > 0;
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
