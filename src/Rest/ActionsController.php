<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\Actions\Action;
use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\BatchState;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Plugin;
use Throwable;
use WC_Product;
use WC_Product_Variation;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * POST /wc-products-list/v1/actions/{action} {ids, args}: runs one Action
 * per id, logs one row per id (or per change the handler reports, with
 * any `context` it returns stored next to the args), and returns per-id
 * results (`changed`: how many fields the handler reported) plus the
 * refreshed rows of the ids that still exist, so the app can patch its
 * cache without a reload. Each id's rows are written as soon as it is
 * done, and each variable parent is synced as soon as its last variation
 * in the request is (listed on the batch marker until then), so a request
 * killed part-way loses neither (docs/contracts.md §3.6). A status change
 * (trash, restore, publish, draft) or a delete is logged from its own
 * hook (`EarlyRow`): the row is in the table before WordPress and
 * WooCommerce run the rest of their hooks for it.
 */
final class ActionsController
{
    public const FILTER_HANDLERS = 'wc_products_list/action_handlers';

    public const ID_PATTERN = '[a-z0-9][a-z0-9_:.\-]{0,99}';

    public function register(): void
    {
        register_rest_route(Plugin::REST_NAMESPACE, '/actions/(?P<action>'.self::ID_PATTERN.')', [
            'methods' => 'POST',
            'callback' => [$this, 'handle'],
            'permission_callback' => static fn (): bool => current_user_can(Plugin::capability()),
            'args' => [
                'action' => ['type' => 'string', 'required' => true],
                'ids' => ['type' => 'array', 'required' => true, 'items' => ['type' => 'integer']],
                'args' => ['type' => 'object', 'default' => []],
                // `fields`, not `_fields`: core trims the whole response to
                // `_fields` after the callback, and this response has no
                // `id`/`status` at the top level, so the app would get `[]`.
                'fields' => ['type' => 'string', 'description' => 'Comma-separated wc/v3 fields of the refreshed `items` rows.'],
            ],
        ]);
    }

    /**
     * The registered handlers by id.
     *
     * @return array<string, Action>
     */
    public static function handlers(): array
    {
        /**
         * Filters the Action instances behind POST /actions/{id}.
         *
         * @param  array<string, mixed>  $handlers
         */
        $handlers = apply_filters(self::FILTER_HANDLERS, []);
        $byId = [];

        foreach ($handlers as $handler) {
            if ($handler instanceof Action) {
                $byId[$handler->id()] = $handler;
            }
        }

        return $byId;
    }

