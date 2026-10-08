<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Rest\Rows;
use WP_REST_Request;

/**
 * Puts a batch's `update` rows back: the old value of every field goes
 * through the same wc/v3 batch endpoints the app writes with (products in
 * one `products/batch`, variations per parent), so WooCommerce's own
 * validation, lookups and the extension save hooks all run. The writes are
 * logged as a new batch with `source=revert`, so a revert can itself be
 * reverted.
 *
 * Rows of other actions (trash, restore, delete, duplicate, create) are
 * skipped and reported as such: trash has restore, delete is final.
 *
 * @phpstan-type Plan array{
 *     products: array<int, array<string, ?string>>,
 *     variations: array<int, array<int, array<string, ?string>>>,
 *     skipped: array<int, array{id: int, object_type: string, action: string}>
 * }
 */
final class Revert
{
    public const PRODUCTS_CHUNK = 100;

    /**
     * Group a batch's rows into the writes that undo them. Only ok `update`
     * rows take part; when a field was changed more than once within the
     * batch the earliest row's old value wins, as it is the original.
     *
     * @param  array<int, array<string, mixed>>  $rows  log rows, any order
     * @return Plan
     */
    public static function plan(array $rows): array
    {
        usort($rows, static fn (array $a, array $b): int => ((int) ($a['id'] ?? 0)) <=> ((int) ($b['id'] ?? 0)));

        $plan = ['products' => [], 'variations' => [], 'skipped' => []];
        $skipped = [];

        foreach ($rows as $row) {
            $id = (int) ($row['object_id'] ?? 0);
            $type = (string) ($row['object_type'] ?? 'product');
            $action = (string) ($row['action'] ?? 'update');
            $field = (string) ($row['field'] ?? '');

            if ($id === 0) {
                continue;
            }

            if ($action !== 'update' || ($row['status'] ?? 'ok') !== 'ok' || $field === '') {
                $skipped[$type.':'.$id] ??= ['id' => $id, 'object_type' => $type, 'action' => $action];

                continue;
            }

            $old = isset($row['old_value']) ? (string) $row['old_value'] : null;

            if ($type === 'variation') {
                $parent = (int) ($row['parent_id'] ?? 0);
                $plan['variations'][$parent][$id] ??= [];

                if (! array_key_exists($field, $plan['variations'][$parent][$id])) {
                    $plan['variations'][$parent][$id][$field] = $old;
                }
            } else {
                $plan['products'][$id] ??= [];

                if (! array_key_exists($field, $plan['products'][$id])) {
                    $plan['products'][$id][$field] = $old;
                }
            }
        }

        foreach ($skipped as $key => $item) {
            // An object with both an update row and, say, a trash row is reverted
            // where it can be and not reported as skipped.
            $reverted = $item['object_type'] === 'variation'
                ? array_filter($plan['variations'], static fn (array $byId): bool => isset($byId[$item['id']])) !== []
                : isset($plan['products'][$item['id']]);

            if (! $reverted) {
                $plan['skipped'][] = $item;
            }
        }

        return $plan;
    }

    /**
     * The wc/v3 request body that sets the given fields to the given stored
     * values. `meta_data.{key}` rows become `meta_data` entries, nested
     * extension paths are rebuilt, everything else is a top-level key.
     *
     * @param  array<string, ?string>  $fields
     * @return array<string, mixed>
     */
    public static function body(int $id, array $fields): array
    {
        $body = ['id' => $id];

        foreach ($fields as $path => $stored) {
            $segments = explode('.', $path);
            $value = self::decode($stored);

            if ($segments[0] === 'meta_data') {
                $body['meta_data'][] = ['key' => implode('.', array_slice($segments, 1)), 'value' => $value];

                continue;
            }

            $target = &$body;

            foreach (array_slice($segments, 0, -1) as $segment) {
                if (! isset($target[$segment]) || ! is_array($target[$segment])) {
                    $target[$segment] = [];
                }

                $target = &$target[$segment];
            }

            $target[end($segments)] = $value;
            unset($target);
        }

        return $body;
    }

