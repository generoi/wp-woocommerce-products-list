<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Actions\Action;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Registry;
use GeneroWP\ProductsList\Rest\Saves;
use WC_Product;
use WP_REST_Request;

/**
 * POST /wc-products-list/v1/log/batch/{id}/revert.
 */
class RevertTest extends RestTestCase
{
    public function set_up(): void
    {
        parent::set_up();

        Saves::resetWriteKeys();

        add_filter('wc_products_list/fields', static function (array $fields): array {
            $fields[] = ['id' => 'i18n:se.name', 'writePath' => 'i18n.se.name', 'applies' => ['variation' => true]];

            return $fields;
        });

        add_action('wc_products_list/save', static function (WC_Product $product, WP_REST_Request $request): void {
            foreach ((array) ($request['i18n'] ?? []) as $lang => $fields) {
                foreach ((array) $fields as $field => $value) {
                    if ($value === '') {
                        $product->delete_meta_data('_i18n_'.$field.'_'.$lang);
                    } else {
                        $product->update_meta_data('_i18n_'.$field.'_'.$lang, (string) $value);
                    }
                }
            }
        }, 10, 2);

        Registry::reset();
    }

    public function tear_down(): void
    {
        Registry::reset();
        Saves::resetWriteKeys();

        parent::tear_down();
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function rows(string $batch): array
    {
        global $wpdb;

        $table = Table::name();

        return $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batch), ARRAY_A); // phpcs:ignore
    }

    public function test_reverting_a_bulk_sale_restores_products_and_variations(): void
    {
        $simple = $this->simpleProduct(['sku' => 'S1']);
        $parent = $this->variableProduct(['38', '39']);
        [$v38, $v39] = $parent->get_children();

        // The bulk save the app makes: variations first, then parents, one batch id.
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', [
            'update' => [
                ['id' => $v38, 'sale_price' => '149', 'date_on_sale_from' => '2026-11-01', 'date_on_sale_to' => '2026-11-30', 'i18n' => ['se' => ['name' => 'Storlek 38']]],
                ['id' => $v39, 'sale_price' => '149', 'date_on_sale_from' => '2026-11-01', 'date_on_sale_to' => '2026-11-30'],
            ],
        ], [Logger::SOURCE_HEADER => 'bulk']));
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $simple->get_id(), 'sale_price' => '149', 'date_on_sale_from' => '2026-11-01', 'date_on_sale_to' => '2026-11-30']],
        ], [Logger::SOURCE_HEADER => 'bulk']));

        $this->assertSame('149', wc_get_product($v38)->get_sale_price());
        $this->assertSame('Storlek 38', get_post_meta($v38, '_i18n_name_se', true));
        $this->assertCount(10, $this->rows($this->batchId()));

        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['fields' => 'id,sale_price']);
        $this->assertStatus(200, $response);
        $data = $this->data($response);

        $this->assertNotSame($this->batchId(), $data['batch_id']);
        $this->assertEqualsCanonicalizing([$simple->get_id(), $v38, $v39], array_column($data['results'], 'id'));
        $this->assertSame([true, true, true], array_column($data['results'], 'ok'));
        $this->assertCount(3, $data['items']);
        $this->assertEqualsCanonicalizing(['id', 'sale_price'], array_keys($data['items'][0]));

        foreach ([$simple->get_id(), $v38, $v39] as $id) {
            $product = wc_get_product($id);
            $this->assertSame('', $product->get_sale_price(), "sale price of #{$id}");
            $this->assertNull($product->get_date_on_sale_from(), "sale from of #{$id}");
            $this->assertNull($product->get_date_on_sale_to(), "sale to of #{$id}");
            $this->assertSame('189', $product->get_regular_price());
        }

        $this->assertSame('', get_post_meta($v38, '_i18n_name_se', true));

        $revertRows = $this->rows($data['batch_id']);
        $this->assertCount(10, $revertRows);

        foreach ($revertRows as $row) {
            $this->assertSame('revert', $row['source']);
            $this->assertSame('update', $row['action']);
            $this->assertSame('ok', $row['status']);
        }

        $byObject = [];
        $parents = [];

        foreach ($revertRows as $row) {
            $byObject[$row['object_id']][$row['field']] = [$row['old_value'], $row['new_value']];
            $parents[$row['object_id']] = (int) $row['parent_id'];
        }

        $this->assertSame(['149', ''], $byObject[$v38]['sale_price']);
        $this->assertSame(['2026-11-01T00:00:00', null], $byObject[$v38]['date_on_sale_from']);
        $this->assertSame(['Storlek 38', ''], $byObject[$v38]['i18n.se.name']);
        $this->assertSame($parent->get_id(), $parents[$v38]);
        $this->assertSame(0, $parents[$simple->get_id()]);

        // The revert is itself a batch, so it can be undone.
        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$data['batch_id'].'/revert');
        $this->assertStatus(200, $response);
        $this->assertSame('149', wc_get_product($simple->get_id())->get_sale_price());
        $this->assertSame('Storlek 38', get_post_meta($v38, '_i18n_name_se', true));

        $batches = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertSame(3, $batches['total']);
        $this->assertSame('revert', $batches['items'][0]['source']);
        $this->assertTrue($batches['items'][0]['revertable']);

        // Each revert names the batch it put back, and that batch says who reverted it (the latest revert).
        $byId = array_column($batches['items'], null, 'batch_id');
        $this->assertSame($data['batch_id'], $byId[$batches['items'][0]['batch_id']]['reverts']);
        $this->assertSame($batches['items'][0]['batch_id'], $byId[$data['batch_id']]['reverted_by']['batch_id']);
        $this->assertSame(get_current_user_id(), $byId[$data['batch_id']]['reverted_by']['user']['id']);
        $original = $byId[$this->batchId()];
        $this->assertSame($data['batch_id'], $original['reverted_by']['batch_id']);
        $this->assertNull($original['reverts']);
        // What it was: 2 variations of 1 product and 1 product.
        $this->assertSame([1, 2, 1, 0], [$original['products'], $original['variations'], $original['parents'], $original['errors']]);
        $this->assertSame(['update'], $original['actions']);

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $this->assertSame($data['batch_id'], $plan['reverted_by']['batch_id']);

        // Log rows carry both as well.
        $rows = $this->data($this->request('GET', '/wc-products-list/v1/log', ['batch' => $this->batchId()]))['items'];
        $this->assertSame($data['batch_id'], $rows[0]['reverted_by']['batch_id']);
        $rows = $this->data($this->request('GET', '/wc-products-list/v1/log', ['batch' => $data['batch_id']]))['items'];
        $this->assertSame($this->batchId(), $rows[0]['reverts']);
        // That revert was itself reverted above.
        $this->assertSame($batches['items'][0]['batch_id'], $rows[0]['reverted_by']['batch_id']);
    }

    public function test_a_revert_builds_its_sub_items_with_only_the_requested_fields(): void
    {
        $parents = [$this->variableProduct(['38', '39', '40']), $this->variableProduct(['41', '42'])];
        $update = array_map(static fn (WC_Product $p): array => ['id' => $p->get_id(), 'menu_order' => 7], $parents);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => $update], [Logger::SOURCE_HEADER => 'bulk']));

        // What each wc/v3 sub-item looked like once every filter had run,
        // and which `_fields` the controller was asked to build.
        $built = [];
        $capture = static function ($response, $product, $request) use (&$built) {
            $built[] = [
                'keys' => array_keys((array) $response->get_data()),
                '_fields' => $request instanceof WP_REST_Request ? $request->get_param('_fields') : null,
            ];

            return $response;
        };
        add_filter('woocommerce_rest_prepare_product_object', $capture, PHP_INT_MAX, 3);

        global $wpdb;
        $before = $wpdb->num_queries;
        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['fields' => 'id,menu_order']);
        $queries = $wpdb->num_queries - $before;

        remove_filter('woocommerce_rest_prepare_product_object', $capture, PHP_INT_MAX);

        $this->assertStatus(200, $response);
        $data = $this->data($response);
        $this->assertSame([true, true], array_column($data['results'], 'ok'));

        foreach ($parents as $parent) {
            $this->assertSame(0, wc_get_product($parent->get_id())->get_menu_order());
        }

        $this->assertCount(2, $built);

        foreach ($built as $item) {
            // `fields` reaches the sub-items: the controller builds only
            // those keys (no price range over every variation) and the trim
            // leaves nothing else.
            $this->assertSame('id,menu_order,id', $item['_fields']);
            $this->assertEqualsCanonicalizing(['id', 'menu_order'], $item['keys']);
        }

        foreach ($data['items'] as $item) {
            $this->assertEqualsCanonicalizing(['id', 'menu_order'], array_keys($item));
        }

        // Loose budget against regressions back to full serialisation.
        $this->assertLessThan(400, $queries, 'queries for reverting 2 variable products');
    }

    public function test_only_update_rows_revert_and_array_fields_round_trip(): void
    {
        $product = $this->simpleProduct();
        $trashed = $this->simpleProduct();
        $term = wp_insert_term('Boots', 'product_cat');
        $this->assertIsArray($term);
        // Read back: WooCommerce files a product without categories under the default one on save.
        $original = wc_get_product($product->get_id())->get_category_ids();

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), [
            'categories' => [['id' => $term['term_id']]],
            'manage_stock' => true,
            'stock_quantity' => 3,
            'meta_data' => [['key' => '_custom', 'value' => 'x']],
        ]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$trashed->get_id()]]));

        $this->assertSame([$term['term_id']], wc_get_product($product->get_id())->get_category_ids());

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $results = array_column($data['results'], null, 'id');

        $this->assertTrue($results[$product->get_id()]['ok']);
        $this->assertFalse($results[$trashed->get_id()]['ok']);
        $this->assertSame('skipped', $results[$trashed->get_id()]['code']);
        $this->assertSame('trash', get_post_status($trashed->get_id()));

        $reverted = wc_get_product($product->get_id());
        $this->assertSame($original, $reverted->get_category_ids());
        $this->assertFalse($reverted->get_manage_stock());
        $this->assertNull($reverted->get_stock_quantity());
        $this->assertSame('', $reverted->get_meta('_custom'));
    }

    /**
     * An extension action that reports `changes` (a translation copy) is
     * undone from History like a bulk edit: its rows carry field, old and
     * new value, so the batch is revertable and the revert writes the old
     * values back through wc/v3 (a null old value deletes the key).
     */
    public function test_extension_action_rows_revert_like_updates(): void
    {
        add_filter('wc_products_list/action_handlers', static function (array $handlers): array {
            $handlers[] = new class implements Action
            {
                public function id(): string
                {
                    return 'tint';
                }

                public function run(WC_Product $product, array $args, WP_REST_Request $request): array
                {
                    $old = get_post_meta($product->get_id(), '_tint', true);

                    if ($old === $args['colour']) {
                        return [];
                    }

                    update_post_meta($product->get_id(), '_tint', $args['colour']);
                    update_post_meta($product->get_id(), '_i18n_name_se', 'Ullsockor');

                    return ['changes' => [
                        'meta_data._tint' => [$old === '' ? null : $old, $args['colour']],
                        'i18n.se.name' => ['', 'Ullsockor'],
                    ]];
                }

                public function can(WC_Product $product): bool
                {
                    return true;
                }

                public function appliesTo(): string
                {
                    return 'both';
                }

                public function sanitizeArgs(array $args): array
                {
                    return ['colour' => (string) ($args['colour'] ?? 'red')];
                }
            };

            return $handlers;
        });

        $product = $this->simpleProduct();
        $same = $this->simpleProduct();
        update_post_meta($same->get_id(), '_tint', 'red');
        $trashed = $this->simpleProduct();

        $response = $this->request('POST', '/wc-products-list/v1/actions/tint', ['ids' => [$product->get_id(), $same->get_id()], 'args' => ['colour' => 'red']]);
        $this->assertStatus(200, $response);
        $results = array_column($this->data($response)['results'], null, 'id');
        // How many fields each id changed: the app's notice counts on it and offers Undo only when something was written.
        $this->assertSame(2, $results[$product->get_id()]['changed']);
        $this->assertSame(0, $results[$same->get_id()]['changed']);
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$trashed->get_id()]]));

        $this->assertSame('red', get_post_meta($product->get_id(), '_tint', true));
        $this->assertSame('Ullsockor', get_post_meta($product->get_id(), '_i18n_name_se', true));

        $batches = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertTrue($batches['items'][0]['revertable']);
        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $this->assertTrue($plan['revertable']);
        $this->assertSame([$product->get_id()], array_merge(...$plan['chunks']));
        // The id that already had the value is left out as `unchanged`, not reported as a skipped action.
        $this->assertSame(['trash'], array_column($plan['skipped'], 'action'));
        $this->assertSame(1, $plan['left_out']);
        $this->assertSame(['unchanged' => 1], $plan['left_out_reasons']);

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $results = array_column($data['results'], null, 'id');
        $this->assertTrue($results[$product->get_id()]['ok']);
        $this->assertArrayNotHasKey($same->get_id(), $results);
        $this->assertSame('skipped', $results[$trashed->get_id()]['code']);

        $this->assertFalse(metadata_exists('post', $product->get_id(), '_tint'));
        $this->assertFalse(metadata_exists('post', $product->get_id(), '_i18n_name_se'));
        $this->assertSame('red', get_post_meta($same->get_id(), '_tint', true));
        $this->assertSame('trash', get_post_status($trashed->get_id()));

        $revert = $this->rows($data['batch_id']);
        $this->assertSame(['revert'], array_unique(array_column($revert, 'source')));
        $this->assertEqualsCanonicalizing(['i18n.se.name', 'meta_data._tint'], array_column($revert, 'field'));
    }

    public function test_reverting_a_change_that_created_a_meta_key_removes_the_key(): void
    {
        $product = $this->simpleProduct();
        update_post_meta($product->get_id(), '_had_value', 'before');

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), [
            'meta_data' => [['key' => '_note', 'value' => 'audit note'], ['key' => '_had_value', 'value' => 'after']],
        ]));

        $fields = array_column($this->rows($this->batchId()), 'old_value', 'field');
        $this->assertNull($fields['meta_data._note']);
        $this->assertSame('before', $fields['meta_data._had_value']);

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertTrue($data['results'][0]['ok']);

        $this->assertFalse(metadata_exists('post', $product->get_id(), '_note'));
        $this->assertSame('before', get_post_meta($product->get_id(), '_had_value', true));

        // The revert's own row records the removal.
        $reverted = array_column($this->rows($data['batch_id']), 'new_value', 'field');
        $this->assertNull($reverted['meta_data._note']);
    }

    public function test_passwords_are_masked_in_the_log_and_not_reverted(): void
    {
        $product = $this->simpleProduct();

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['post_password' => 'open sesame', 'regular_price' => '150']));
        $this->assertSame('open sesame', get_post($product->get_id())->post_password);

        $rows = array_column($this->rows($this->batchId()), null, 'field');
        $this->assertSame('', $rows['post_password']['old_value']);
        $this->assertStringStartsWith('***', $rows['post_password']['new_value']);
        $this->assertStringNotContainsString('sesame', wp_json_encode($rows));

        $list = $this->data($this->request('GET', '/wc-products-list/v1/log', ['batch' => $this->batchId()]));
        $this->assertStringNotContainsString('sesame', wp_json_encode($list));

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertTrue($data['results'][0]['ok']);
        $this->assertSame('189', wc_get_product($product->get_id())->get_regular_price());
        // The price came back, the password stayed as it is.
        $this->assertSame('open sesame', get_post($product->get_id())->post_password);
        $this->assertArrayNotHasKey('post_password', array_column($this->rows($data['batch_id']), null, 'field'));

        // A batch with only a password change is reported as skipped.
        $batch = wp_generate_uuid4();
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['post_password' => 'other'], [ListMode::BATCH_HEADER => $batch]));
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$batch.'/revert'));
        $this->assertSame('skipped', $data['results'][0]['code']);
        $this->assertStringContainsString('Passwords', $data['results'][0]['message']);
        $this->assertSame('other', get_post($product->get_id())->post_password);
    }

    public function test_errors_are_reported_per_object_and_unknown_batches_are_404(): void
    {
        $this->assertStatus(404, $this->request('POST', '/wc-products-list/v1/log/batch/nope/revert'));

        $taken = $this->simpleProduct(['sku' => 'FIRST']);
        $product = $this->simpleProduct(['sku' => 'OLD']);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['sku' => 'NEW']));
        // Someone else takes the old SKU in the meantime.
        $taken->set_sku('OLD');
        $taken->save();

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));

        $this->assertFalse($data['results'][0]['ok']);
        $this->assertSame('product_invalid_sku', $data['results'][0]['code']);
        $this->assertSame('NEW', wc_get_product($product->get_id())->get_sku());

        $rows = $this->rows($data['batch_id']);
        $this->assertCount(1, $rows);
        $this->assertSame(['error', 'revert', 'sku'], [$rows[0]['status'], $rows[0]['source'], $rows[0]['field']]);
    }

    public function test_fields_changed_again_after_the_batch_are_not_put_back_unless_forced(): void
    {
        $a = $this->simpleProduct(['sku' => 'A']);
        $b = $this->simpleProduct(['sku' => 'B']);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', [
            'update' => [
                ['id' => $a->get_id(), 'regular_price' => '150', 'sale_price' => '100'],
                ['id' => $b->get_id(), 'regular_price' => '150'],
            ],
        ], [Logger::SOURCE_HEADER => 'bulk']));

        // A colleague changes one of the fields again, in another batch.
        $later = wp_generate_uuid4();
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$a->get_id(), ['regular_price' => '160'], [ListMode::BATCH_HEADER => $later]));

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $results = array_column($data['results'], null, 'id');

        $this->assertFalse($results[$a->get_id()]['ok']);
        $this->assertSame('conflict', $results[$a->get_id()]['code']);
        $this->assertSame(['regular_price'], $results[$a->get_id()]['fields']);
        // Labelled for a person, with the values to show.
        $this->assertStringContainsString('Regular price', $results[$a->get_id()]['message']);
        $this->assertStringNotContainsString('regular_price', $results[$a->get_id()]['message']);
        $this->assertSame(['Regular price'], $results[$a->get_id()]['labels']);
        $this->assertSame(['regular_price' => '160'], $results[$a->get_id()]['current']);
        $this->assertSame(['regular_price' => '150'], $results[$a->get_id()]['batch']);
        $this->assertSame(['regular_price' => '189'], $results[$a->get_id()]['expected']);
        $this->assertSame('Saga wide toe boot', $results[$a->get_id()]['name']);
        $this->assertFalse($results[$a->get_id()]['relative']);
        $this->assertTrue($results[$b->get_id()]['ok']);

        // Nothing of A was touched, not even the sale price that did not conflict.
        $this->assertSame('160', wc_get_product($a->get_id())->get_regular_price());
        $this->assertSame('100', wc_get_product($a->get_id())->get_sale_price());
        $this->assertSame('189', wc_get_product($b->get_id())->get_regular_price());
        $revertRows = $this->rows($data['batch_id']);
        $written = array_values(array_filter($revertRows, static fn (array $row): bool => $row['status'] === 'ok'));
        $this->assertSame([$b->get_id()], array_map('intval', array_column($written, 'object_id')));

        // The item left alone is in the log too, with why.
        $left = array_values(array_filter($revertRows, static fn (array $row): bool => $row['status'] === 'skipped'));
        $this->assertCount(1, $left);
        $this->assertSame([$a->get_id(), 'regular_price', '160', '189', 'revert', $this->batchId()], [(int) $left[0]['object_id'], $left[0]['field'], $left[0]['old_value'], $left[0]['new_value'], $left[0]['source'], $left[0]['reverts']]);
        $this->assertSame('conflict', json_decode($left[0]['context'], true)['reason']);

        // History counts it as left out, not as a change.
        $batches = array_column($this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'], null, 'batch_id');
        $this->assertSame(1, $batches[$data['batch_id']]['skipped']);
        $this->assertSame(1, $batches[$data['batch_id']]['objects']);
        $this->assertSame(1, $batches[$data['batch_id']]['rows']);

        // A revert of the revert does not try to write the skipped row.
        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$data['batch_id']));
        $this->assertSame([[$b->get_id()]], $plan['chunks']);
        $this->assertSame([], $plan['skipped']);
        $this->assertSame(1, $plan['left_out']);

        // Forced: the batch's old values win over the later change.
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['force' => true]));
        $results = array_column($data['results'], null, 'id');
        $this->assertTrue($results[$a->get_id()]['ok']);
        $this->assertSame('189', wc_get_product($a->get_id())->get_regular_price());
        $this->assertSame('', wc_get_product($a->get_id())->get_sale_price());
    }

    public function test_a_relative_revert_takes_a_restock_off_and_keeps_a_sale_made_since(): void
    {
        $parent = $this->variableProduct(['37', '38']);
        [$v37, $v38] = $parent->get_children();

        foreach ([$v37, $v38] as $id) {
            $variation = wc_get_product($id);
            $variation->set_manage_stock(true);
            $variation->set_stock_quantity(0);
            $variation->save();
        }

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', [
            'update' => [['id' => $v37, 'stock_quantity' => 10], ['id' => $v38, 'stock_quantity' => 10]],
        ], [Logger::SOURCE_HEADER => 'bulk']));

        // One pair of 37 sells in between.
        wc_update_product_stock(wc_get_product($v37), 1, 'decrease');

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $results = array_column($data['results'], null, 'id');
        $this->assertSame('conflict', $results[$v37]['code']);
        $this->assertTrue($results[$v37]['relative']);
        $this->assertSame(['Stock quantity'], $results[$v37]['labels']);
        $this->assertSame(['stock_quantity' => '9'], $results[$v37]['current']);
        $this->assertSame(9, wc_get_product($v37)->get_stock_quantity());
        $this->assertSame(0, wc_get_product($v38)->get_stock_quantity());

        // Relative: the +10 is taken off what is there now, the sale stays.
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['ids' => [$v37], 'relative' => true]));
        $this->assertSame([true], array_column($data['results'], 'ok'));
        $this->assertSame(-1, wc_get_product($v37)->get_stock_quantity());
    }

    public function test_a_second_relative_revert_does_not_take_the_change_off_twice(): void
    {
        $product = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 5]);
        $id = $product->get_id();
        $url = '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert';

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $id, 'inventory_delta' => 2]]]));
        $this->assertSame(7, wc_get_product($id)->get_stock_quantity());

        $data = $this->data($this->request('POST', $url));
        $this->assertSame([true], array_column($data['results'], 'ok'));
        $this->assertSame(5, wc_get_product($id)->get_stock_quantity());

        // Again: a conflict, and not one a relative revert is offered for.
        $data = $this->data($this->request('POST', $url));
        $this->assertSame('conflict', $data['results'][0]['code']);
        $this->assertFalse($data['results'][0]['relative']);
        $this->assertSame(['stock_quantity'], $data['results'][0]['already_reverted']);
        $this->assertStringContainsString('already put back', $data['results'][0]['message']);

        // Asked for anyway: nothing is taken off a second time.
        $data = $this->data($this->request('POST', $url, ['relative' => true]));
        $this->assertSame('conflict', $data['results'][0]['code']);
        $this->assertSame(5, wc_get_product($id)->get_stock_quantity());

        // The dry run says the same, without writing.
        $check = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId().'/check'));
        $this->assertSame(1, $check['changed']);
        $this->assertSame(1, $check['already_reverted']);
        $this->assertTrue($check['complete']);
    }

    public function test_the_revert_check_names_items_changed_since_without_writing(): void
    {
        $a = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 0]);
        $b = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 0]);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $a->get_id(), 'stock_quantity' => 10], ['id' => $b->get_id(), 'stock_quantity' => 10]],
        ], [Logger::SOURCE_HEADER => 'bulk']));

        // An order takes one of a.
        wc_update_product_stock(wc_get_product($a->get_id()), 1, 'decrease');

        global $wpdb;
        $before = (int) $wpdb->get_var('SELECT COUNT(*) FROM '.Table::name()); // phpcs:ignore

        $check = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId().'/check'));
        $this->assertSame(2, $check['checked']);
        $this->assertSame(2, $check['objects']);
        $this->assertTrue($check['complete']);
        $this->assertSame(1, $check['changed']);
        $this->assertSame(0, $check['already_reverted']);
        $item = $check['items'][0];
        $this->assertSame($a->get_id(), $item['id']);
        $this->assertSame(['Stock quantity'], $item['labels']);
        $this->assertSame(['stock_quantity' => '9'], $item['current']);
        $this->assertSame(['stock_quantity' => '10'], $item['batch']);
        $this->assertSame(['stock_quantity' => '0'], $item['expected']);
        $this->assertTrue($item['relative']);

        // Nothing written, nothing logged.
        $this->assertSame(9, wc_get_product($a->get_id())->get_stock_quantity());
        $this->assertSame(10, wc_get_product($b->get_id())->get_stock_quantity());
        $this->assertSame($before, (int) $wpdb->get_var('SELECT COUNT(*) FROM '.Table::name())); // phpcs:ignore

        // One chunk by ids.
        $check = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId().'/check', ['ids' => [$b->get_id()]]));
        $this->assertSame(1, $check['checked']);
        $this->assertFalse($check['complete']);
        $this->assertSame(0, $check['changed']);

        $this->assertStatus(404, $this->request('GET', '/wc-products-list/v1/log/batch/nope/check'));
        $this->assertStatus(400, $this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId().'/check', ['ids' => range(1, 101)]));
    }

    public function test_relative_values_need_numbers(): void
    {
        $this->assertSame('-1', Revert::relativeValue('0', '10', '9'));
        $this->assertSame('4.5', Revert::relativeValue('1.5', '3', '6'));
        $this->assertNull(Revert::relativeValue(null, '10', '9'));
        $this->assertNull(Revert::relativeValue('0', '10', 'x'));
    }

    public function test_items_skipped_on_the_client_are_logged_with_the_reason(): void
    {
        $trashed = $this->simpleProduct(['sku' => 'TR']);
        $kept = $this->simpleProduct(['sku' => 'KE']);
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $kept->get_id(), 'sale_price' => '150']],
        ], [Logger::SOURCE_HEADER => 'bulk']));

        $response = $this->request('POST', '/wc-products-list/v1/log/skipped', [
            'batch_id' => $this->batchId(),
            'source' => 'bulk',
            'items' => [
                ['id' => $trashed->get_id(), 'reason' => 'trashed', 'fields' => ['sale_price', 'date_on_sale_from']],
                ['id' => $variation, 'reason' => 'no_stock_management'],
            ],
        ]);
        $this->assertStatus(200, $response);
        $this->assertSame([$trashed->get_id(), $variation], $this->data($response)['logged']);

        $rows = array_values(array_filter($this->rows($this->batchId()), static fn (array $row): bool => $row['status'] === 'skipped'));
        $this->assertCount(3, $rows);
        $this->assertSame(['sale_price', 'date_on_sale_from', ''], array_column($rows, 'field'));
        $this->assertSame(['product', 'product', 'variation'], array_column($rows, 'object_type'));
        $this->assertSame($parent->get_id(), (int) $rows[2]['parent_id']);
        $this->assertStringContainsString('Trash', $rows[0]['message']);
        $this->assertSame('bulk', $rows[0]['source']);

        $batches = array_column($this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'], null, 'batch_id');
        $this->assertSame(2, $batches[$this->batchId()]['skipped']);
        $this->assertSame(1, $batches[$this->batchId()]['objects']);
        $this->assertSame(['sale_price'], $batches[$this->batchId()]['fields']);

        // The revert plan counts changes, not the rows that say what was left out.
        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $this->assertSame(1, $plan['rows']);
        $this->assertSame(2, $plan['left_out']);

        // The log's own row filters find them.
        $log = $this->data($this->request('GET', '/wc-products-list/v1/log', ['object_id' => $trashed->get_id()]));
        $this->assertSame(['skipped', 'skipped'], array_column($log['items'], 'status'));

        // The revert writes only the saved item.
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertSame([[$kept->get_id(), true]], array_map(static fn (array $result): array => [$result['id'], $result['ok']], $data['results']));
    }

    public function test_skipped_items_are_validated_and_stay_in_the_users_own_batch(): void
    {
        $product = $this->simpleProduct();

        $this->assertStatus(400, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => 'nope', 'items' => [['id' => $product->get_id(), 'reason' => 'trashed']]]));
        $this->assertStatus(400, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $this->batchId(), 'items' => [['id' => $product->get_id(), 'reason' => 'because']]]));
        $this->assertStatus(400, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $this->batchId(), 'items' => array_fill(0, 101, ['id' => $product->get_id(), 'reason' => 'trashed'])]));

        // A post that is not a product is ignored.
        $page = self::factory()->post->create(['post_type' => 'page']);
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $this->batchId(), 'items' => [['id' => $page, 'reason' => 'trashed']]]));
        $this->assertSame([], $data['logged']);

        // Another user's batch id is refused.
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['sale_price' => '120']));
        $this->actAs('shop_manager');
        $this->assertStatus(409, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $this->batchId(), 'items' => [['id' => $product->get_id(), 'reason' => 'trashed']]]));

        $this->actAs('subscriber');
        $this->assertStatus(403, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => wp_generate_uuid4(), 'items' => [['id' => $product->get_id(), 'reason' => 'trashed']]]));
    }

    public function test_a_large_batch_is_reverted_in_chunks_under_one_batch_id(): void
    {
        add_filter('wc_products_list/revert_chunk', static fn (): int => 2);

        $products = [$this->simpleProduct(['sku' => 'A']), $this->simpleProduct(['sku' => 'B']), $this->simpleProduct(['sku' => 'C'])];
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];
        $trashed = $this->simpleProduct(['sku' => 'T']);

        $update = [];

        foreach ($products as $product) {
            $update[] = ['id' => $product->get_id(), 'regular_price' => '150'];
        }

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => $update], [Logger::SOURCE_HEADER => 'bulk']));
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', ['update' => [['id' => $variation, 'regular_price' => '150']]], [Logger::SOURCE_HEADER => 'bulk']));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$trashed->get_id()]]));

        // The plan: four objects in write order (products, then variations), two per chunk.
        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $ids = array_map(static fn (WC_Product $product): int => $product->get_id(), $products);
        $this->assertSame(4, $plan['objects']);
        $this->assertSame(5, $plan['rows']);
        $this->assertSame(2, $plan['chunk']);
        $this->assertSame([[$ids[0], $ids[1]], [$ids[2], $variation]], $plan['chunks']);
        $this->assertSame([['id' => $trashed->get_id(), 'object_type' => 'product', 'action' => 'trash']], $plan['skipped']);
        $this->assertTrue($plan['revertable']);

        $this->assertStatus(404, $this->request('GET', '/wc-products-list/v1/log/batch/nope'));

        // Too large for one request: refused, with the chunks to post.
        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert');
        $this->assertStatus(400, $response);
        $error = $this->data($response);
        $this->assertSame('wc_products_list_revert_too_large', $error['code']);
        $this->assertSame($plan['chunks'], $error['data']['chunks']);
        $this->assertSame('150', wc_get_product($ids[0])->get_regular_price());

        // Over the chunk size in one request: refused too.
        $this->assertStatus(400, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['ids' => $ids]));

        $revertBatch = wp_generate_uuid4();

        foreach ($plan['chunks'] as $chunk) {
            $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['ids' => $chunk, 'revert_batch_id' => $revertBatch, 'fields' => 'id,regular_price']));
            $this->assertSame($revertBatch, $data['batch_id']);
            $this->assertSame([true, true], array_column($data['results'], 'ok'));
            $this->assertSame($chunk, array_column($data['results'], 'id'));
            $this->assertSame(['189', '189'], array_column($data['items'], 'regular_price'));
        }

        foreach (array_merge($ids, [$variation]) as $id) {
            $this->assertSame('189', wc_get_product($id)->get_regular_price());
        }

        $rows = $this->rows($revertBatch);
        $this->assertCount(4, $rows);
        $this->assertSame(['revert'], array_unique(array_column($rows, 'source')));
        $this->assertEqualsCanonicalizing(array_merge($ids, [$variation]), array_map('intval', array_column($rows, 'object_id')));

        // One revert batch in the history, itself revertable as a whole.
        $batches = $this->data($this->request('GET', '/wc-products-list/v1/log/batches', ['source' => 'revert']));
        $this->assertSame(1, $batches['total']);
        $this->assertSame(4, $batches['items'][0]['objects']);

        // Ids that are not in the batch: nothing to do.
        $this->assertStatus(404, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', ['ids' => [$trashed->get_id() + 1000]]));
    }

    /**
     * The log and its reverts need the log capability (by default
     * `edit_others_products`, which the revert's wc/v3 batch writes need
     * anyway): a user without it is refused and nothing is written.
     */
    public function test_revert_by_a_user_without_batch_rights_changes_nothing(): void
    {
        $product = $this->simpleProduct(['sku' => 'A']);
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'regular_price' => '150']]]));
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', ['update' => [['id' => $variation, 'regular_price' => '150']]]));
        $rows = count($this->rows($this->batchId()));

        add_role(CapabilitiesTest::ROLE, 'Catalog editor', ['read' => true, 'edit_products' => true, 'edit_published_products' => true, 'publish_products' => true, 'read_private_products' => true]);

        try {
            $this->actAs(CapabilitiesTest::ROLE);

            $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert');
            $this->assertSame(403, $response->get_status());

            $this->assertSame('150', wc_get_product($product->get_id())->get_regular_price());
            $this->assertSame('150', wc_get_product($variation)->get_regular_price());
            $this->assertCount($rows, $this->rows($this->batchId()));
        } finally {
            remove_role(CapabilitiesTest::ROLE);
        }
    }

    public function test_reverting_a_low_stock_threshold_that_was_unset_clears_it(): void
    {
        global $wpdb;

        $parent = $this->variableProduct(['38', '39']);
        $children = $parent->get_children();

        foreach ($children as $id) {
            $variation = wc_get_product($id);
            $variation->set_manage_stock(true);
            $variation->set_stock_quantity(4);
            $variation->save();
            $this->assertFalse(metadata_exists('post', $id, '_low_stock_amount') && get_post_meta($id, '_low_stock_amount', true) !== '');
        }

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/variations/batch', [
            'update' => array_map(static fn (int $id): array => ['id' => $id, 'low_stock_amount' => 3], $children),
        ]));
        $this->assertSame(3, wc_get_product($children[0])->get_low_stock_amount());

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertSame([true, true], array_column($data['results'], 'ok'));

        foreach ($children as $id) {
            $this->assertSame('', wc_get_product($id)->get_low_stock_amount(), 'Reverted to 0 instead of unset.');
            $this->assertSame('', (string) $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = '_low_stock_amount'", $id)));
        }

        // Undo of the same kind on a simple product.
        $simple = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 2]);
        $batch = wp_generate_uuid4();
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $simple->get_id(), 'low_stock_amount' => 7]]], [ListMode::BATCH_HEADER => $batch]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/batch/'.$batch.'/revert'));
        $this->assertSame('', wc_get_product($simple->get_id())->get_low_stock_amount());
    }

    public function test_reverting_stock_management_turned_on_clears_the_quantity(): void
    {
        $product = $this->simpleProduct();
        $this->assertNull($product->get_stock_quantity());

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'manage_stock' => true, 'stock_quantity' => 8]]]));
        $this->assertSame(8, wc_get_product($product->get_id())->get_stock_quantity());

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertTrue($data['results'][0]['ok']);

        $product = wc_get_product($product->get_id());
        $this->assertFalse($product->get_manage_stock());
        $this->assertNull($product->get_stock_quantity());
    }

    public function test_a_relative_stock_write_keeps_a_sale_made_meanwhile_and_is_logged(): void
    {
        $product = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 10]);

        // An order took 2 after the editor opened at 10; the editor asks for -3.
        wc_update_product_stock($product->get_id(), 2, 'decrease');

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'inventory_delta' => -3]]]));
        $this->assertSame(5, wc_get_product($product->get_id())->get_stock_quantity());

        $rows = $this->rows($this->batchId());
        $this->assertCount(1, $rows);
        $this->assertSame('stock_quantity', $rows[0]['field']);
        $this->assertSame('8', $rows[0]['old_value']);
        $this->assertSame('5', $rows[0]['new_value']);

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertSame(8, wc_get_product($product->get_id())->get_stock_quantity());
    }
}