    /**
     * Validate the ids of a request: integers, unique, at least one, at most
     * `$max`. Pure; the unit suite covers it.
     *
     * @return array{ok: true, ids: array<int, int>}|array{ok: false, code: string, message: string}
     */
    public static function parseIds(mixed $ids, int $max): array
    {
        if (! is_array($ids)) {
            return ['ok' => false, 'code' => 'wc_products_list_invalid_ids', 'message' => 'ids must be an array of integers.'];
        }

        $clean = [];

        foreach ($ids as $id) {
            if (is_int($id) || (is_string($id) && ctype_digit($id)) || (is_float($id) && floor($id) === $id)) {
                $id = (int) $id;
            } else {
                return ['ok' => false, 'code' => 'wc_products_list_invalid_ids', 'message' => 'ids must be an array of integers.'];
            }

            if ($id > 0) {
                $clean[$id] = $id;
            }
        }

        if ($clean === []) {
            return ['ok' => false, 'code' => 'wc_products_list_no_ids', 'message' => 'No ids given.'];
        }

        if (count($clean) > $max) {
            return ['ok' => false, 'code' => 'wc_products_list_too_many_ids', 'message' => sprintf('At most %d ids per request.', $max)];
        }

        return ['ok' => true, 'ids' => array_values($clean)];
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $actionId = (string) $request['action'];
        $action = self::handlers()[$actionId] ?? null;

        if ($action === null) {
            return new WP_Error('wc_products_list_unknown_action', sprintf(
                /* translators: %s: action id */
                __('Unknown action "%s".', 'wp-woocommerce-products-list'),
                $actionId
            ), ['status' => 404]);
        }

        $max = Bootstrap::actionBatchSize($actionId);
        $parsed = self::parseIds($request['ids'], $max);

        if (! $parsed['ok']) {
            // `max`: the ids this action takes per request, to chunk by.
            return new WP_Error($parsed['code'], $parsed['message'], ['status' => 400, 'max' => $max]);
        }

        $args = $action->sanitizeArgs(is_array($request['args']) ? $request['args'] : []);

        if (is_wp_error($args)) {
            $args->add_data(['status' => 400]);

            return $args;
        }

        Logger::setSource('action');
        $batchId = Logger::batchId();
        $results = [];
        $survivors = [];
        $groups = self::variationParents($parsed['ids']);
        $touched = [];
        // The batch's marker was set by `BatchState::begin()` only when
        // the request named this batch id; otherwise the parents below
        // live on a marker of their own, dropped once they are synced.
        $ownMarker = ListMode::batchId() !== $batchId;

        foreach ($parsed['ids'] as $index => $id) {
            $parent = $groups['parents'][$id] ?? 0;

            if ($parent > 0 && ! isset($touched[$parent])) {
                // Listed before the first of its variations is written: a
                // request killed before the sync below leaves it for
                // `BatchState::repair()` / `close()` (§3.6).
                $touched[$parent] = false;
                BatchState::addParents($batchId, [$parent]);
            }

            [$result, $logRows, $product] = $this->runOne($action, $id, $args, $request, $batchId);
            $results[] = $result;

            if ($parent > 0 && ($result['changed'] ?? 0) > 0) {
                $touched[$parent] = true;
            }

            // Per id, as `Saves::inserted()` does per item: a request killed
            // or timed out part-way leaves no done trash, delete or status
            // change without its row (History, Undo).
            Logger::log($logRows);
            Logger::flush();

            if ($product !== null && get_post($id) !== null) {
                $survivors[] = $id;
            }

            if ($parent > 0 && $groups['last'][$parent] === $index) {
                // The parent's last variation in this request is done:
                // sync it now, not at the end, so a request killed later
                // leaves no finished parent with a stale price range.
                if ($touched[$parent]) {
                    self::syncParents([$parent]);
                }

                BatchState::dropParents($batchId, [$parent], $ownMarker);
            }
        }

        $fields = $request->get_param('fields');

        return rest_ensure_response([
            'batch_id' => $batchId,
            'results' => $results,
            'items' => $this->refresh($survivors, is_string($fields) ? $fields : null),
        ]);
    }

    /**
     * The parent of each variation among `$ids` (products are left out)
     * and the index of each parent's last variation in `$ids`. One query
     * for the posts (primed).
     *
     * @param  array<int, int>  $ids
     * @return array{parents: array<int, int>, last: array<int, int>}
     */
    public static function variationParents(array $ids): array
    {
        _prime_post_caches($ids, false, false);

        $parents = [];
        $last = [];

        foreach ($ids as $index => $id) {
            $post = get_post($id);

            if ($post === null || $post->post_type !== 'product_variation' || (int) $post->post_parent <= 0) {
                continue;
            }

            $parents[$id] = (int) $post->post_parent;
            $last[(int) $post->post_parent] = $index;
        }

        return ['parents' => $parents, 'last' => $last];
    }

    /**
     * Once per parent whose variations an action changed: the parent's
     * cached children and price range (transients) are dropped and its
     * price, stock status and lookup row are synced from the variations
     * that are left. WooCommerce's data store does neither when a
     * variation is trashed or restored (its REST delete clears the
     * transients itself), so the shop would keep showing the old range.
     *
     * @param  array<int, int>  $parentIds
     */
    public static function syncParents(array $parentIds): void
    {
        foreach ($parentIds as $parentId) {
            wc_delete_product_transients($parentId);

            $parent = wc_get_product($parentId);

            if ($parent instanceof \WC_Product_Variable) {
                \WC_Product_Variable::sync($parent);
            }

            wc_delete_product_transients($parentId);
        }
    }

