<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * GET /log, GET /log/batches, POST /log/batch/{id}/revert. See
 * docs/contracts.md §3.5 for the row shape.
 */
final class LogController
{
    public const PER_PAGE_MAX = 100;

    public const PER_PAGE_DEFAULT = 50;

    public function register(): void
    {
        $permission = static fn (): bool => current_user_can(Plugin::capability());

        register_rest_route(Plugin::REST_NAMESPACE, '/log', [
            'methods' => 'GET',
            'callback' => [$this, 'list'],
            'permission_callback' => $permission,
            'args' => $this->listArgs() + [
                'field' => ['type' => 'string'],
                'action' => ['type' => 'string'],
                'object_id' => ['type' => 'integer'],
                'parent_id' => ['type' => 'integer'],
                'batch' => ['type' => 'string'],
                'search' => ['type' => 'string'],
            ],
        ]);

        register_rest_route(Plugin::REST_NAMESPACE, '/log/batches', [
            'methods' => 'GET',
            'callback' => [$this, 'batches'],
            'permission_callback' => $permission,
            'args' => $this->listArgs(),
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
            ],
        ]);
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

    public function batches(WP_REST_Request $request): WP_REST_Response
    {
        global $wpdb;

        [$where, $values] = $this->where($request, false);
        $table = Table::name();
        $page = max(1, (int) $request['page']);
        $perPage = min(self::PER_PAGE_MAX, max(1, (int) $request['per_page']));

        // phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared
        $total = (int) $wpdb->get_var($this->prepare("SELECT COUNT(DISTINCT batch_id) FROM {$table} WHERE {$where}", $values));
        $rows = $wpdb->get_results($this->prepare(
            "SELECT batch_id, MIN(created_at) AS created_at, MIN(user_id) AS user_id, MIN(source) AS source,
                COUNT(*) AS row_count, COUNT(DISTINCT object_id) AS object_count, MAX(id) AS last_id,
                SUM(action = 'update' AND status = 'ok' AND field <> '') AS updates,
                GROUP_CONCAT(DISTINCT field ORDER BY field SEPARATOR ',') AS fields
             FROM {$table} WHERE {$where}
             GROUP BY batch_id ORDER BY created_at DESC, last_id DESC LIMIT %d OFFSET %d",
            array_merge($values, [$perPage, ($page - 1) * $perPage])
        ), ARRAY_A);
        // phpcs:enable

        $rows = is_array($rows) ? $rows : [];
        $users = $this->users(array_column($rows, 'user_id'));
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
                'fields' => array_values(array_filter(explode(',', (string) $row['fields']), static fn (string $field): bool => $field !== '')),
                'revertable' => (int) $row['updates'] > 0,
            ];
        }

        return $this->paged($items, $total, $perPage);
    }

    public function revert(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        global $wpdb;

        $batchId = (string) $request['batch_id'];
        $table = Table::name();

        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batchId), ARRAY_A);

        if (! is_array($rows) || $rows === []) {
            return new WP_Error('wc_products_list_batch_not_found', __('No such batch.', 'wp-woocommerce-products-list'), ['status' => 404]);
        }

        $fields = $request->get_param('fields');

        return rest_ensure_response(Revert::apply($rows, is_string($fields) ? $fields : null));
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

        if (! $rowFilters) {
            return [implode(' AND ', $where), $values];
        }

        foreach (['object_id', 'parent_id'] as $param) {
            if ($request[$param] !== null && $request[$param] !== '') {
                $where[] = "{$param} = %d";
                $values[] = (int) $request[$param];
            }
        }

        if (is_string($request['batch']) && $request['batch'] !== '') {
            $where[] = 'batch_id = %s';
            $values[] = $request['batch'];
        }

        foreach (['field', 'action'] as $param) {
            $value = $request[$param];

            if (! is_string($value) || $value === '') {
                continue;
            }

            if (str_contains($value, '*')) {
                $where[] = "{$param} LIKE %s";
                $values[] = str_replace('*', '%', $this->escapeLike($value));
            } else {
                $where[] = "{$param} = %s";
                $values[] = $value;
            }
        }

        if (is_string($request['search']) && trim($request['search']) !== '') {
            $like = '%'.$this->escapeLike(trim($request['search'])).'%';
            $where[] = '(field LIKE %s OR old_value LIKE %s OR new_value LIKE %s OR message LIKE %s)';
            array_push($values, $like, $like, $like, $like);
        }

        return [implode(' AND ', $where), $values];
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
            $postIds[] = (int) $row['object_id'];
            $postIds[] = (int) $row['parent_id'];
            $userIds[] = (int) $row['user_id'];
        }

        $postIds = array_values(array_unique(array_filter($postIds)));

        if ($postIds !== []) {
            _prime_post_caches($postIds, false, false);
        }

        $users = $this->users($userIds);
        $items = [];

        foreach ($rows as $row) {
            $objectId = (int) $row['object_id'];
            $parentId = (int) $row['parent_id'];
            $post = $objectId > 0 ? get_post($objectId) : null;
            $editId = $row['object_type'] === 'variation' && $parentId > 0 ? $parentId : $objectId;
            $editLink = null;

            if ($editId > 0 && get_post($editId) !== null && current_user_can('edit_post', $editId)) {
                $editLink = get_edit_post_link($editId, 'raw') ?: null;
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
                'object_name' => $post !== null ? (string) $post->post_title : '',
                'edit_link' => $editLink,
                'field' => (string) $row['field'],
                'old_value' => $row['old_value'] === null ? null : (string) $row['old_value'],
                'new_value' => $row['new_value'] === null ? null : (string) $row['new_value'],
                'status' => (string) $row['status'],
                'message' => (string) $row['message'],
            ];
        }

        return $items;
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
