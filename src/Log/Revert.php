<?php

namespace GeneroWP\ProductsList\Log;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Registry;
use GeneroWP\ProductsList\Rest\Rows;
use WP_REST_Request;

/**
 * Puts a batch's field changes back: the old value of every field goes
 * through the same wc/v3 batch endpoints the app writes with (products in
 * one `products/batch`, variations per parent), so WooCommerce's own
 * validation, lookups and the extension save hooks all run. The writes are
 * logged as a new batch with `source=revert`, so a revert can itself be
 * reverted.
 *
 * A row takes part when it is an ok row with a field: an `update` row, or
 * a row of an extension action that reported `changes` (a translation
 * copy's `i18n.se.name`), whose field path is a write path of the same
 * endpoints. Rows of the built-in trash, restore, delete, duplicate and
 * create actions are skipped and reported as such: trash has restore,
 * delete is final.
 *
 * A field somebody changed again after the batch is not put back: its
 * current value is compared with the value the batch left (the last
 * row's new value), and an object with such a field is reported with
 * code `conflict` instead of being written, unless the caller forces it.
 *
 * Large batches are reverted in chunks of `CHUNK` objects: `objects()`
 * lists what a batch would touch in the order the writes go, the
 * controller hands the app the chunks, and `apply()` takes the rows of
 * one chunk under a revert batch id the app keeps for all of them.
 *
 * @phpstan-type Plan array{
 *     products: array<int, array<string, ?string>>,
 *     variations: array<int, array<int, array<string, ?string>>>,
 *     skipped: array<int, array{id: int, object_type: string, action: string}>,
 *     final: array<int, array<string, ?string>>
 * }
 * @phpstan-type Result array{id: int, ok: bool, code?: string, message?: string}
 */
final class Revert
{
    public const PRODUCTS_CHUNK = 100;

    /** Objects per revert request; the app chunks a bigger batch. */
    public const CHUNK = 100;

    public const FILTER_CHUNK = 'wc_products_list/revert_chunk';

    /**
     * Actions whose rows a revert never writes back, whatever field they
     * carry: the built-in ones that have their own way back (or none).
     * Mirrored in resources/history/batch-scope.ts.
     */
    public const NOT_REVERTABLE = ['trash', 'restore', 'delete', 'duplicate', 'create'];

    /**
     * Whether the rows of an action are put back by a revert: any action
     * but the built-in trash/restore/delete/duplicate/create, so an
     * extension action that logs `changes` is undone the way an update is.
     */
    public static function revertable(string $action): bool
    {
        return ! in_array($action, self::NOT_REVERTABLE, true);
    }

    /**
     * Objects one revert request writes at most.
     */
    public static function chunk(): int
    {
        /**
         * Filters how many objects one revert request writes; a larger
         * batch is reverted in several requests under one batch id.
         *
         * @param  int  $chunk
         */
        return max(1, (int) apply_filters(self::FILTER_CHUNK, self::CHUNK));
    }

