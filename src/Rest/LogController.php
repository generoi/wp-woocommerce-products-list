<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\BatchState;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * GET /log, GET /log/users, GET /log/batches, GET /log/batch/{id} (what a
 * revert would write, in chunks) and POST /log/batch/{id}/revert (all of
 * a small batch, or one chunk of a large one). See docs/contracts.md §3.5
 * for the shapes.
 */
final class LogController
{
    public const PER_PAGE_MAX = 100;

    public const PER_PAGE_DEFAULT = 50;

    public function register(): void
    {
        // Reading the log and reverting from it: the log capability. Recording
        // the items a save of one's own left out: the list capability.
        $permission = static fn (): bool => current_user_can(Plugin::logCapability());
        $writer = static fn (): bool => current_user_can(Plugin::capability());

        register_rest_route(Plugin::REST_NAMESPACE, '/log', [
            'methods' => 'GET',
            'callback' => [$this, 'list'],
            'permission_callback' => $permission,
            'args' => $this->listArgs() + [
                'field' => ['type' => 'string'],
                'action' => ['type' => 'string'],
                'object_id' => ['type' => 'integer'],
                'parent_id' => ['type' => 'integer'],
                // With object_id/parent_id: whose id it is. Default: a product's or variation's (a term id may equal one).
                'object_type' => ['type' => 'string', 'enum' => Logger::OBJECT_TYPES],
            ],
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/users', [
            'methods' => 'GET',
            'callback' => [$this, 'logUsers'],
            'permission_callback' => $permission,
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/batches', [
            'methods' => 'GET',
            'callback' => [$this, 'batches'],
            'permission_callback' => $permission,
            'args' => $this->listArgs(),
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/batch/(?P<batch_id>[A-Za-z0-9_-]{1,64})', [
            'methods' => 'GET',
            'callback' => [$this, 'batch'],
            'permission_callback' => $permission,
            'args' => [
                'batch_id' => ['type' => 'string', 'required' => true],
            ],
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/batch/(?P<batch_id>[A-Za-z0-9_-]{1,64})/revert', [
            'methods' => 'POST',
            'callback' => [$this, 'revert'],
            'permission_callback' => $permission,
            'args' => [
                'batch_id' => ['type' => 'string', 'required' => true],
                // `fields`, not `_fields`: core trims the whole response to
                // `_fields` after the callback, and this response has no
                // `id`/`status` at the top level, so the app would get `[]`.
                'fields' => ['type' => 'string', 'description' => 'Comma-separated wc/v3 fields of the refreshed `items` rows.'],
                'ids' => [
                    'type' => 'array',
                    'items' => ['type' => 'integer'],
                    'description' => 'Revert only these objects of the batch (one chunk of GET /log/batch/{id}).',
                ],
                'revert_batch_id' => [
                    'type' => 'string',
                    'description' => 'The batch id (a UUID v4) to log the revert under; the same for every chunk of one revert. Generated when absent.',
                    'validate_callback' => static fn ($value): bool|WP_Error => ListMode::isBatchId($value)
                        ? true
                        : new WP_Error('rest_invalid_param', __('revert_batch_id must be a UUID v4.', 'wp-woocommerce-products-list'), ['status' => 400]),
                ],
                'force' => [
                    'type' => 'boolean',
                    'default' => false,
                    'description' => 'Also put back fields that were changed again after the batch (otherwise reported as `conflict`).',
                ],
                'relative' => [
                    'type' => 'boolean',
                    'default' => false,
                    'description' => 'Where a numeric field such as stock_quantity was changed again after the batch, take the batch\'s change off the current value instead of reporting a conflict.',
                ],
            ],
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/batch/(?P<batch_id>[A-Za-z0-9_-]{1,64})/check', [
            'methods' => 'GET',
            'callback' => [$this, 'check'],
            'permission_callback' => $permission,
            'args' => [
                'batch_id' => ['type' => 'string', 'required' => true],
                'ids' => [
                    'type' => 'array',
                    'items' => ['type' => 'integer'],
                    'description' => 'Check only these objects of the batch (one chunk of GET /log/batch/{id}); the first chunk when absent.',
                ],
            ],
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/batch/(?P<batch_id>[A-Za-z0-9_-]{1,64})/close', [
            'methods' => 'POST',
            'callback' => [$this, 'close'],
            'permission_callback' => $writer,
            'args' => [
                'batch_id' => ['type' => 'string', 'required' => true],
            ],
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/skipped', [
            'methods' => 'POST',
            'callback' => [$this, 'skipped'],
            'permission_callback' => $writer,
            'args' => [
                'batch_id' => [
                    'type' => 'string',
                    'required' => true,
                    'description' => 'The batch (a UUID v4) the items were left out of.',
                    'validate_callback' => static fn ($value): bool|WP_Error => ListMode::isBatchId($value)
                        ? true
                        : new WP_Error('rest_invalid_param', __('batch_id must be a UUID v4.', 'wp-woocommerce-products-list'), ['status' => 400]),
                ],
                'source' => ['type' => 'string', 'enum' => Table::SOURCES, 'default' => 'bulk'],
                'action' => [
                    'type' => 'string',
                    'description' => 'The row action the items were left out of (a registered action id, e.g. trash); the rows are logged under it. Default: update.',
                    'validate_callback' => static fn ($value): bool|WP_Error => is_string($value) && isset(ActionsController::handlers()[$value])
                        ? true
                        : new WP_Error('rest_invalid_param', __('action must be a registered action id.', 'wp-woocommerce-products-list'), ['status' => 400]),
                ],
                'items' => [
                    'type' => 'array',
                    'required' => true,
                    'minItems' => 1,
                    'maxItems' => self::SKIPPED_MAX,
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'id' => ['type' => 'integer', 'minimum' => 1, 'required' => true],
                            'reason' => ['type' => 'string', 'enum' => self::SKIP_REASONS, 'required' => true],
                            'fields' => ['type' => 'array', 'items' => ['type' => 'string'], 'maxItems' => 50],
                            'message' => ['type' => 'string', 'maxLength' => 500],
                        ],
                    ],
                ],
            ],
        ]);
    }

    /** Items one POST /log/skipped records at most. */
    public const SKIPPED_MAX = 100;

    /**
     * Why the app left an item of a batch unwritten. Each gets a log row
     * with status `skipped` so History says why an item kept its value.
     */
    public const SKIP_REASONS = ['trashed', 'deleted', 'conflict', 'locked', 'editing', 'no_stock_management', 'has_sale', 'no_sale_price', 'below_zero', 'not_applicable', 'unchanged', 'failed', 'other'];

    /**
     * POST /log/skipped: record the items a save left out on the client
     * (moved to the Trash meanwhile, no stock management, ...) as `skipped`
     * rows of the batch, one per item: `field` is the intended field when
     * there is one, the context's `fields` lists them all. `action` (a
     * registered action id) logs them under that row action (a failed
     * Trash reads "Move to Trash" in History), `update` otherwise. Only the user's own batch: a batch id that already holds
     * another user's rows is refused.
     */
    public function skipped(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $batchId = (string) $request['batch_id'];

        if ($this->isOthers($batchId)) {
            return new WP_Error('wc_products_list_batch_shared', __('This batch belongs to another user.', 'wp-woocommerce-products-list'), ['status' => 409]);
        }

        $items = (array) $request['items'];
        $action = is_string($request['action']) && $request['action'] !== '' ? (string) $request['action'] : 'update';
        $ids = array_values(array_unique(array_map(static fn ($item): int => (int) ($item['id'] ?? 0), $items)));
        _prime_post_caches($ids, false, false);

        $rows = [];
        $logged = [];

        foreach ($items as $item) {
            $id = (int) ($item['id'] ?? 0);
            $post = $id > 0 ? get_post($id) : null;

            // Only products and variations, and only ones the user may edit (a deleted one: as given).
            if ($post !== null && (! in_array($post->post_type, ['product', 'product_variation'], true) || ! current_user_can('edit_post', $id))) {
                continue;
            }

            $reason = (string) ($item['reason'] ?? 'other');
            $message = isset($item['message']) && is_string($item['message']) && trim($item['message']) !== ''
                ? mb_substr(sanitize_text_field($item['message']), 0, 500)
                : self::skipMessage($reason);
            $fields = array_values(array_unique(array_filter(array_map(
                static fn ($field): string => substr(preg_replace('/[^A-Za-z0-9_.:-]/', '', (string) $field) ?? '', 0, 100),
                is_array($item['fields'] ?? null) ? $item['fields'] : []
            ))));
            $isVariation = $post !== null && $post->post_type === 'product_variation';

            // One row per item, not per field: a 600-variation sale that
            // skips the ones already on sale is 600 rows, not 2400. The
            // fields are in the context (and in `field` when there is one).
            $rows[] = [
                'batch_id' => $batchId,
                'source' => (string) $request['source'],
                'action' => $action,
                'object_type' => $isVariation ? 'variation' : 'product',
                'object_id' => $id,
                'parent_id' => $isVariation ? (int) $post->post_parent : 0,
                'field' => count($fields) === 1 ? $fields[0] : '',
                // A write that failed is an error of the batch (History counts
                // it as failed), not an item the save chose to leave out.
                'status' => $reason === 'failed' ? Logger::STATUS_ERROR : Logger::STATUS_SKIPPED,
                'message' => $message,
                'context' => ['reason' => $reason] + ($fields !== [] ? ['fields' => $fields] : []),
            ];

            $logged[] = $id;
        }

        Logger::log($rows);
        Logger::flush();

        return rest_ensure_response(['batch_id' => $batchId, 'logged' => $logged, 'rows' => count($rows)]);
    }

    /**
     * POST /log/batch/{id}/close: the app's save of the batch is over
     * (docs/contracts.md §3.6). Drops the batch's running marker, so
     * History may plan, check and revert it at once. The writer of the
     * batch closes it; a user with the log capability may also close
     * (dismiss) one that is no longer running.
     */
    public function close(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $batchId = (string) $request['batch_id'];
        $marker = BatchState::get($batchId);

        if ($marker !== null && $marker['user'] !== get_current_user_id()) {
            if (BatchState::stateOf($marker) === BatchState::STATE_RUNNING || ! current_user_can(Plugin::logCapability())) {
                return new WP_Error('wc_products_list_batch_shared', __('This batch belongs to another user.', 'wp-woocommerce-products-list'), ['status' => 403]);
            }
        }

        return rest_ensure_response(['batch_id' => $batchId, 'closed' => BatchState::close($batchId)]);
    }

    /**
     * 409 while the batch is still being written (a save in another tab
     * or by another user), null otherwise.
     */
    public static function runningError(string $batchId): ?WP_Error
    {
        if (! BatchState::running($batchId)) {
            return null;
        }

        return new WP_Error(
            BatchState::RUNNING_ERROR,
            __('This update is still running (in another tab or by another user). Revert it when it is done.', 'wp-woocommerce-products-list'),
            ['status' => 409]
        );
    }

    public static function skipMessage(string $reason): string
    {
        return match ($reason) {
            'trashed' => __('Skipped: moved to the Trash meanwhile.', 'wp-woocommerce-products-list'),
            'deleted' => __('Skipped: deleted meanwhile.', 'wp-woocommerce-products-list'),
            'conflict' => __('Skipped: changed by someone else since the editor opened.', 'wp-woocommerce-products-list'),
            'locked' => __('Skipped: another save of this item was running.', 'wp-woocommerce-products-list'),
            'editing' => __('Skipped: another user had it open in the product editor.', 'wp-woocommerce-products-list'),
            'no_stock_management' => __('Skipped: stock is not managed for this item.', 'wp-woocommerce-products-list'),
            'has_sale' => __('Skipped: it already had a sale.', 'wp-woocommerce-products-list'),
            'no_sale_price' => __('Skipped: it has no sale price to adjust.', 'wp-woocommerce-products-list'),
            'below_zero' => __('Skipped: the change would have gone below zero.', 'wp-woocommerce-products-list'),
            'not_applicable' => __('Skipped: the field does not apply to this item.', 'wp-woocommerce-products-list'),
            'unchanged' => __('Skipped: it already had this value.', 'wp-woocommerce-products-list'),
            'failed' => __('Not saved: the request failed.', 'wp-woocommerce-products-list'),
            default => __('Skipped.', 'wp-woocommerce-products-list'),
        };
    }

    /** Whether rows of another user already carry the batch id. */
    private function isOthers(string $batchId): bool
    {
        return Logger::isOthers($batchId);
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private function listArgs(): array
    {
        return [
            'page' => ['type' => 'integer', 'default' => 1, 'minimum' => 1],
            'per_page' => ['type' => 'integer', 'default' => self::PER_PAGE_DEFAULT, 'minimum' => 1, 'maximum' => self::PER_PAGE_MAX],
            'user' => ['type' => 'integer'],
            'source' => ['type' => 'string'],
            'since' => ['type' => 'string'],
            'until' => ['type' => 'string'],
            'batch' => ['type' => 'string', 'description' => 'A batch id, or the start of one (at least 4 characters, the short id History shows).'],
            'search' => ['type' => 'string', 'description' => 'Text in a row (field, values, message) or in the name of the product it is about; on /log/batches, the batches that touched such a product.'],
        ];
    }

    public function list(WP_REST_Request $request): WP_REST_Response
    {
        global $wpdb;

        [$where, $values] = $this->where($request, true);
        $table = Table::name();
        $page = max(1, (int) $request['page']);
        $perPage = min(self::PER_PAGE_MAX, max(1, (int) $request['per_page']));

        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $total = (int) $wpdb->get_var($this->prepare("SELECT COUNT(*) FROM {$table} WHERE {$where}", $values));
        $rows = $wpdb->get_results($this->prepare(
            "SELECT * FROM {$table} WHERE {$where} ORDER BY id DESC LIMIT %d OFFSET %d",
            array_merge($values, [$perPage, ($page - 1) * $perPage])
        ), ARRAY_A);
        // phpcs:enable

        $items = $this->formatRows(is_array($rows) ? $rows : []);

        return $this->paged($items, $total, $perPage);
    }

    /** The users with log rows, for the History screen's User filter: `[{id, name}]` sorted by name. */
    public function logUsers(): WP_REST_Response
    {
        global $wpdb;

        $table = Table::name();
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $ids = $wpdb->get_col("SELECT DISTINCT user_id FROM {$table} WHERE user_id > 0");
        $users = array_values($this->users(is_array($ids) ? $ids : []));

        usort($users, static fn (array $a, array $b): int => strcasecmp((string) $a['name'], (string) $b['name']) ?: $a['id'] <=> $b['id']);

        return rest_ensure_response($users);
    }

    public function batches(WP_REST_Request $request): WP_REST_Response
    {
        global $wpdb;

        [$where, $values] = $this->where($request, false);
        $table = Table::name();
        $page = max(1, (int) $request['page']);
        $perPage = min(self::PER_PAGE_MAX, max(1, (int) $request['per_page']));

        // Source: a bulk edit that also staged an action (a language tool) is a bulk edit, so `action` is the source only when nothing else is (MIN() would pick it first).
        // The same rule as Revert::plan(): a batch is revertable when an ok row with a field is not a trash/restore/delete/duplicate/create row.
        $notRevertable = implode(',', array_map(static fn (string $action): string => "'".esc_sql($action)."'", Revert::NOT_REVERTABLE));
        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $total = (int) $wpdb->get_var($this->prepare("SELECT COUNT(DISTINCT batch_id) FROM {$table} WHERE {$where}", $values));
        // The page's batches first, from the two columns the order needs; the
        // aggregate below then reads those batches' rows only, not the whole
        // table (about 1 s for 104k rows on ddev, growing with retention).
        $pageIds = $wpdb->get_col($this->prepare(
            "SELECT batch_id FROM {$table} WHERE {$where} GROUP BY batch_id ORDER BY MIN(created_at) DESC, MAX(id) DESC LIMIT %d OFFSET %d",
            array_merge($values, [$perPage, ($page - 1) * $perPage])
        ));
        $pageIds = is_array($pageIds) ? array_map('strval', $pageIds) : [];
        $in = $pageIds === [] ? "''" : implode(',', array_fill(0, count($pageIds), '%s'));
        $rows = $pageIds === [] ? [] : $wpdb->get_results($this->prepare(
            "SELECT batch_id, MIN(created_at) AS created_at, MIN(user_id) AS user_id, COALESCE(MIN(IF(source <> 'action', source, NULL)), MIN(source)) AS source,
                SUM(status <> 'skipped') AS row_count, COUNT(DISTINCT IF(status <> 'skipped', object_id, NULL)) AS object_count, COUNT(DISTINCT user_id) AS user_count, MAX(id) AS last_id,
                SUM(action NOT IN ({$notRevertable}) AND object_type <> 'term' AND status = 'ok' AND field <> '') AS updates,
                SUM(status = 'error') AS errors,
                COUNT(DISTINCT IF(status = 'skipped', object_id, NULL)) AS skipped_count,
                COUNT(DISTINCT IF(object_type = 'product' AND status <> 'skipped', object_id, NULL)) AS product_count,
                COUNT(DISTINCT IF(object_type = 'variation' AND status <> 'skipped', object_id, NULL)) AS variation_count,
                COUNT(DISTINCT IF(object_type = 'variation' AND status <> 'skipped', parent_id, NULL)) AS parent_count,
                GROUP_CONCAT(DISTINCT IF(status <> 'skipped', action, NULL) ORDER BY action SEPARATOR ',') AS actions,
                MAX(reverts) AS reverts,
                MIN(IF(action NOT IN ('update', 'create'), id, NULL)) AS action_row,
                GROUP_CONCAT(DISTINCT IF(status = 'skipped' AND JSON_VALID(context), JSON_UNQUOTE(JSON_EXTRACT(context, '$.reason')), NULL) SEPARATOR ',') AS skipped_reasons,
                GROUP_CONCAT(DISTINCT IF(status <> 'skipped', field, NULL) ORDER BY field SEPARATOR ',') AS fields,
                GROUP_CONCAT(DISTINCT IF(status = 'skipped', field, NULL) ORDER BY field SEPARATOR ',') AS skipped_fields,
                GROUP_CONCAT(DISTINCT IF(status <> 'skipped' AND source <> 'action' AND action IN ('update', 'create'), field, NULL) ORDER BY field SEPARATOR ',') AS update_fields
             FROM {$table} WHERE ({$where}) AND batch_id IN ({$in})
             GROUP BY batch_id ORDER BY created_at DESC, last_id DESC",
            array_merge($values, $pageIds)
        ), ARRAY_A);
        // phpcs:enable

        $rows = is_array($rows) ? $rows : [];
        $users = $this->users(array_column($rows, 'user_id'));
        $revertedBy = $this->revertedBy(array_column($rows, 'batch_id'));
        $markers = BatchState::many(array_map('strval', array_column($rows, 'batch_id')));
        $actionRows = $this->actionRows(array_column($rows, 'action_row'));
        $items = [];

        foreach ($rows as $row) {
            $items[] = [
                'batch_id' => (string) $row['batch_id'],
                'created_at' => $this->localIso((string) $row['created_at']),
                'created_at_gmt' => $this->gmtIso((string) $row['created_at']),
                'user' => $users[(int) $row['user_id']] ?? ['id' => (int) $row['user_id'], 'name' => ''],
                'source' => (string) $row['source'],
                'rows' => (int) $row['row_count'],
                'objects' => (int) $row['object_count'],
                'users' => (int) $row['user_count'],
                'fields' => array_values(array_filter(explode(',', (string) $row['fields']), static fn (string $field): bool => $field !== '')),
                'actions' => array_values(array_filter(explode(',', (string) $row['actions']), static fn (string $action): bool => $action !== '')),
                // The fields of the batch's own field edits (update and create rows not written by an action).
                'update_fields' => array_values(array_filter(explode(',', (string) $row['update_fields']), static fn (string $field): bool => $field !== '')),
                'products' => (int) $row['product_count'],
                'variations' => (int) $row['variation_count'],
                'parents' => (int) $row['parent_count'],
                'errors' => (int) $row['errors'],
                // Items in the batch's scope that were left unwritten (status `skipped` rows).
                'skipped' => (int) $row['skipped_count'],
                // Why: the `reason` of the skipped rows (`unchanged`, `trashed`, `no_stock_management`, ...).
                'skipped_reasons' => array_values(array_filter(explode(',', (string) $row['skipped_reasons']), static fn (string $reason): bool => $reason !== '' && $reason !== 'null')),
                // The fields of those rows: a batch refused on every item still says what it was about.
                'skipped_fields' => array_values(array_filter(explode(',', (string) ($row['skipped_fields'] ?? '')), static fn (string $field): bool => $field !== '')),
                'revertable' => (int) $row['updates'] > 0 && (int) $row['user_count'] <= 1,
                'reverts' => (string) $row['reverts'] !== '' ? (string) $row['reverts'] : null,
                'reverted_by' => $revertedBy[(string) $row['batch_id']] ?? null,
                // `running` while the batch is still being written, `interrupted` when a
                // save that registered its planned count stopped before it was closed.
                'state' => BatchState::stateOf($markers[(string) $row['batch_id']] ?? null),
                'planned' => isset($markers[(string) $row['batch_id']]) && $markers[(string) $row['batch_id']]['planned'] > 0 ? $markers[(string) $row['batch_id']]['planned'] : null,
            ];

            $actionRow = $actionRows[(int) ($row['action_row'] ?? 0)] ?? null;
            $index = array_key_last($items);
            $actionSummary = self::batchSummary(
                $actionRow !== null ? (string) $actionRow['action'] : null,
                $actionRow !== null ? $actionRow['context'] : [],
                $items[$index]
            );
            // The action's own name ("Edit translated text: Svenska Name"), also when the batch edited fields besides.
            $items[$index]['action_summary'] = $actionSummary;
            $items[$index]['summary'] = self::mixedSummary($actionSummary, $items[$index]['update_fields']);
        }

        return $this->paged($items, $total, $perPage);
    }

    public const FILTER_BATCH_SUMMARY = 'wc_products_list/log_batch_summary';

    /**
     * The action and decoded context of log rows by id.
     *
     * @param  array<int, mixed>  $ids
     * @return array<int, array{action: string, context: array<string, mixed>}>
     */
    private function actionRows(array $ids): array
    {
        global $wpdb;

        $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));

        if ($ids === []) {
            return [];
        }

        $table = Table::name();
        $placeholders = implode(',', array_fill(0, count($ids), '%d'));
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $rows = $wpdb->get_results($wpdb->prepare("SELECT id, action, context FROM {$table} WHERE id IN ({$placeholders})", $ids), ARRAY_A);
        $byId = [];

        foreach (is_array($rows) ? $rows : [] as $row) {
            $context = json_decode((string) ($row['context'] ?? ''), true);
            $byId[(int) $row['id']] = ['action' => (string) $row['action'], 'context' => is_array($context) ? $context : []];
        }

        return $byId;
    }

    /**
     * A batch's one-line description for a person: what an action batch
     * did ("Move to Trash", "Duplicate"), null for a batch of field edits
     * (History lists its fields). Integrations name their own actions
     * through `wc_products_list/log_batch_summary`, from the action's
     * args in the row's context (languages, fields, the operation).
     *
     * @param  array<string, mixed>  $context  the context of the batch's first action row (`args` holds the action's args)
     * @param  array<string, mixed>  $batch  the batch as GET /log/batches returns it
     */
    public static function batchSummary(?string $action, array $context, array $batch): ?string
    {
        $summary = match ($action) {
            null => null,
            'trash' => __('Move to Trash', 'wp-woocommerce-products-list'),
            'restore' => __('Restore from Trash', 'wp-woocommerce-products-list'),
            'delete' => __('Delete permanently', 'wp-woocommerce-products-list'),
            'duplicate' => __('Duplicate', 'wp-woocommerce-products-list'),
            'publish' => __('Publish', 'wp-woocommerce-products-list'),
            'draft' => __('Set to draft', 'wp-woocommerce-products-list'),
            'feature' => ($context['args']['featured'] ?? true) ? __('Mark as featured', 'wp-woocommerce-products-list') : __('Remove from featured', 'wp-woocommerce-products-list'),
            Logger::ACTION_TRANSLATE_TERM => __('Translate attribute term', 'wp-woocommerce-products-list'),
            default => null,
        };

        /**
         * Filters the one-line description of a batch in History. Return
         * a translated string for your own action ids; null leaves the
         * app to describe the batch by its fields.
         *
         * @param  ?string  $summary
         * @param  ?string  $action  the batch's action id (null for a batch of field edits)
         * @param  array<string, mixed>  $args  the action's sanitized args, from the row's context
         * @param  array<string, mixed>  $batch  the batch row (fields, actions, products, variations, ...)
         */
        $summary = apply_filters(self::FILTER_BATCH_SUMMARY, $summary, $action, is_array($context['args'] ?? null) ? $context['args'] : [], $batch);

        return is_string($summary) && $summary !== '' ? $summary : null;
    }

    /** How many field names a mixed batch's summary lists before "+N more". */
    public const SUMMARY_FIELDS = 4;

    /**
     * The summary of a batch that may mix field edits with an action (a
     * bulk edit that also staged a language tool): the action's name alone
     * would hide the edited fields, so they come first ("Sale price, Date
     * on sale from + Edit translated text: Svenska Name"). Null for a batch
     * without an action: History lists its fields itself.
     *
     * @param  array<int, string>  $updateFields
     */
    public static function mixedSummary(?string $actionSummary, array $updateFields): ?string
    {
        if ($actionSummary === null || $updateFields === []) {
            return $actionSummary;
        }

        $labels = array_values(array_unique(array_map([Revert::class, 'fieldLabel'], $updateFields)));
        $fields = implode(', ', array_slice($labels, 0, self::SUMMARY_FIELDS));

        if (count($labels) > self::SUMMARY_FIELDS) {
            $fields = sprintf(
                /* translators: 1: the first field names, 2: how many more */
                __('%1$s +%2$d more', 'wp-woocommerce-products-list'),
                $fields,
                count($labels) - self::SUMMARY_FIELDS
            );
        }

        return sprintf(
            /* translators: 1: the edited fields ("Sale price, Date on sale from"), 2: the action's name ("Edit translated text: Svenska Name") */
            __('%1$s + %2$s', 'wp-woocommerce-products-list'),
            $fields,
            $actionSummary
        );
    }

    /**
     * What a revert of the batch would write: the objects in write order,
     * cut into the chunks the app posts one by one, plus the rows that
     * are skipped. The columns the plan needs, not the values.
     */
    public function batch(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        global $wpdb;

        $batchId = (string) $request['batch_id'];
        $table = Table::name();
        $running = self::runningError($batchId);

        if ($running !== null) {
            return $running;
        }

        // The plan from SQL: the counts, then the objects a revert writes
        // (one row per object, by the rule of Revert::plan()), and full rows
        // only for the rest (skipped and left-out reasons). A 24k-row batch
        // no longer loads every row into PHP.
        [$revertable, $values] = self::revertableCondition();
        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $counts = $wpdb->get_row($wpdb->prepare(
            "SELECT COUNT(*) AS n, SUM(status <> 'skipped') AS changes, SUM(status = 'error') AS failed, COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT IF(status = 'skipped', object_id, NULL)) AS left_out FROM {$table} WHERE batch_id = %s",
            $batchId
        ), ARRAY_A);

        if (! is_array($counts) || (int) $counts['n'] === 0) {
            return new WP_Error('wc_products_list_batch_not_found', __('No such batch.', 'wp-woocommerce-products-list'), ['status' => 404]);
        }

        $objects = $wpdb->get_results($wpdb->prepare(
            "SELECT object_id, object_type, parent_id, MIN(id) AS first_id FROM {$table} WHERE batch_id = %s AND {$revertable} GROUP BY object_id, object_type, parent_id ORDER BY first_id ASC",
            array_merge([$batchId], $values)
        ), ARRAY_A);
        $others = $wpdb->get_results($wpdb->prepare(
            "SELECT id, object_id, object_type, parent_id, action, status, field, user_id, batch_id, IF(status = 'skipped', context, NULL) AS skip_context FROM {$table} WHERE batch_id = %s AND NOT ({$revertable}) ORDER BY id ASC",
            array_merge([$batchId], $values)
        ), ARRAY_A);
        // phpcs:enable

        $ids = self::writeOrder(is_array($objects) ? $objects : []);
        $others = is_array($others) ? $others : [];
        $written = array_flip($ids);
        $skipped = array_values(array_filter(Revert::objects($others)['skipped'], static fn (array $item): bool => $item['object_type'] === 'term' || ! isset($written[(int) $item['id']])));
        $chunk = Revert::chunk();
        $users = (int) $counts['users'];

        return rest_ensure_response([
            'batch_id' => $batchId,
            // Rows of changes (skipped rows say what was left out, they changed nothing).
            'rows' => (int) $counts['changes'],
            'objects' => count($ids),
            'users' => $users,
            'chunk' => $chunk,
            'chunks' => array_chunk($ids, $chunk),
            'skipped' => $skipped,
            // Rows of changes that failed when they were made: nothing to put back.
            'failed' => (int) $counts['failed'],
            // Items the batch left unwritten (status `skipped`): nothing to put back.
            'left_out' => (int) $counts['left_out'],
            // Why they were left out: reason => items (`unchanged`: it already had the value).
            'left_out_reasons' => self::leftOutReasons($others),
            'revertable' => $ids !== [] && $users <= 1,
            'reverted_by' => $this->revertedBy([$batchId])[$batchId] ?? null,
            'state' => BatchState::state($batchId),
        ]);
    }

    /**
     * The SQL form of Revert::plan()'s rule for a row a revert writes: an
     * ok row with a field and an object, of a revertable action, not masked.
     *
     * @return array{0: string, 1: array<int, string>}
     */
    public static function revertableCondition(): array
    {
        $notRevertable = implode(',', array_fill(0, count(Revert::NOT_REVERTABLE), '%s'));
        $masked = implode(',', array_fill(0, count(Recorder::MASKED_KEYS), '%s'));

        return [
            "(status = 'ok' AND field <> '' AND object_id <> 0 AND object_type <> 'term' AND action NOT IN ({$notRevertable}) AND field NOT IN ({$masked}))",
            array_merge(Revert::NOT_REVERTABLE, Recorder::MASKED_KEYS),
        ];
    }

    /**
     * Object ids in the order Revert::objects() writes them: products in
     * order of their first row, then variations grouped by parent (parents
     * in order of their first variation row).
     *
     * @param  array<int, array<string, mixed>>  $objects  object_id, object_type, parent_id, first_id; by first_id
     * @return array<int, int>
     */
    public static function writeOrder(array $objects): array
    {
        $products = [];
        $variations = [];

        foreach ($objects as $object) {
            $id = (int) $object['object_id'];

            if ((string) $object['object_type'] === 'variation') {
                $variations[(int) $object['parent_id']][$id] = $id;
            } else {
                $products[$id] = $id;
            }
        }

        $ids = array_values($products);

        foreach ($variations as $byId) {
            foreach ($byId as $id) {
                $ids[] = $id;
            }
        }

        return array_values(array_unique($ids));
    }

    /**
     * Items per skip reason among a batch's `skipped` rows.
     *
     * @param  array<int, array<string, mixed>>  $rows  with `skip_context` (the context of a skipped row)
     * @return array<string, int>
     */
    public static function leftOutReasons(array $rows): array
    {
        $objects = [];

        foreach ($rows as $row) {
            if (($row['status'] ?? '') !== Logger::STATUS_SKIPPED) {
                continue;
            }

            $context = json_decode((string) ($row['skip_context'] ?? ''), true);
            $reason = is_array($context) && is_string($context['reason'] ?? null) && $context['reason'] !== '' ? $context['reason'] : 'other';
            $objects[$reason][(int) $row['object_id']] = true;
        }

        return array_map('count', $objects);
    }

    /**
     * Revert a batch (up to `Revert::CHUNK` objects) or, with `ids`, one
     * chunk of it under the `revert_batch_id` the app keeps for all the
     * chunks. A larger batch without `ids` is refused with the chunks to
     * post, so no request ever writes more than a chunk.
     */
    public function revert(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        global $wpdb;

        $batchId = (string) $request['batch_id'];
        $table = Table::name();
        $ids = $request->get_param('ids');
        $ids = is_array($ids) ? array_values(array_unique(array_filter(array_map('intval', $ids)))) : null;

        $chunk = Revert::chunk();

        if ($ids !== null && ($ids === [] || count($ids) > $chunk)) {
            return new WP_Error('wc_products_list_invalid_ids', sprintf(
                /* translators: %d: objects per request */
                __('ids must name between 1 and %d objects.', 'wp-woocommerce-products-list'),
                $chunk
            ), ['status' => 400]);
        }

        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        if ($ids === null) {
            $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batchId), ARRAY_A);
        } else {
            $placeholders = implode(',', array_fill(0, count($ids), '%d'));
            $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s AND object_id IN ({$placeholders}) ORDER BY id ASC", array_merge([$batchId], $ids)), ARRAY_A);
        }
        // phpcs:enable

        if (! is_array($rows) || $rows === []) {
            return new WP_Error('wc_products_list_batch_not_found', __('No such batch.', 'wp-woocommerce-products-list'), ['status' => 404]);
        }

        if ($this->isShared($batchId)) {
            return new WP_Error('wc_products_list_batch_shared', __('This batch holds changes by more than one user and cannot be reverted as one.', 'wp-woocommerce-products-list'), ['status' => 409]);
        }

        $running = self::runningError($batchId);

        if ($running !== null) {
            return $running;
        }

        if ($ids === null) {
            $objects = array_column(Revert::objects($rows)['objects'], 'id');

            if (count($objects) > $chunk) {
                return new WP_Error('wc_products_list_revert_too_large', sprintf(
                    /* translators: 1: number of objects, 2: objects per request */
                    __('This batch changed %1$d items; a revert is posted in chunks of %2$d (see GET /log/batch/{id}).', 'wp-woocommerce-products-list'),
                    count($objects),
                    $chunk
                ), ['status' => 400, 'objects' => count($objects), 'chunk' => $chunk, 'chunks' => array_chunk($objects, $chunk)]);
            }
        }

        $fields = $request->get_param('fields');
        $revertBatchId = $request->get_param('revert_batch_id');

        if (is_string($revertBatchId) && $revertBatchId !== '' && $this->isOthers($revertBatchId)) {
            return new WP_Error('wc_products_list_batch_shared', __('This batch id belongs to another user.', 'wp-woocommerce-products-list'), ['status' => 409]);
        }

        // One revert of a batch at a time: a second tab (or user) starting
        // the same revert is told so instead of racing the first. The
        // chunks of one revert (one revert batch id, posted side by side)
        // share the claim.
        $ownId = is_string($revertBatchId) && $revertBatchId !== '';
        $claim = $ownId ? $revertBatchId : wp_generate_uuid4();

        if (! Concurrency::claimRevert($batchId, $claim)) {
            return Concurrency::revertRunningError();
        }

        try {
            return rest_ensure_response(Revert::apply(
                $rows,
                is_string($fields) ? $fields : null,
                is_string($revertBatchId) ? $revertBatchId : null,
                (bool) $request->get_param('force'),
                $batchId,
                (bool) $request->get_param('relative')
            ));
        } finally {
            Concurrency::releaseRevert($batchId, $claim, $ownId);
        }
    }

    /**
     * GET /log/batch/{id}/check: a dry run of the revert for one chunk of
     * the batch (`ids`, or the first chunk). Says which items changed
     * again since the batch (an order, a stock movement, another edit) or
     * were already put back by an earlier revert, and would be left as
     * they are; writes nothing.
     */
    public function check(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        global $wpdb;

        $batchId = (string) $request['batch_id'];
        $table = Table::name();
        $chunk = Revert::chunk();
        $ids = $request->get_param('ids');
        $ids = is_array($ids) ? array_values(array_unique(array_filter(array_map('intval', $ids)))) : null;

        if ($ids !== null && ($ids === [] || count($ids) > $chunk)) {
            return new WP_Error('wc_products_list_invalid_ids', sprintf(
                /* translators: %d: objects per request */
                __('ids must name between 1 and %d objects.', 'wp-woocommerce-products-list'),
                $chunk
            ), ['status' => 400]);
        }

        $running = self::runningError($batchId);

        if ($running !== null) {
            return $running;
        }

        if ($ids !== null) {
            // One chunk of a larger batch: read that chunk's rows only. The app
            // checks every chunk of a batch, so loading the whole batch here
            // made a 24k-row batch cost 243 x 24k rows (0.5-0.7 s each).
            $total = $this->revertableObjectCount($batchId);

            if ($total === null) {
                return new WP_Error('wc_products_list_batch_not_found', __('No such batch.', 'wp-woocommerce-products-list'), ['status' => 404]);
            }

            $placeholders = implode(',', array_fill(0, count($ids), '%d'));
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
            $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s AND object_id IN ({$placeholders}) ORDER BY id ASC", array_merge([$batchId], $ids)), ARRAY_A);
            $rows = is_array($rows) ? $rows : [];
            $checked = array_values(array_intersect(array_column(Revert::objects($rows)['objects'], 'id'), $ids));
        } else {
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
            $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batchId), ARRAY_A);

            if (! is_array($rows) || $rows === []) {
                return new WP_Error('wc_products_list_batch_not_found', __('No such batch.', 'wp-woocommerce-products-list'), ['status' => 404]);
            }

            $objects = array_column(Revert::objects($rows)['objects'], 'id');
            $total = count($objects);
            $checked = array_slice($objects, 0, $chunk);
        }

        $keep = array_flip($checked);
        $rows = array_values(array_filter($rows, static fn (array $row): bool => isset($keep[(int) $row['object_id']])));
        $changed = Revert::check($rows, $batchId);

        return rest_ensure_response([
            'batch_id' => $batchId,
            'checked' => count($checked),
            'objects' => $total,
            // Every object of the batch was checked (it fits one chunk, or `ids` named the rest).
            'complete' => count($checked) === $total,
            // Items a revert would leave alone: changed since, or already put back.
            'changed' => count($changed),
            'already_reverted' => count(array_filter($changed, static fn (array $item): bool => $item['already_reverted'] !== [])),
            'items' => $changed,
        ]);
    }

    /**
     * The number of objects a revert of the batch writes, by the rule of
     * `Revert::plan()` (an ok row with a field, of a revertable action, not
     * masked), counted in SQL; null when the batch has no rows at all.
     */
    private function revertableObjectCount(string $batchId): ?int
    {
        global $wpdb;

        $table = Table::name();
        [$revertable, $values] = self::revertableCondition();
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $row = $wpdb->get_row($wpdb->prepare(
            "SELECT COUNT(*) AS n, COUNT(DISTINCT IF({$revertable}, object_id, NULL)) AS objects FROM {$table} WHERE batch_id = %s",
            array_merge($values, [$batchId])
        ), ARRAY_A);

        return is_array($row) && (int) $row['n'] > 0 ? (int) $row['objects'] : null;
    }

    /**
     * Whether rows of more than one user share the batch id. The id is a
     * UUID the app generates per gesture (`ListMode::isBatchId()`), so
     * this only happens when a client replays somebody else's id; a
     * revert works on the batch as a whole and must not reach into
     * another user's changes.
     */
    private function isShared(string $batchId): bool
    {
        global $wpdb;

        $table = Table::name();

        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        return (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(DISTINCT user_id) FROM {$table} WHERE batch_id = %s", $batchId)) > 1;
    }

    /**
     * @return array{0: string, 1: array<int, int|string>}
     */
    private function where(WP_REST_Request $request, bool $rowFilters): array
    {
        $where = ['1=1'];
        $values = [];

        if ($request['user'] !== null && $request['user'] !== '') {
            $where[] = 'user_id = %d';
            $values[] = (int) $request['user'];
        }

        if (is_string($request['source']) && $request['source'] !== '') {
            $where[] = 'source = %s';
            $values[] = $request['source'];
        }

        foreach (['since' => '>=', 'until' => '<='] as $param => $operator) {
            $gmt = $this->toGmt($request[$param]);

            if ($gmt !== null) {
                $where[] = "created_at {$operator} %s";
                $values[] = $gmt;
            }
        }

        if (is_string($request['batch']) && trim($request['batch']) !== '') {
            [$condition, $value] = self::batchCondition(trim($request['batch']));
            $where[] = $condition;
            $values[] = $value;
        }

        if (! $rowFilters) {
            // Batches that touched a product whose name matches: the whole
            // batch, so its counts stay those of the batch.
            if (is_string($request['search']) && trim($request['search']) !== '') {
                [$named, $namedValues] = self::productNameCondition('%'.$this->escapeLike(trim($request['search'])).'%');
                $table = Table::name();
                $where[] = "batch_id IN (SELECT batch_id FROM {$table} WHERE {$named})";
                array_push($values, ...$namedValues);
            }

            return [implode(' AND ', $where), $values];
        }

        $byId = false;

        foreach (['object_id', 'parent_id'] as $param) {
            if ($request[$param] !== null && $request[$param] !== '') {
                $where[] = "{$param} = %d";
                $values[] = (int) $request[$param];
                $byId = true;
            }
        }

        if (is_string($request['object_type']) && in_array($request['object_type'], Logger::OBJECT_TYPES, true)) {
            $where[] = 'object_type = %s';
            $values[] = $request['object_type'];
        } elseif ($byId) {
            // A product's history never shows the rows of a term that has the same id.
            $where[] = "object_type <> 'term'";
        }

        foreach (['field', 'action'] as $param) {
            $value = $request[$param];

            if (! is_string($value) || $value === '') {
                continue;
            }

            // A skipped row of several fields has them in its context (`fields`).
            $skippedOf = $param === 'field' ? " OR (status = 'skipped' AND field = '' AND context LIKE %s)" : '';

            if (str_contains($value, '*')) {
                $where[] = "({$param} LIKE %s{$skippedOf})";
                $values[] = str_replace('*', '%', $this->escapeLike($value));

                if ($skippedOf !== '') {
                    $values[] = '%"fields":[%"'.str_replace('*', '%', $this->escapeLike(trim((string) wp_json_encode($value), '"'))).'"%';
                }
            } else {
                $where[] = "({$param} = %s{$skippedOf})";
                $values[] = $value;

                if ($skippedOf !== '') {
                    $values[] = '%"fields":[%'.$this->escapeLike((string) wp_json_encode($value)).'%';
                }
            }
        }

        if (is_string($request['search']) && trim($request['search']) !== '') {
            $like = '%'.$this->escapeLike(trim($request['search'])).'%';
            [$named, $namedValues] = self::productNameCondition($like);
            $where[] = '(field LIKE %s OR old_value LIKE %s OR new_value LIKE %s OR message LIKE %s OR '.$named.')';
            array_push($values, $like, $like, $like, $like, ...$namedValues);
        }

        return [implode(' AND ', $where), $values];
    }

    /**
     * Rows about a product (or a variation of one) whose name matches a
     * LIKE pattern. Titles of products and variations: a variation's
     * title carries its parent's name.
     *
     * @return array{0: string, 1: array<int, string>}
     */
    public static function productNameCondition(string $like): array
    {
        global $wpdb;

        $posts = $wpdb->posts;

        return [
            "(object_id IN (SELECT ID FROM {$posts} WHERE post_type IN ('product', 'product_variation') AND post_title LIKE %s) OR parent_id IN (SELECT ID FROM {$posts} WHERE post_type = 'product' AND post_title LIKE %s))",
            [$like, $like],
        ];
    }

    /**
     * The WHERE condition of a `batch` filter: the whole id, or the start
     * of one. History shows the first 8 characters of a UUID; a partial id
     * of 4 to 35 id characters matches the batches it starts.
     *
     * @return array{0: string, 1: string}
     */
    public static function batchCondition(string $batch): array
    {
        global $wpdb;

        if (strlen($batch) >= 4 && strlen($batch) < 36 && preg_match('/^[0-9A-Za-z-]+$/', $batch)) {
            return ['batch_id LIKE %s', $wpdb->esc_like($batch).'%'];
        }

        return ['batch_id = %s', $batch];
    }

    /**
     * The latest revert of each of these batches: `{batch_id, created_at,
     * created_at_gmt, user}` by the reverted batch's id. One query on the
     * indexed `reverts` column.
     *
     * @param  array<int, mixed>  $batchIds
     * @return array<string, array{batch_id: string, created_at: string, created_at_gmt: string, user: array{id: int, name: string}}>
     */
    private function revertedBy(array $batchIds): array
    {
        global $wpdb;

        $batchIds = array_values(array_unique(array_filter(array_map('strval', $batchIds), static fn (string $id): bool => $id !== '')));

        if ($batchIds === []) {
            return [];
        }

        $table = Table::name();
        $placeholders = implode(',', array_fill(0, count($batchIds), '%s'));
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $rows = $wpdb->get_results($wpdb->prepare("SELECT reverts, batch_id, MIN(created_at) AS created_at, MIN(user_id) AS user_id FROM {$table} WHERE reverts IN ({$placeholders}) GROUP BY reverts, batch_id ORDER BY created_at DESC", $batchIds), ARRAY_A);
        $rows = is_array($rows) ? $rows : [];
        $users = $this->users(array_column($rows, 'user_id'));
        $byBatch = [];

        foreach ($rows as $row) {
            // Newest first: the first revert seen of a batch is its latest.
            $byBatch[(string) $row['reverts']] ??= [
                'batch_id' => (string) $row['batch_id'],
                'created_at' => $this->localIso((string) $row['created_at']),
                'created_at_gmt' => $this->gmtIso((string) $row['created_at']),
                'user' => $users[(int) $row['user_id']] ?? ['id' => (int) $row['user_id'], 'name' => ''],
            ];
        }

        return $byBatch;
    }

    /**
     * @param  array<int, int|string>  $values
     */
    private function prepare(string $sql, array $values): string
    {
        global $wpdb;

        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        return $values === [] ? $sql : (string) $wpdb->prepare($sql, $values);
    }

    private function escapeLike(string $value): string
    {
        global $wpdb;

        return $wpdb->esc_like($value);
    }

    /**
     * @param  array<int, array<string, mixed>>  $rows
     * @return array<int, array<string, mixed>>
     */
    private function formatRows(array $rows): array
    {
        if ($rows === []) {
            return [];
        }

        $postIds = [];
        $userIds = [];

        foreach ($rows as $row) {
            $userIds[] = (int) $row['user_id'];

            if ($row['object_type'] !== 'term') {
                $postIds[] = (int) $row['object_id'];
                $postIds[] = (int) $row['parent_id'];
            }
        }

        foreach ($rows as $row) {
            if ((string) $row['action'] === 'duplicate' && (int) ($row['new_value'] ?? 0) > 0) {
                $postIds[] = (int) $row['new_value'];
            }
        }

        $postIds = array_values(array_unique(array_filter($postIds)));

        if ($postIds !== []) {
            _prime_post_caches($postIds, false, false);
        }

        $users = $this->users($userIds);
        $revertedBy = $this->revertedBy(array_column($rows, 'batch_id'));
        $items = [];

        foreach ($rows as $row) {
            $objectId = (int) $row['object_id'];
            $parentId = (int) $row['parent_id'];
            $editLink = null;

            if ($row['object_type'] === 'term') {
                // gds-woo-i18n's attribute-term translations: the id is a term's.
                $term = $objectId > 0 ? get_term($objectId) : null;
                $objectName = $term instanceof \WP_Term ? $term->name : '';

                if ($term instanceof \WP_Term && current_user_can('edit_term', $objectId)) {
                    $editLink = get_edit_term_link($objectId, $term->taxonomy, 'product') ?: null;
                }
            } else {
                $post = $objectId > 0 ? get_post($objectId) : null;
                $objectName = $post !== null ? (string) $post->post_title : '';
                $editId = $row['object_type'] === 'variation' && $parentId > 0 ? $parentId : $objectId;

                if ($editId > 0 && get_post($editId) !== null && current_user_can('edit_post', $editId)) {
                    $editLink = get_edit_post_link($editId, 'raw') ?: null;
                }
            }

            $items[] = [
                'id' => (int) $row['id'],
                'batch_id' => (string) $row['batch_id'],
                'created_at' => $this->localIso((string) $row['created_at']),
                'created_at_gmt' => $this->gmtIso((string) $row['created_at']),
                'user' => $users[(int) $row['user_id']] ?? ['id' => (int) $row['user_id'], 'name' => ''],
                'source' => (string) $row['source'],
                'action' => (string) $row['action'],
                'object_type' => (string) $row['object_type'],
                'object_id' => $objectId,
                'parent_id' => $parentId,
                'object_name' => $objectName,
                'edit_link' => $editLink,
                'field' => (string) $row['field'],
                'old_value' => $row['old_value'] === null ? null : (string) $row['old_value'],
                'new_value' => $row['new_value'] === null ? null : (string) $row['new_value'],
                'status' => (string) $row['status'],
                'message' => (string) $row['message'],
                'related' => $this->related($row),
                'reverts' => ($row['reverts'] ?? '') !== '' ? (string) $row['reverts'] : null,
                'reverted_by' => $revertedBy[(string) $row['batch_id']] ?? null,
                'skipped_fields' => $this->skippedFields($row),
            ];
        }

        return $items;
    }

    /**
     * The fields a skipped row without a `field` left out (its context's
     * `fields`), so History can name them; [] for every other row.
     *
     * @param  array<string, mixed>  $row
     * @return list<string>
     */
    private function skippedFields(array $row): array
    {
        if ((string) $row['status'] !== 'skipped' || (string) $row['field'] !== '') {
            return [];
        }

        $context = json_decode((string) ($row['context'] ?? ''), true);
        $fields = is_array($context) && is_array($context['fields'] ?? null) ? $context['fields'] : [];

        return array_values(array_filter(array_map(static fn ($field): string => is_string($field) ? $field : '', $fields), static fn (string $field): bool => $field !== ''));
    }

    /**
     * The other product a row is about: the copy a `duplicate` row
     * created (its id is the row's new value), so History can name and
     * link it. Null for every other row, and for a copy that is gone.
     *
     * @param  array<string, mixed>  $row
     * @return array{id: int, name: string, edit_link: ?string}|null
     */
    private function related(array $row): ?array
    {
        if ((string) $row['action'] !== 'duplicate') {
            return null;
        }

        $id = (int) ($row['new_value'] ?? 0);
        $post = $id > 0 ? get_post($id) : null;

        if ($post === null) {
            return null;
        }

        return [
            'id' => $id,
            'name' => (string) $post->post_title,
            'edit_link' => current_user_can('edit_post', $id) ? (get_edit_post_link($id, 'raw') ?: null) : null,
        ];
    }

    /**
     * @param  array<int, int|string>  $ids
     * @return array<int, array{id: int, name: string}>
     */
    private function users(array $ids): array
    {
        $ids = array_values(array_unique(array_map('intval', $ids)));
        $users = [];

        if ($ids !== []) {
            cache_users($ids);
        }

        foreach ($ids as $id) {
            $user = $id > 0 ? get_userdata($id) : false;
            $users[$id] = ['id' => $id, 'name' => $user ? (string) $user->display_name : ''];
        }

        return $users;
    }

    /**
     * @param  array<int, mixed>  $items
     */
    private function paged(array $items, int $total, int $perPage): WP_REST_Response
    {
        $totalPages = (int) ceil($total / $perPage);

        $response = new WP_REST_Response([
            'items' => $items,
            'total' => $total,
            'totalPages' => $totalPages,
        ]);
        $response->header('X-WP-Total', (string) $total);
        $response->header('X-WP-TotalPages', (string) $totalPages);

        return $response;
    }

    private function localIso(string $gmt): string
    {
        return get_date_from_gmt($gmt, 'Y-m-d\TH:i:s');
    }

    private function gmtIso(string $gmt): string
    {
        return str_replace(' ', 'T', $gmt);
    }

    /**
     * A `since`/`until` value (ISO in the site's timezone, or a date) to
     * a GMT MySQL datetime; null when it cannot be read.
     */
    private function toGmt(mixed $value): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }

        $value = trim($value);

        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
            $value .= ' 00:00:00';
        }

        $date = date_create_immutable($value, wp_timezone());

        if ($date === false) {
            return null;
        }

        return gmdate('Y-m-d H:i:s', $date->getTimestamp());
    }
}
