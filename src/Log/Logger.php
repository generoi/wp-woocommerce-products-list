<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\ListMode;

/**
 * Writes log rows. Rows are buffered for the duration of the REST request
 * and written with one multi-row INSERT when it ends (a 100-item bulk save
 * touching five fields each is one query, not five hundred), with an
 * explicit flush for callers that need the rows to be visible at once.
 *
 * Each row: batch_id, user_id, source, action, object_type, object_id,
 * parent_id, field, old_value, new_value, status, message, context. Missing
 * keys get the request's defaults (batch id from the header or a generated
 * one, the current user, source from the header, status ok).
 *
 * @phpstan-type Row array{
 *     batch_id: string, created_at: string, user_id: int, source: string, action: string,
 *     object_type: string, object_id: int, parent_id: int, field: string,
 *     old_value: ?string, new_value: ?string, status: string, message: string, context: ?string, reverts: string
 * }
 */
final class Logger
{
    public const SOURCE_HEADER = ListMode::SOURCE_HEADER;

    public const ACTION_LOGGED = 'wc_products_list/logged';

    /** The source name used with wc_get_logger() for errors. */
    public const WC_LOG_SOURCE = 'wc-products-list';

    public const INSERT_CHUNK = 200;

    /**
     * The objects a row can be about. `term` rows (gds-woo-i18n's
     * attribute-term translations, action `translate_term`) are shown in
     * History but never reverted (`Revert::NOT_REVERTABLE`) and never match
     * a product's `object_id` filter. An integration checks for `term` here
     * before logging one: an older log stored any unknown type as `product`.
     */
    public const OBJECT_TYPES = ['product', 'variation', 'term'];

    /** The action of a term translation row. */
    public const ACTION_TRANSLATE_TERM = 'translate_term';

    public const STATUS_OK = 'ok';

    public const STATUS_ERROR = 'error';

    /** An item that was in a batch's scope but was not written (trashed meanwhile, changed since, ...). */
    public const STATUS_SKIPPED = 'skipped';

    /** @var array<int, Row> */
    private static array $buffer = [];

    private static ?string $generatedBatchId = null;

    private static ?string $source = null;

    /** The batch a revert in progress puts back; stored on every row it writes. */
    private static string $reverts = '';

    private static bool $hooked = false;

    /** @var array<int, array{0: ?string, 1: ?string}> source and generated batch id of the requests a nested dispatch interrupted */
    private static array $stack = [];

