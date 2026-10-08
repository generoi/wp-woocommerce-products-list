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
 * The write side of list mode: `wc_products_list/save` for extension keys
 * and one log row per changed field for every wc/v3 save.
 */
class SaveHookTest extends RestTestCase
{
    /** @var array<int, array{0: WC_Product, 1: WP_REST_Request, 2: bool}> */
    private array $saves = [];

    public function set_up(): void
    {
        parent::set_up();

        $this->saves = [];
        Saves::resetWriteKeys();

        add_filter('wc_products_list/fields', function (array $fields): array {
            $fields[] = ['id' => 'i18n:se.name', 'path' => 'i18n.se.name.value', 'writePath' => 'i18n.se.name', 'applies' => ['variation' => true]];

            return $fields;
        });

        add_action('wc_products_list/save', function (WC_Product $product, WP_REST_Request $request, bool $creating): void {
            $this->saves[] = [$product, $request, $creating];

            foreach ((array) ($request['i18n'] ?? []) as $lang => $fields) {
                foreach ((array) $fields as $field => $value) {
                    if ($value === '') {
                        $product->delete_meta_data('_i18n_'.$field.'_'.$lang);
                    } else {
                        $product->update_meta_data('_i18n_'.$field.'_'.$lang, (string) $value);
                    }
                }
            }
        }, 10, 3);

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
    private function rows(?string $batch = null): array
    {
        global $wpdb;

        $table = Table::name();
        $batch ??= $this->batchId();

        return $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batch), ARRAY_A); // phpcs:ignore
    }

    public function test_save_fires_with_a_write_key_and_logs_the_extension_field(): void
    {
        $product = $this->simpleProduct();

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['i18n' => ['se' => ['name' => 'Saga bred sko']]]);
        $this->assertStatus(200, $response);

        $this->assertCount(1, $this->saves);
        $this->assertSame($product->get_id(), $this->saves[0][0]->get_id());
        $this->assertFalse($this->saves[0][2]);
        $this->assertSame('Saga bred sko', get_post_meta($product->get_id(), '_i18n_name_se', true));

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('i18n.se.name', $rows[0]['field']);
        $this->assertSame('', $rows[0]['old_value']);
        $this->assertSame('Saga bred sko', $rows[0]['new_value']);
        $this->assertSame('update', $rows[0]['action']);
        $this->assertSame('product', $rows[0]['object_type']);
        $this->assertSame('quick', $rows[0]['source']);
        $this->assertSame(get_current_user_id(), (int) $rows[0]['user_id']);
        $this->assertSame(['i18n'], json_decode($rows[0]['context'], true)['keys']);
    }

    public function test_save_does_not_fire_without_a_write_key(): void
    {
        $product = $this->simpleProduct();

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '199']));

        $this->assertSame([], $this->saves);
        $this->assertSame('199', wc_get_product($product->get_id())->get_regular_price());

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame(['regular_price', '189', '199'], [$rows[0]['field'], $rows[0]['old_value'], $rows[0]['new_value']]);
    }

    public function test_write_keys_filter_is_a_fallback_for_fields_without_a_registry_entry(): void
    {
        add_filter('wc_products_list/write_keys', static fn (array $keys): array => array_merge($keys, ['ext']));
        Saves::resetWriteKeys();

        $product = $this->simpleProduct();

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['ext' => ['flag' => 'yes']]));

        $this->assertCount(1, $this->saves);
        $this->assertContains('ext', Saves::writeKeys());
        $this->assertContains('i18n', Saves::writeKeys());
    }

    public function test_nothing_happens_outside_list_mode(): void
    {
        $product = $this->simpleProduct();

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '199', 'i18n' => ['se' => ['name' => 'x']]], [ListMode::HEADER => '']);
        $this->assertStatus(200, $response);

        $this->assertSame([], $this->saves);
        $this->assertSame([], $this->rows());
        $this->assertSame('199', wc_get_product($product->get_id())->get_regular_price());
    }

    public function test_batch_update_logs_each_product_under_the_batch_header(): void
    {
        $a = $this->simpleProduct(['sku' => 'A']);
        $b = $this->simpleProduct(['sku' => 'B', 'regular_price' => '100']);

        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => [
                ['id' => $a->get_id(), 'sale_price' => '149', 'date_on_sale_from' => '2026-11-01', 'date_on_sale_to' => '2026-11-30'],
                ['id' => $b->get_id(), 'sale_price' => '80', 'regular_price' => '100'],
            ],
        ], [Logger::SOURCE_HEADER => 'bulk']);
        $this->assertStatus(200, $response);

        $rows = $this->rows();
        $byField = [];

        foreach ($rows as $row) {
            $byField[$row['object_id']][$row['field']] = [$row['old_value'], $row['new_value'], $row['source']];
        }

        $this->assertSame(['', '149', 'bulk'], $byField[$a->get_id()]['sale_price']);
        $this->assertSame([null, '2026-11-01T00:00:00', 'bulk'], $byField[$a->get_id()]['date_on_sale_from']);
        $this->assertSame([null, '2026-11-30T00:00:00', 'bulk'], $byField[$a->get_id()]['date_on_sale_to']);
        $this->assertSame(['', '80', 'bulk'], $byField[$b->get_id()]['sale_price']);
        // regular_price did not change: no row.
        $this->assertArrayNotHasKey('regular_price', $byField[$b->get_id()]);
        $this->assertCount(4, $rows);
    }

    public function test_variations_batch_logs_variation_rows_with_their_parent(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        $ids = $parent->get_children();

        $response = $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', [
            'update' => [
                ['id' => $ids[0], 'sale_price' => '149', 'i18n' => ['se' => ['name' => 'Storlek 38']]],
                ['id' => $ids[1], 'stock_quantity' => 5, 'manage_stock' => true],
            ],
        ]);
        $this->assertStatus(200, $response);

        $this->assertCount(1, $this->saves);
        $this->assertSame($ids[0], $this->saves[0][0]->get_id());

        $rows = $this->rows();
        $this->assertCount(4, $rows);

        foreach ($rows as $row) {
            $this->assertSame('variation', $row['object_type']);
            $this->assertSame($parent->get_id(), (int) $row['parent_id']);
        }

        $fields = array_column($rows, 'new_value', 'field');
        $this->assertSame('149', $fields['sale_price']);
        $this->assertSame('Storlek 38', $fields['i18n.se.name']);
        $this->assertSame('5', $fields['stock_quantity']);
        $this->assertSame('true', $fields['manage_stock']);
    }

    /**
     * A batch response carries the whole object of every item; with
     * `fields` on the batch request each item row is trimmed to what the
     * app shows, `id` always included. Errors are untouched.
     */
    public function test_batch_item_rows_are_trimmed_to_fields(): void
    {
        $a = $this->simpleProduct(['sku' => 'A']);
        $b = $this->simpleProduct(['sku' => 'B']);
        $taken = $this->simpleProduct(['sku' => 'TAKEN']);

        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => [
                ['id' => $a->get_id(), 'sale_price' => '149'],
                ['id' => $b->get_id(), 'sku' => 'TAKEN'],
            ],
        ], [], ['fields' => 'sale_price,price,wc_products_list.can_edit']);
        $this->assertStatus(200, $response);

        $data = $this->data($response);
        $this->assertCount(2, $data['update']);

        $row = $data['update'][0];
        $this->assertSame(['id', 'price', 'sale_price', 'wc_products_list'], array_values(array_intersect(['id', 'price', 'sale_price', 'wc_products_list'], array_keys($row))));
        $this->assertSame($a->get_id(), $row['id']);
        $this->assertSame('149', $row['sale_price']);
        $this->assertArrayNotHasKey('name', $row);
        $this->assertArrayNotHasKey('description', $row);
        $this->assertArrayNotHasKey('meta_data', $row);
        // A nested path keeps its top-level key whole, as Rows::trim() documents.
        $this->assertTrue($row['wc_products_list']['can_edit']);
        $this->assertArrayNotHasKey('brands', $row);
        // WooCommerce adds `_links` to every collection item after the row filters.
        $this->assertSame(['id', 'price', 'sale_price', 'wc_products_list'], array_values(array_diff(array_keys($row), ['_links'])));

        $error = $data['update'][1];
        $this->assertSame($b->get_id(), $error['id']);
        $this->assertSame('product_invalid_sku', $error['error']['code']);

        // Without `fields` the rows are whole, as WooCommerce returns them.
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $a->get_id(), 'sale_price' => '139']]]);
        $row = $this->data($response)['update'][0];
        $this->assertArrayHasKey('name', $row);
        $this->assertArrayHasKey('description', $row);

        // Variations batch, the same way.
        $parent = $this->variableProduct(['38']);
        $response = $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', [
            'update' => [['id' => $parent->get_children()[0], 'sale_price' => '99']],
        ], [], ['fields' => 'sale_price,parent_id']);
        $row = $this->data($response)['update'][0];
        $this->assertSame(['id', 'sale_price', 'parent_id'], array_values(array_diff(array_keys($row), ['_links'])));
        $this->assertSame($parent->get_id(), $row['parent_id']);

        // A single write is core's business (`_fields`), not trimmed by `fields`.
        $response = $this->request('POST', '/wc/v3/products/'.$a->get_id(), ['sale_price' => '129'], [], ['fields' => 'sale_price']);
        $this->assertArrayHasKey('name', $this->data($response));
    }

    public function test_no_op_writes_produce_no_rows(): void
    {
        $product = $this->simpleProduct(['sku' => 'SAME']);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['sku' => 'SAME', 'regular_price' => '189', 'sale_price' => '']));

        $this->assertSame([], $this->rows());
    }

    public function test_array_fields_are_stored_in_request_shape(): void
    {
        $product = $this->simpleProduct();
        $term = wp_insert_term('Boots', 'product_cat');
        $this->assertIsArray($term);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), [
            'categories' => [['id' => $term['term_id']]],
            'dimensions' => ['length' => '10', 'width' => '', 'height' => ''],
            'meta_data' => [['key' => '_custom', 'value' => 'x']],
        ]));

        $rows = array_column($this->rows(), null, 'field');

        $this->assertSame('[{"id":'.$term['term_id'].'}]', $rows['categories']['new_value']);
        $this->assertSame('{"length":"10","width":"","height":""}', $rows['dimensions']['new_value']);
        $this->assertSame('{"length":"","width":"","height":""}', $rows['dimensions']['old_value']);
        $this->assertNull($rows['meta_data._custom']['old_value']);
        $this->assertSame('x', $rows['meta_data._custom']['new_value']);
    }

    public function test_rejected_saves_are_logged_as_errors(): void
    {
        $this->simpleProduct(['sku' => 'TAKEN']);
        $product = $this->simpleProduct(['sku' => 'FREE']);

        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $product->get_id(), 'sku' => 'TAKEN']],
        ]);
        $this->assertStatus(200, $response);
        $this->assertArrayHasKey('error', $this->data($response)['update'][0]);

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('error', $rows[0]['status']);
        $this->assertSame('sku', $rows[0]['field']);
        $this->assertSame($product->get_id(), (int) $rows[0]['object_id']);
        $this->assertNotSame('', $rows[0]['message']);
        $this->assertSame('product_invalid_sku', json_decode($rows[0]['context'], true)['code']);

        $this->assertSame('FREE', wc_get_product($product->get_id())->get_sku());
    }

    public function test_a_generated_batch_id_groups_rows_when_the_header_is_missing(): void
    {
        global $wpdb;

        $product = $this->simpleProduct();

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '1', 'sale_price' => '0.5'], [ListMode::BATCH_HEADER => '']);
        $this->assertStatus(200, $response);

        $this->assertSame([], $this->rows());

        $table = Table::name();
        $batches = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT batch_id FROM {$table} WHERE object_id = %d", $product->get_id())); // phpcs:ignore
        $this->assertCount(1, $batches);
        $this->assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $batches[0]);
        $this->assertCount(2, $this->rows($batches[0]));
    }

    public function test_logged_action_fires_with_the_rows(): void
    {
        $seen = [];
        add_action('wc_products_list/logged', function (array $rows, string $batch) use (&$seen): void {
            $seen[] = [count($rows), $batch];
        }, 10, 2);

        $product = $this->simpleProduct();
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['name' => 'Renamed']));

        $this->assertSame([[1, $this->batchId()]], $seen);
    }
}
