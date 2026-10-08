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
 *     old_value: ?string, new_value: ?string, status: string, message: string, context: ?string
 * }
 */
final class Logger
{
    public const SOURCE_HEADER = ListMode::SOURCE_HEADER;

    public const ACTION_LOGGED = 'wc_products_list/logged';

    /** The source name used with wc_get_logger() for errors. */
    public const WC_LOG_SOURCE = 'wc-products-list';

    public const INSERT_CHUNK = 200;

    /** @var array<int, Row> */
    private static array $buffer = [];

    private static ?string $generatedBatchId = null;

    private static ?string $source = null;

    private static bool $hooked = false;

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
        // request) must not inherit the outer request's rows or defaults.
        self::flush();
        self::$generatedBatchId = null;
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

        return $response;
    }

    /**
     * The batch id of the current request: the header when the app sent
     * one, otherwise one generated for this request so the rows still group.
     */
    public static function batchId(): string
    {
        return ListMode::batchId() ?? (self::$generatedBatchId ??= wp_generate_uuid4());
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
        $batchId = self::batchId();
        $source = self::source();

        foreach ($rows as $row) {
            $status = ($row['status'] ?? 'ok') === 'error' ? 'error' : 'ok';
            $context = $row['context'] ?? null;

            $full = [
                'batch_id' => substr((string) ($row['batch_id'] ?? $batchId), 0, 64),
                'created_at' => (string) ($row['created_at'] ?? $now),
                'user_id' => (int) ($row['user_id'] ?? $userId),
                'source' => self::normaliseSource($row['source'] ?? $source),
                'action' => substr((string) ($row['action'] ?? 'update'), 0, 40),
                'object_type' => (string) ($row['object_type'] ?? 'product') === 'variation' ? 'variation' : 'product',
                'object_id' => (int) ($row['object_id'] ?? 0),
                'parent_id' => (int) ($row['parent_id'] ?? 0),
                'field' => substr((string) ($row['field'] ?? ''), 0, 100),
                'old_value' => isset($row['old_value']) ? (string) $row['old_value'] : null,
                'new_value' => isset($row['new_value']) ? (string) $row['new_value'] : null,
                'status' => $status,
                'message' => (string) ($row['message'] ?? ''),
                'context' => is_array($context) ? (string) wp_json_encode($context) : (is_string($context) ? $context : null),
            ];

            self::$buffer[] = $full;

            if ($status === 'error') {
                self::wcLog($full);
            }
        }
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

        if (! Table::exists()) {
            Table::install();
        }

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
     * @param  array<int, Row>  $rows
     */
    private static function insert(array $rows): void
    {
        global $wpdb;

        $columns = ['batch_id', 'created_at', 'user_id', 'source', 'action', 'object_type', 'object_id', 'parent_id', 'field', 'old_value', 'new_value', 'status', 'message', 'context'];
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

        if ($result === false && function_exists('wc_get_logger')) {
            wc_get_logger()->error('Could not write change log rows: '.$wpdb->last_error, ['source' => self::WC_LOG_SOURCE]);
        }
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