    /**
     * @param  array<string, mixed>  $args
     * @return array{0: array<string, mixed>, 1: array<int, array<string, mixed>>, 2: ?WC_Product}
     */
    private function runOne(Action $action, int $id, array $args, WP_REST_Request $request, string $batchId): array
    {
        // The object lock every list-mode save takes (Concurrency, §3.6):
        // a delete, trash, restore or status change waits for a save of
        // the same row in another tab or by another user, and that save
        // waits for it, then sees the row gone or changed.
        if (! Concurrency::lockObject($id)) {
            return $this->locked($action, $id, $args, $batchId);
        }

        try {
            $editing = in_array($action->id(), self::IGNORE_EDIT_LOCK, true) ? 0 : Concurrency::editingUser($id, (int) wp_get_post_parent_id($id));

            if ($editing > 0) {
                return $this->skipped($action, $id, $args, $batchId, Concurrency::editingError($id, $editing), 'editing');
            }

            return $this->runLocked($action, $id, $args, $request, $batchId);
        } finally {
            Concurrency::unlockObject($id);
        }
    }

    /**
     * The result and the `skipped` log row (reason `locked`) of an id
     * whose lock was not had within `Concurrency::lockTimeout()`.
     *
     * @param  array<string, mixed>  $args
     * @return array{0: array<string, mixed>, 1: array<int, array<string, mixed>>, 2: null}
     */
    private function locked(Action $action, int $id, array $args, string $batchId): array
    {
        return $this->skipped($action, $id, $args, $batchId, Concurrency::lockedError($id), 'locked');
    }

    /**
     * Actions that run while the product is open in the product editor:
     * a copy leaves the original alone. Every other action is refused
     * there, as core's own Trash is (`wp_check_post_lock()` in edit.php):
     * the editor's Update would put its values back over the change.
     * Restore is refused too: an editor opened before the product went to
     * the Trash keeps its lock fresh (heartbeat), and its Update posts the
     * form's status and fields, so the Undo of a Trash would behave
     * differently from the same row's quick edit and from History's undo.
     */
    public const IGNORE_EDIT_LOCK = ['duplicate'];

    /**
     * The result and the `skipped` log row of an id refused by a
     * concurrency check (`locked`, `editing`).
     *
     * @param  array<string, mixed>  $args
     * @return array{0: array<string, mixed>, 1: array<int, array<string, mixed>>, 2: null}
     */
    private function skipped(Action $action, int $id, array $args, string $batchId, WP_Error $error, string $reason): array
    {
        $post = get_post($id);
        $isVariation = $post !== null && $post->post_type === 'product_variation';

        return [
            ['id' => $id, 'ok' => false, 'code' => $error->get_error_code(), 'message' => $error->get_error_message()],
            [[
                'batch_id' => $batchId,
                'source' => 'action',
                'action' => $action->id(),
                'object_type' => $isVariation ? 'variation' : 'product',
                'object_id' => $id,
                'parent_id' => $isVariation ? (int) $post->post_parent : 0,
                'field' => '',
                'old_value' => null,
                'new_value' => null,
                'status' => Logger::STATUS_SKIPPED,
                'message' => $error->get_error_message(),
                'context' => ['reason' => $reason, 'args' => $args, 'code' => $error->get_error_code()],
            ]],
            null,
        ];
    }