    /**
     * Group a batch's rows into the writes that undo them. Only ok rows
     * with a field of a revertable action take part (see `revertable()`);
     * when a field was changed more than once within the batch the earliest
     * row's old value wins, as it is the original.
     *
     * @param  array<int, array<string, mixed>>  $rows  log rows, any order
     * @return Plan
     */
    public static function plan(array $rows): array
    {
        usort($rows, static fn (array $a, array $b): int => ((int) ($a['id'] ?? 0)) <=> ((int) ($b['id'] ?? 0)));

        $plan = ['products' => [], 'variations' => [], 'skipped' => [], 'final' => []];
        $skipped = [];

        foreach ($rows as $row) {
            $id = (int) ($row['object_id'] ?? 0);
            $type = (string) ($row['object_type'] ?? 'product');
            $action = (string) ($row['action'] ?? 'update');
            $field = (string) ($row['field'] ?? '');

            // Rows of items a save or a revert left alone wrote nothing.
            if ($id === 0 || ($row['status'] ?? 'ok') === Logger::STATUS_SKIPPED) {
                continue;
            }

            if (! self::revertable($action) || ($row['status'] ?? 'ok') !== 'ok' || $field === '') {
                // A failed change wrote nothing: it is reported as such, not as its action.
                $skipped[$type.':'.$id] ??= ['id' => $id, 'object_type' => $type, 'action' => ($row['status'] ?? 'ok') === 'error' && self::revertable($action) ? 'failed' : $action];

                continue;
            }

            // The log holds a marker of the old value, not the value.
            if (Recorder::isMasked($field)) {
                $skipped[$type.':'.$id] ??= ['id' => $id, 'object_type' => $type, 'action' => 'masked'];

                continue;
            }

            $old = isset($row['old_value']) ? (string) $row['old_value'] : null;
            // Rows are in id order: the last one holds what the batch left behind.
            $plan['final'][$id][$field] = isset($row['new_value']) ? (string) $row['new_value'] : null;

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
     * A meta key whose old value is null did not exist before the change:
     * its entry carries `value: null`, which WC_Data turns into a delete of
     * the key on save, where `''` would leave an empty row behind.
     *
     * @param  array<string, ?string>  $fields
     * @return array<string, mixed>
     */
    public static function body(int $id, array $fields): array
    {
        $body = ['id' => $id];
        $nullable = self::nullableFields();

        foreach ($fields as $path => $stored) {
            $segments = explode('.', $path);
            $value = self::decode($stored);

            if ($segments[0] === 'meta_data') {
                $body['meta_data'][] = [
                    'key' => implode('.', array_slice($segments, 1)),
                    'value' => $stored === null ? null : $value,
                ];

                continue;
            }

            $target = &$body;

            foreach (array_slice($segments, 0, -1) as $segment) {
                if (! isset($target[$segment]) || ! is_array($target[$segment])) {
                    $target[$segment] = [];
                }

                $target = &$target[$segment];
            }

            // A field that had no value: wc/v3 clears an integer|null field
            // (low_stock_amount) only for `null`; `''` would be stored as 0.
            $target[end($segments)] = ($stored === null || $stored === '') && in_array($path, $nullable, true) ? null : $value;
            unset($target);
        }

        return $body;
    }

    public const FILTER_NULLABLE_FIELDS = 'wc_products_list/revert_nullable_fields';

    public const NULLABLE_FIELDS = ['low_stock_amount', 'stock_quantity'];

    /**
     * Fields a revert clears with `null` rather than `''`: the integer
     * fields wc/v3 takes as `integer|null` and turns any other empty
     * value into 0 (`wc_stock_amount('')`). An unset low stock threshold
     * means "use the store's (or the parent's)"; 0 means "never notify".
     * `stock_quantity`: `null` leaves the quantity as it is, where `''`
     * would write 0; an unset quantity goes with stock management being
     * off, which the same revert puts back and WooCommerce then clears it.
     *
     * @return array<int, string>
     */
    public static function nullableFields(): array
    {
        /**
         * Filters the fields a revert sets to `null` when their old value was empty.
         *
         * @param  mixed  $fields  a list of field paths
         */
        $fields = function_exists('apply_filters')
            ? apply_filters(self::FILTER_NULLABLE_FIELDS, self::NULLABLE_FIELDS)
            : self::NULLABLE_FIELDS;

        return array_values(array_map('strval', array_filter(is_array($fields) ? $fields : [], 'is_scalar')));
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
     * The objects a batch's rows would write, in write order (products,
     * then variations grouped by parent), each `{id, object_type,
     * parent_id, fields}`, and the ones that are skipped. Enough for the
     * app to chunk a revert and to say what it is about to do.
     *
     * @param  array<int, array<string, mixed>>  $rows
     * @return array{
     *     objects: array<int, array{id: int, object_type: string, parent_id: int, fields: array<int, string>}>,
     *     skipped: array<int, array{id: int, object_type: string, action: string}>
     * }
     */
    public static function objects(array $rows): array
    {
        $plan = self::plan($rows);
        $objects = [];

        foreach ($plan['products'] as $id => $fields) {
            $objects[] = ['id' => (int) $id, 'object_type' => 'product', 'parent_id' => 0, 'fields' => array_keys($fields)];
        }

        foreach ($plan['variations'] as $parent => $byId) {
            foreach ($byId as $id => $fields) {
                $objects[] = ['id' => (int) $id, 'object_type' => 'variation', 'parent_id' => (int) $parent, 'fields' => array_keys($fields)];
            }
        }

        return ['objects' => $objects, 'skipped' => $plan['skipped']];
    }

    /**
     * The fields of an object whose current value is not what the batch
     * left: somebody changed them again since. Compared the way the
     * recorder compares (stored form, null and '' alike).
     *
     * @param  array<string, ?string>  $final  field => the batch's new value
     * @return array<int, string>
     */
    public static function conflicts(int $id, array $final): array
    {
        return array_keys(self::conflictValues($id, $final));
    }

    /**
     * The conflicting fields of an object with their current values
     * (stored form): field => current value.
     *
     * @param  array<string, ?string>  $final  field => the batch's new value
     * @return array<string, ?string>
     */
    public static function conflictValues(int $id, array $final): array
    {
        $product = wc_get_product($id);

        if (! $product instanceof \WC_Product || $product->get_id() === 0) {
            // Gone: WooCommerce will say so when the write is attempted.
            return [];
        }

        $current = Recorder::snapshot($product, array_keys($final));
        $conflicts = [];

        foreach ($final as $field => $value) {
            if (($current[$field] ?? '') !== ($value ?? '')) {
                $conflicts[(string) $field] = $current[$field] ?? null;
            }
        }

        return $conflicts;
    }

    public const FILTER_RELATIVE_FIELDS = 'wc_products_list/revert_relative_fields';

    /**
     * Fields a revert can undo relatively: when one of them changed again
     * after the batch (a sale lowered the stock), `relative` takes the
     * batch's change off the current value instead of restoring the old
     * one, so the later change is kept.
     *
     * @return array<int, string>
     */
    public static function relativeFields(): array
    {
        /**
         * Filters the numeric fields a relative revert adjusts by the
         * batch's difference rather than restoring.
         *
         * @param  mixed  $fields  a list of field paths
         */
        $fields = apply_filters(self::FILTER_RELATIVE_FIELDS, ['stock_quantity']);

        return array_values(array_map('strval', array_filter(is_array($fields) ? $fields : [], 'is_scalar')));
    }

    /**
     * The value a relative revert writes: the current value minus what the
     * batch added (new - old). Null when any of the three is not a number.
     */
    public static function relativeValue(?string $old, ?string $new, ?string $current): ?string
    {
        foreach ([$old, $new, $current] as $value) {
            if ($value === null || ! is_numeric($value)) {
                return null;
            }
        }

        $result = (float) $current - ((float) $new - (float) $old);

        return (string) (floor($result) === $result && abs($result) < PHP_INT_MAX ? (int) $result : $result);
    }

    /**
     * A field's name for a person: the registry label, or the key in words.
     */
    public static function fieldLabel(string $field): string
    {
        $registered = null;

        foreach (Registry::fields() as $def) {
            if ($def['id'] === $field || ($def['writePath'] ?? null) === $field) {
                $registered = $def;

                break;
            }
        }

        if ($registered !== null && $registered['label'] !== '' && $registered['label'] !== $registered['id']) {
            return $registered['label'];
        }

        $words = str_replace(['meta_data.', '_', '.'], ['', ' ', ' '], $field);

        return ucfirst(trim($words));
    }

    /**
     * The original old value the plan writes for one field of one object.
     *
     * @param  Plan  $plan
     */
    private static function plannedOld(array $plan, int $id, string $field): ?string
    {
        if (isset($plan['products'][$id]) && array_key_exists($field, $plan['products'][$id])) {
            return $plan['products'][$id][$field];
        }

        foreach ($plan['variations'] as $byId) {
            if (isset($byId[$id]) && array_key_exists($field, $byId[$id])) {
                return $byId[$id][$field];
            }
        }

        return null;
    }

    /**
     * Set the value the plan writes for one field of one object.
     *
     * @param  Plan  $plan
     */
    private static function setPlanned(array &$plan, int $id, string $field, ?string $value): void
    {
        if (isset($plan['products'][$id])) {
            $plan['products'][$id][$field] = $value;

            return;
        }

        foreach ($plan['variations'] as $parent => $byId) {
            if (isset($byId[$id])) {
                $plan['variations'][$parent][$id][$field] = $value;

                return;
            }
        }
    }

    /**
     * The parent (variation) or 0 (product) of an object in the plan.
     *
     * @param  Plan  $plan
     * @return array{0: string, 1: int}
     */
    private static function planType(array $plan, int $id): array
    {
        foreach ($plan['variations'] as $parent => $byId) {
            if (isset($byId[$id])) {
                return ['variation', (int) $parent];
            }
        }

        return ['product', 0];
    }

    /**
     * Revert a batch, or one chunk of it. Returns the action-response shape.
     *
     * @param  array<int, array<string, mixed>>  $rows  the batch's log rows (of the chunk's objects)
     * @param  ?string  $batchId  the revert batch id; generated when null (one per chunked revert, kept by the app)
     * @param  bool  $force  write even where the field was changed again since the batch
     * @param  string  $reverts  the batch being reverted, stored on the rows the revert writes (`reverts` column)
     * @param  bool  $relative  where a relative field (`relativeFields()`) changed again, take the batch's change off the current value instead
     * @return array{batch_id: string, results: array<int, array<string, mixed>>, items: array<int, mixed>}
     */
    public static function apply(array $rows, ?string $fields = null, ?string $batchId = null, bool $force = false, string $reverts = '', bool $relative = false): array
    {
        if ($reverts === '') {
            $reverts = (string) ($rows[0]['batch_id'] ?? '');
        }

        Logger::setReverts($reverts);

        try {
            return self::write($rows, $fields, $batchId, $force, $relative);
        } finally {
            Logger::setReverts('');
        }
    }

    /**
     * @param  array<int, array<string, mixed>>  $rows
     * @return array{batch_id: string, results: array<int, array<string, mixed>>, items: array<int, mixed>}
     */
    private static function write(array $rows, ?string $fields, ?string $batchId, bool $force, bool $relative = false): array
    {
        $plan = self::plan($rows);
        $batchId = $batchId !== null && $batchId !== '' ? $batchId : wp_generate_uuid4();
        $results = [];
        $items = [];

        if (! $force && $plan['final'] !== []) {
            // One load per object for the conflict check: warm the caches for all of them.
            $ids = array_map('intval', array_keys($plan['final']));
            _prime_post_caches($ids, true, true);
            Rows::primeRawMetaOf($ids);
        }

        if (! $force) {
            $relativeFields = $relative ? self::relativeFields() : [];
            $skippedRows = [];

            foreach ($plan['final'] as $id => $final) {
                $id = (int) $id;
                $current = self::conflictValues($id, $final);

                if ($current === []) {
                    continue;
                }

                [$type, $parent] = self::planType($plan, $id);

                // Relative: every conflicting field is one whose change can be taken off.
                $adjusted = [];

                foreach ($current as $field => $value) {
                    $target = in_array($field, $relativeFields, true)
                        ? self::relativeValue(self::plannedOld($plan, $id, $field), $final[$field] ?? null, $value)
                        : null;

                    if ($target === null) {
                        $adjusted = null;

                        break;
                    }

                    $adjusted[$field] = $target;
                }

                if ($adjusted !== null) {
                    foreach ($adjusted as $field => $target) {
                        self::setPlanned($plan, $id, $field, $target);
                    }

                    continue;
                }

                $expected = [];

                foreach (array_keys($current) as $field) {
                    $expected[$field] = self::plannedOld($plan, $id, $field);
                }

                unset($plan['products'][$id]);

                foreach ($plan['variations'] as $variationParent => $byId) {
                    unset($plan['variations'][$variationParent][$id]);

                    if ($plan['variations'][$variationParent] === []) {
                        unset($plan['variations'][$variationParent]);
                    }
                }

                $conflicts = array_keys($current);
                $labels = array_map([self::class, 'fieldLabel'], $conflicts);
                $post = get_post($id);
                $message = sprintf(
                    /* translators: %s: comma-separated field names */
                    _n('%s was changed again after this batch and was left as it is.', '%s were changed again after this batch and were left as they are.', count($conflicts), 'wp-woocommerce-products-list'),
                    implode(', ', $labels)
                );

                $results[] = [
                    'id' => $id,
                    'ok' => false,
                    'code' => 'conflict',
                    'object_type' => $type,
                    'parent_id' => $parent,
                    'name' => $post !== null ? (string) $post->post_title : '',
                    'fields' => $conflicts,
                    'labels' => $labels,
                    // field => the value now / the value the batch left / the value a revert would put back
                    'current' => $current,
                    'batch' => array_intersect_key($final, $current),
                    'expected' => $expected,
                    // Every conflicting field can be undone relatively (`relative: true`).
                    'relative' => array_diff($conflicts, self::relativeFields()) === [],
                    'message' => $message,
                ];

                foreach ($conflicts as $field) {
                    $skippedRows[] = [
                        'batch_id' => $batchId,
                        'source' => 'revert',
                        'object_type' => $type,
                        'object_id' => $id,
                        'parent_id' => $parent,
                        'field' => $field,
                        'old_value' => $current[$field],
                        'new_value' => $expected[$field],
                        'status' => Logger::STATUS_SKIPPED,
                        'message' => $message,
                        'context' => ['reason' => 'conflict', 'batch_value' => $final[$field] ?? null],
                    ];
                }
            }

            Logger::log($skippedRows);
        }

        foreach ($plan['skipped'] as $item) {
            $results[] = [
                'id' => $item['id'],
                'ok' => false,
                'code' => 'skipped',
                'message' => match ($item['action']) {
                    'delete' => __('Permanently deleted products cannot be restored.', 'wp-woocommerce-products-list'),
                    'masked' => __('Passwords are not stored in the log and cannot be reverted.', 'wp-woocommerce-products-list'),
                    'failed' => __('This change failed when it was made; there is nothing to revert.', 'wp-woocommerce-products-list'),
                    default => sprintf(
                        /* translators: %s: action name */
                        __('"%s" rows are not reverted.', 'wp-woocommerce-products-list'),
                        $item['action']
                    ),
                },
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
