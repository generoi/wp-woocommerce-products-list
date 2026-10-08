<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Logger;
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
    }

    public function test_only_update_rows_revert_and_array_fields_round_trip(): void
    {
        $product = $this->simpleProduct();
        $trashed = $this->simpleProduct();
        $term = wp_insert_term('Boots', 'product_cat');
        $this->assertIsArray($term);
        $original = $product->get_category_ids();

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
}