    /**
     * @param  array<string, mixed>  $args
     * @return array{0: array<string, mixed>, 1: array<int, array<string, mixed>>, 2: ?WC_Product}
     */
    private function runLocked(Action $action, int $id, array $args, WP_REST_Request $request, string $batchId): array
    {
        $product = wc_get_product($id);
        $base = [
            'batch_id' => $batchId,
            'source' => 'action',
            'action' => $action->id(),
            'object_type' => $product instanceof WC_Product_Variation ? 'variation' : 'product',
            'object_id' => $id,
            'parent_id' => $product instanceof WC_Product ? (int) $product->get_parent_id() : 0,
            'context' => ['args' => $args],
        ];

        $fail = static function (string $code, string $message) use ($id, $base): array {
            return [
                ['id' => $id, 'ok' => false, 'code' => $code, 'message' => $message],
                // array_merge, not +: the row's context carries the code on top of the base context.
                [array_merge($base, ['field' => '', 'old_value' => null, 'new_value' => null, 'status' => 'error', 'message' => $message, 'context' => $base['context'] + ['code' => $code]])],
                null,
            ];
        };

        if (! $product instanceof WC_Product || $product->get_id() === 0) {
            return $fail('not_found', __('The product no longer exists.', 'wp-woocommerce-products-list'));
        }

        $isVariation = $product instanceof WC_Product_Variation;
        $applies = $action->appliesTo();

        if (($applies === 'product' && $isVariation) || ($applies === 'variation' && ! $isVariation)) {
            return $fail('not_applicable', $isVariation
                ? __('This action does not apply to variations.', 'wp-woocommerce-products-list')
                : __('This action only applies to variations.', 'wp-woocommerce-products-list'));
        }

        if (! $action->can($product)) {
            return $fail('forbidden', __('You are not allowed to do this to this product.', 'wp-woocommerce-products-list'));
        }

        // The row of a status change or delete is written by the change's
        // own hook, before the rest of the save runs (§3.6).
        $early = new EarlyRow($id, $product->get_status(), $base);
        $early->watch();

        try {
            $data = $action->run($product, $args, $request);
        } catch (Throwable $e) {
            return $fail('exception', $e->getMessage());
        } finally {
            $early->unwatch();
        }

        if (is_wp_error($data)) {
            $errorData = $data->get_error_data();

            // Nothing to do (a restore of a product that is not in the Trash):
            // answered as refused, so the app can say so, but logged as a
            // `skipped` no-op, not as a failure History would count.
            if (is_array($errorData) && ($errorData['skip_reason'] ?? null) === 'unchanged' && ! $early->written()) {
                $code = (string) $data->get_error_code();

                return [
                    ['id' => $id, 'ok' => false, 'code' => $code, 'message' => $data->get_error_message()],
                    [array_merge($base, ['field' => '', 'old_value' => null, 'new_value' => null, 'status' => Logger::STATUS_SKIPPED, 'message' => LogController::skipMessage('unchanged'), 'context' => ['reason' => 'unchanged'] + $base['context'] + ['code' => $code]])],
                    null,
                ];
            }

            // A change the handler made before failing keeps its early row.
            return $fail((string) $data->get_error_code(), $data->get_error_message());
        }

        $changes = is_array($data['changes'] ?? null) ? $data['changes'] : [];
        $context = is_array($data['context'] ?? null) ? $data['context'] : [];
        unset($data['changes'], $data['context']);

        if ($context !== []) {
            // What the handler wants remembered next to the args (the id
            // and title of a copy, for instance); the args win on a clash.
            $base['context'] = $base['context'] + $context;
        }

        $rows = [];

        foreach ($changes as $field => $change) {
            $rows[] = $base + [
                'field' => (string) $field,
                'old_value' => Recorder::serialize(is_array($change) ? ($change[0] ?? null) : null),
                'new_value' => Recorder::serialize(is_array($change) ? ($change[1] ?? null) : null),
                'status' => 'ok',
                'message' => '',
            ];
        }

        // The early row becomes the handler's own row of the field (a
        // restore whose status a site filter changed is corrected twice;
        // the row says where it ended). Without one, the early row stays:
        // the change happened.
        $rows = $early->finalise($rows);

        if ($rows === [] && ! $early->written()) {
            // Nothing to change (it already had the value): a `skipped` row,
            // so History counts it apart from the changes and a revert of
            // the batch leaves it out without calling it a failure.
            $base['context'] = ['reason' => 'unchanged'] + $base['context'];
            $rows[] = $base + ['field' => '', 'old_value' => null, 'new_value' => null, 'status' => Logger::STATUS_SKIPPED, 'message' => LogController::skipMessage('unchanged')];
        }

        // How many fields the handler changed on this id: the app's notice
        // says "2 items updated, 1 unchanged" and offers Undo only when
        // something was written (a no-op logs a row without a field).
        $result = ['id' => $id, 'ok' => true, 'changed' => max(count($changes), $early->written() ? 1 : 0)];

        if ($data !== []) {
            $result['data'] = $data;
        }

        return [$result, $rows, $product];
    }