    /**
     * Hook the request lifecycle: the source header is captured per request
     * and the buffer is flushed when the request's callbacks are done.
     */
    public static function register(): void
    {
        if (self::$hooked) {
            return;
        }

        self::$hooked = true;

        add_filter('rest_request_before_callbacks', [self::class, 'beginRequest'], 2, 3);
        add_filter('rest_request_after_callbacks', [self::class, 'endRequest'], 1000, 3);
        add_action('shutdown', [self::class, 'flush'], 1);
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function beginRequest($response, $handler, \WP_REST_Request $request)
    {
        // A nested dispatch (the revert posts to wc/v3 from inside its own
        // request) must not inherit the outer request's rows or defaults;
        // the outer request gets its own back when the nested one ends.
        self::flush();
        self::$stack[] = [self::$source, self::$generatedBatchId];
        self::$generatedBatchId = null;
        self::$others = [];
        self::$source = self::normaliseSource($request->get_header(self::SOURCE_HEADER));

        return $response;
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function endRequest($response, $handler, \WP_REST_Request $request)
    {
        self::flush();

        if (self::$stack !== []) {
            [self::$source, self::$generatedBatchId] = array_pop(self::$stack);
        }

        return $response;
    }

    /**
     * The batch id of the current request: the header when the app sent
     * one, otherwise one generated for this request so the rows still group.
     */
    public static function batchId(): string
    {
        $header = ListMode::batchId();

        if ($header !== null && self::isOthers($header)) {
            // A replayed id: the rows go under one of this request's own,
            // so nobody can add rows to (and so block the revert of)
            // another user's batch.
            $header = null;
        }

        return $header ?? (self::$generatedBatchId ??= wp_generate_uuid4());
    }

    /** @var array<string, bool> batch id|user id => whether another user has rows under the id; per request */
    private static array $others = [];

    /**
     * Whether rows of a user other than the current one already carry
     * the batch id. One indexed lookup per batch id and request.
     */
    public static function isOthers(string $batchId): bool
    {
        $key = $batchId.'|'.get_current_user_id();

        if (isset(self::$others[$key])) {
            return self::$others[$key];
        }

        global $wpdb;

        $table = Table::name();
        // The table may not exist yet: insert() creates it on the first write.
        $suppress = $wpdb->suppress_errors(true);
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $found = $wpdb->get_var($wpdb->prepare("SELECT 1 FROM {$table} WHERE batch_id = %s AND user_id <> %d LIMIT 1", $batchId, get_current_user_id()));
        $wpdb->suppress_errors($suppress);

        return self::$others[$key] = $found !== null;
    }

    public static function source(): string
    {
        return self::$source ?? 'quick';
    }

    /**
     * Override the source for the rest of this request (actions and the
     * revert set theirs regardless of the header).
     */
    public static function setSource(?string $source): void
    {
        self::$source = $source === null ? null : self::normaliseSource($source);
    }

    /**
     * Mark the rows written from now on as the revert of a batch (`''`
     * to stop). Not per request: the revert writes through nested wc/v3
     * requests, whose rows must carry it.
     */
    public static function setReverts(string $batchId): void
    {
        self::$reverts = substr($batchId, 0, 64);
    }

    public static function normaliseSource(?string $source): string
    {
        $source = strtolower(trim((string) $source));

        return in_array($source, Table::SOURCES, true) ? $source : 'quick';
    }

    /**
     * Queue rows. Partial rows are completed with the request defaults.
     *
     * @param  array<int, array<string, mixed>>  $rows
     */
    public static function log(array $rows): void
    {
        if ($rows === []) {
            return;
        }

        $now = current_time('mysql', true);
        $userId = get_current_user_id();
        $source = self::source();

        foreach ($rows as $row) {
            $full = self::complete($row, $now, $userId, $source);
            self::$buffer[] = $full;

            if ($full['status'] === self::STATUS_ERROR) {
                self::wcLog($full);
            }
        }
    }

    /**
     * Write one row at once, bypassing the buffer, and return its id (0
     * when the INSERT failed). For a row that must exist the moment its
     * change does: a row action logs a trash, restore, status change or
     * delete from the change's own hook, so a request killed right after
     * leaves no change without its row. `wc_products_list/logged` fires
     * when the row is finalised with `replace()`, not here.
     *
     * @param  array<string, mixed>  $row
     */
    public static function writeNow(array $row): int
    {
        global $wpdb;

        self::insert([self::complete($row, current_time('mysql', true), get_current_user_id(), self::source())]);

        return (int) $wpdb->insert_id;
    }

    /**
     * Overwrite a row written by `writeNow()` with its final values (same
     * defaults as `log()`), and fire `wc_products_list/logged` for it.
     *
     * @param  array<string, mixed>  $row
     */
    public static function replace(int $id, array $row): void
    {
        global $wpdb;

        $full = self::complete($row, current_time('mysql', true), get_current_user_id(), self::source());
        $columns = array_intersect_key($full, array_flip(['field', 'old_value', 'new_value', 'status', 'message', 'context']));
        $wpdb->update(Table::name(), $columns, ['id' => $id]);

        if ($full['status'] === self::STATUS_ERROR) {
            self::wcLog($full);
        }

        /** This action is documented in src/Log/Logger.php (flush). */
        do_action(self::ACTION_LOGGED, [$full], $full['batch_id']);
    }

    /**
     * A partial row completed with the request defaults.
     *
     * @param  array<string, mixed>  $row
     * @return Row
     */
    private static function complete(array $row, string $now, int $userId, string $source): array
    {
        $status = in_array($row['status'] ?? 'ok', [self::STATUS_ERROR, self::STATUS_SKIPPED], true) ? (string) $row['status'] : self::STATUS_OK;
        $context = $row['context'] ?? null;

        return [
            'batch_id' => substr((string) ($row['batch_id'] ?? self::batchId()), 0, 64),
            'created_at' => (string) ($row['created_at'] ?? $now),
            'user_id' => (int) ($row['user_id'] ?? $userId),
            'source' => self::normaliseSource($row['source'] ?? $source),
            'action' => substr((string) ($row['action'] ?? 'update'), 0, 40),
            'object_type' => in_array((string) ($row['object_type'] ?? ''), self::OBJECT_TYPES, true) ? (string) $row['object_type'] : 'product',
            'object_id' => (int) ($row['object_id'] ?? 0),
            'parent_id' => (int) ($row['parent_id'] ?? 0),
            'field' => substr((string) ($row['field'] ?? ''), 0, 100),
            'old_value' => isset($row['old_value']) ? (string) $row['old_value'] : null,
            'new_value' => isset($row['new_value']) ? (string) $row['new_value'] : null,
            'status' => $status,
            'message' => (string) ($row['message'] ?? ''),
            'context' => is_array($context) ? (string) wp_json_encode($context) : (is_string($context) ? $context : null),
            'reverts' => substr((string) ($row['reverts'] ?? self::$reverts), 0, 64),
        ];
    }

    /**
     * Write the buffered rows now.
     */
    public static function flush(): void
    {
        if (self::$buffer === []) {
            return;
        }

        $rows = self::$buffer;
        self::$buffer = [];

        foreach (array_chunk($rows, self::INSERT_CHUNK) as $chunk) {
            self::insert($chunk);
        }

        $byBatch = [];

        foreach ($rows as $row) {
            $byBatch[$row['batch_id']][] = $row;
        }

        foreach ($byBatch as $batchId => $batchRows) {
            /**
             * Fires after log rows have been written.
             *
             * @param  array<int, array<string, mixed>>  $rows
             * @param  string  $batchId
             */
            do_action(self::ACTION_LOGGED, $batchRows, (string) $batchId);
        }
    }

    /**
     * One multi-row INSERT. The table is not checked for beforehand (that
     * would be a SHOW TABLES on every write request): when the INSERT
     * fails because the table is gone, it is created and the INSERT runs
     * once more.
     *
     * @param  array<int, Row>  $rows
     */
    private static function insert(array $rows, bool $retry = true): void
    {
        global $wpdb;

        $columns = ['batch_id', 'created_at', 'user_id', 'source', 'action', 'object_type', 'object_id', 'parent_id', 'field', 'old_value', 'new_value', 'status', 'message', 'context', 'reverts'];
        $placeholders = [];
        $values = [];

        foreach ($rows as $row) {
            $marks = [];

            foreach ($columns as $column) {
                $value = $row[$column];

                if ($value === null) {
                    $marks[] = 'NULL';
                } elseif (is_int($value)) {
                    $marks[] = '%d';
                    $values[] = $value;
                } else {
                    $marks[] = '%s';
                    $values[] = $value;
                }
            }

            $placeholders[] = '('.implode(',', $marks).')';
        }

        $sql = 'INSERT INTO '.Table::name().' ('.implode(',', $columns).') VALUES '.implode(',', $placeholders);

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $result = $wpdb->query($wpdb->prepare($sql, $values));

        if ($result !== false) {
            return;
        }

        if ($retry && self::tableIsMissing((string) $wpdb->last_error)) {
            Table::install();
            self::insert($rows, false);

            return;
        }

        if (function_exists('wc_get_logger')) {
            wc_get_logger()->error('Could not write change log rows: '.$wpdb->last_error, ['source' => self::WC_LOG_SOURCE]);
        }
    }

    /**
     * Whether a database error says the log table does not exist. MySQL
     * and MariaDB: error 1146 "Table '…' doesn't exist".
     */
    public static function tableIsMissing(string $error): bool
    {
        return $error !== '' && (
            stripos($error, "doesn't exist") !== false
            || stripos($error, 'does not exist') !== false
            || str_contains($error, '1146')
        ) && stripos($error, Table::name()) !== false;
    }

    /**
     * @param  Row  $row
     */
    private static function wcLog(array $row): void
    {
        if (! function_exists('wc_get_logger')) {
            return;
        }

        wc_get_logger()->error(
            sprintf('%s %s #%d%s: %s', $row['action'], $row['object_type'], $row['object_id'], $row['field'] !== '' ? ' ('.$row['field'].')' : '', $row['message']),
            ['source' => self::WC_LOG_SOURCE, 'batch_id' => $row['batch_id'], 'user_id' => $row['user_id']]
        );
    }
}