    /**
     * A stored value back into request form: JSON arrays and objects are
     * decoded, null (no value) becomes the empty string, which is how wc/v3
     * clears a price, a date or a translation.
     */
    public static function decode(?string $stored): mixed
    {
        if ($stored === null) {
            return '';
        }

        $first = substr($stored, 0, 1);

        if ($first === '[' || $first === '{') {
            $decoded = json_decode($stored, true);

            if (json_last_error() === JSON_ERROR_NONE) {
                return $decoded;
            }
        }

        return match ($stored) {
            'true' => true,
            'false' => false,
            default => $stored,
        };
    }

    /**
     * Revert a batch. Returns the action-response shape.
     *
     * @param  array<int, array<string, mixed>>  $rows  the batch's log rows
     * @return array{batch_id: string, results: array<int, array<string, mixed>>, items: array<int, mixed>}
     */
    public static function apply(array $rows, ?string $fields = null): array
    {
        $plan = self::plan($rows);
        $batchId = wp_generate_uuid4();
        $results = [];
        $items = [];

        foreach ($plan['skipped'] as $item) {
            $results[] = [
                'id' => $item['id'],
                'ok' => false,
                'code' => 'skipped',
                'message' => $item['action'] === 'delete'
                    ? __('Permanently deleted products cannot be restored.', 'wp-woocommerce-products-list')
                    : sprintf(
                        /* translators: %s: action name */
                        __('"%s" rows are not reverted.', 'wp-woocommerce-products-list'),
                        $item['action']
                    ),
            ];
        }

        foreach (array_chunk($plan['products'], self::PRODUCTS_CHUNK, true) as $chunk) {
            $update = [];

            foreach ($chunk as $id => $fieldsOfId) {
                $update[] = self::body((int) $id, $fieldsOfId);
            }

            self::dispatch('/wc/v3/products/batch', $update, $batchId, $fields, $results, $items);
        }

        foreach ($plan['variations'] as $parent => $byId) {
            foreach (array_chunk($byId, self::PRODUCTS_CHUNK, true) as $chunk) {
                $update = [];

                foreach ($chunk as $id => $fieldsOfId) {
                    $update[] = self::body((int) $id, $fieldsOfId);
                }

                self::dispatch('/wc/v3/products/'.(int) $parent.'/variations/batch', $update, $batchId, $fields, $results, $items);
            }
        }

        return ['batch_id' => $batchId, 'results' => $results, 'items' => $items];
    }

    /**
     * One internal wc/v3 batch request, in list mode, under the revert batch id.
     *
     * @param  array<int, array<string, mixed>>  $update
     * @param  array<int, array<string, mixed>>  $results
     * @param  array<int, mixed>  $items
     */
    private static function dispatch(string $route, array $update, string $batchId, ?string $fields, array &$results, array &$items): void
    {
        $request = new WP_REST_Request('POST', $route);
        $request->set_header(ListMode::HEADER, '1');
        $request->set_header(ListMode::BATCH_HEADER, $batchId);
        $request->set_header(Logger::SOURCE_HEADER, 'revert');
        $request->set_body_params(['update' => $update]);

        if ($fields !== null) {
            $request->set_query_params(['_fields' => $fields]);
        }

        $response = rest_do_request($request);
        $data = $response->get_data();

        if ($response->is_error() || ! is_array($data)) {
            $error = $response->as_error();
            $message = $error ? $error->get_error_message() : __('The revert request failed.', 'wp-woocommerce-products-list');
            $code = $error ? (string) $error->get_error_code() : 'error';

            foreach ($update as $item) {
                $results[] = ['id' => (int) $item['id'], 'ok' => false, 'code' => $code, 'message' => $message];
            }

            return;
        }

        foreach ($data['update'] ?? [] as $item) {
            if (! is_array($item)) {
                continue;
            }

            if (isset($item['error']) && is_array($item['error'])) {
                $results[] = [
                    'id' => (int) ($item['id'] ?? 0),
                    'ok' => false,
                    'code' => (string) ($item['error']['code'] ?? 'error'),
                    'message' => (string) ($item['error']['message'] ?? ''),
                ];

                continue;
            }

            $results[] = ['id' => (int) ($item['id'] ?? 0), 'ok' => true];
            $items[] = Rows::trim($item, $fields);
        }
    }
}