    /**
     * The current wc/v3 rows (list-mode shape) of the ids that still exist.
     *
     * Products: one list request per status group (a trashed product is
     * only found with `status=trash`), at most one per status. Variations
     * live under their parent, and wc/v3 has no cross-parent list, so a
     * request per (parent, status) could mean a hundred nested requests
     * for "select all variations" across a page; instead each variation
     * is serialised directly by the wc/v3 variations controller, with one
     * request object per parent that is never dispatched. Same rows, same
     * hooks (`woocommerce_rest_prepare_product_variation_object`, so the
     * list-mode enrichment and the integrations' keys apply), no query
     * per group. Cost is bounded by the number of ids.
     *
     * @param  array<int, int>  $ids
     * @return array<int, mixed>
     */
    private function refresh(array $ids, ?string $fields): array
    {
        if ($ids === []) {
            return [];
        }

        _prime_post_caches($ids, false, false);

        $byStatus = [];
        $variations = [];

        foreach ($ids as $id) {
            $post = get_post($id);

            if ($post === null) {
                continue;
            }

            if ($post->post_type === 'product_variation') {
                $variations[(int) $post->post_parent][] = $id;
            } else {
                $byStatus[$post->post_status][] = $id;
            }
        }

        $items = [];

        foreach ($byStatus as $status => $groupIds) {
            $request = new WP_REST_Request('GET', '/wc/v3/products');
            $request->set_header(ListMode::HEADER, '1');
            $request->set_query_params(array_filter([
                'include' => $groupIds,
                'status' => $status,
                'per_page' => Bootstrap::PER_PAGE_MAX,
                'image_size' => 'thumbnail',
                '_fields' => $fields,
            ]));

            $response = rest_do_request($request);

            if ($response->is_error()) {
                continue;
            }

            // get_data(), not response_to_data(): the rows without _links.
            // wc/v3 skips the fields it is not asked for, but keys that
            // filters add (brands, i18n, wc_products_list) still need trimming.
            foreach ((array) $response->get_data() as $row) {
                if (is_array($row)) {
                    $items[] = Rows::trim($row, $fields);
                }
            }
        }

        foreach ($this->variationRows($variations, $fields) as $row) {
            $items[] = $row;
        }

        return $items;
    }

    /**
     * @param  array<int, array<int, int>>  $byParent  variation ids per parent id
     * @return array<int, array<string, mixed>>
     */
    private function variationRows(array $byParent, ?string $fields): array
    {
        if ($byParent === []) {
            return [];
        }

        $controller = new \WC_REST_Product_Variations_Controller;
        $rows = [];

        foreach ($byParent as $parent => $ids) {
            $request = new WP_REST_Request('GET', '/wc/v3/products/'.$parent.'/variations');
            $request->set_header(ListMode::HEADER, '1');
            $request->set_url_params(['product_id' => $parent]);
            $request->set_query_params(array_filter([
                'product_id' => $parent,
                'context' => 'view',
                'image_size' => 'thumbnail',
                '_fields' => $fields,
            ]));

            foreach ($ids as $id) {
                $variation = wc_get_product($id);

                if (! $variation instanceof WC_Product_Variation) {
                    continue;
                }

                $row = $controller->prepare_object_for_response($variation, $request)->get_data();

                if (is_array($row)) {
                    $rows[] = Rows::trim($row, $fields);
                }
            }
        }

        return $rows;
    }
}
