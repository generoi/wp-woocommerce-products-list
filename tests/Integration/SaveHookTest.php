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
        $this->assertEqualsCanonicalizing(['id', 'price', 'sale_price', 'wc_products_list'], array_values(array_diff(array_keys($row), ['_links'])));
        $this->assertSame($a->get_id(), $row['id']);
        $this->assertSame('149', $row['sale_price']);
        $this->assertArrayNotHasKey('name', $row);
        $this->assertArrayNotHasKey('description', $row);
        $this->assertArrayNotHasKey('meta_data', $row);
        // A nested path keeps its top-level key whole, as Rows::trim() documents.
        $this->assertTrue($row['wc_products_list']['can_edit']);
        $this->assertArrayNotHasKey('brands', $row);
        // WooCommerce adds `_links` to every collection item after the row filters.
        $this->assertArrayNotHasKey('_embedded', $row);

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
        $this->assertEqualsCanonicalizing(['id', 'sale_price', 'parent_id'], array_values(array_diff(array_keys($row), ['_links'])));
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
        $owner = $this->simpleProduct(['sku' => 'TAKEN', 'name' => 'Skinners Nocturna']);
        $product = $this->simpleProduct(['sku' => 'FREE']);

        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $product->get_id(), 'sku' => 'TAKEN']],
        ]);
        $this->assertStatus(200, $response);
        $error = $this->data($response)['update'][0]['error'];
        // The message names the product that has the SKU.
        $expected = sprintf('The SKU "TAKEN" is already used by "Skinners Nocturna" (#%d).', $owner->get_id());
        $this->assertSame($expected, $error['message']);

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('error', $rows[0]['status']);
        $this->assertSame('sku', $rows[0]['field']);
        $this->assertSame($product->get_id(), (int) $rows[0]['object_id']);
        $this->assertSame($expected, $rows[0]['message']);
        // What was there and what was tried.
        $this->assertSame(['FREE', 'TAKEN'], [$rows[0]['old_value'], $rows[0]['new_value']]);
        $this->assertSame('product_invalid_sku', json_decode($rows[0]['context'], true)['code']);

        $this->assertSame('FREE', wc_get_product($product->get_id())->get_sku());
    }

    public function test_a_rejected_single_save_names_the_sku_owner_and_keeps_the_values(): void
    {
        $owner = $this->simpleProduct(['sku' => 'TAKEN', 'name' => 'Owner']);
        $product = $this->simpleProduct(['sku' => 'FREE', 'regular_price' => '10']);

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['sku' => 'TAKEN', 'regular_price' => '12']);
        $this->assertSame(400, $response->get_status());
        $this->assertSame(sprintf('The SKU "TAKEN" is already used by "Owner" (#%d).', $owner->get_id()), $response->as_error()->get_error_message());

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('', $rows[0]['field']);
        $context = json_decode($rows[0]['context'], true);
        $this->assertSame(['sku' => 'TAKEN', 'regular_price' => '12'], $context['attempted']);
        $this->assertSame('FREE', $context['before']['sku']);

        // A malformed SKU nobody owns keeps WooCommerce's own message.
        $this->assertNull(Saves::skuOwnerMessage('NOBODY', $product->get_id()));
        $this->assertNull(Saves::skuOwnerMessage('FREE', $product->get_id()));
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

    /**
     * Only a UUID v4 is taken as a batch id. A client-chosen literal
     * reused across saves (or across users) would merge unrelated
     * operations into one revertable batch.
     */
    public function test_a_batch_header_that_is_not_a_uuid_is_replaced_by_a_generated_id(): void
    {
        global $wpdb;

        $product = $this->simpleProduct();

        foreach (['audit-r3', 'AUDIT', '12345678-1234-1234-1234-123456789012', str_repeat('a', 36)] as $literal) {
            $this->assertFalse(ListMode::isBatchId($literal), $literal);
        }

        $this->assertTrue(ListMode::isBatchId(wp_generate_uuid4()));
        $this->assertTrue(ListMode::isBatchId(strtoupper(wp_generate_uuid4())));

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '2'], [ListMode::BATCH_HEADER => 'audit-r3']);
        $this->assertStatus(200, $response);
        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '3'], [ListMode::BATCH_HEADER => 'audit-r3']);
        $this->assertStatus(200, $response);

        $this->assertSame([], $this->rows('audit-r3'));

        $table = Table::name();
        $batches = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT batch_id FROM {$table} WHERE object_id = %d", $product->get_id())); // phpcs:ignore
        // Two saves, two batches: each request gets its own generated id.
        $this->assertCount(2, $batches);

        foreach ($batches as $batch) {
            $this->assertTrue(ListMode::isBatchId($batch), $batch);
        }
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

    /**
     * @return array<int, string> the queries run while `$run` executes that match `$pattern`
     */
    private function queriesMatching(string $pattern, callable $run): array
    {
        $seen = [];
        $filter = static function (string $query) use (&$seen, $pattern): string {
            if (preg_match($pattern, $query)) {
                $seen[] = $query;
            }

            return $query;
        };

        add_filter('query', $filter);
        $run();
        remove_filter('query', $filter);

        return $seen;
    }

    /**
     * WooCommerce reuses the per-item request objects of a batch; the
     * recorder keys its snapshots by that object, so an item that fails
     * between two that succeed must neither lose its error row nor hand
     * its snapshot to the next item.
     */
    public function test_a_failing_item_between_two_good_ones_is_logged_on_its_own(): void
    {
        $this->simpleProduct(['sku' => 'TAKEN']);
        $a = $this->simpleProduct(['sku' => 'A']);
        $b = $this->simpleProduct(['sku' => 'B']);
        $c = $this->simpleProduct(['sku' => 'C']);

        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => [
                ['id' => $a->get_id(), 'regular_price' => '10'],
                ['id' => $b->get_id(), 'sku' => 'TAKEN', 'regular_price' => '20'],
                ['id' => $c->get_id(), 'regular_price' => '30'],
            ],
        ]);
        $this->assertStatus(200, $response);
        $update = $this->data($response)['update'];
        $this->assertArrayNotHasKey('error', $update[0]);
        $this->assertSame('product_invalid_sku', $update[1]['error']['code']);
        $this->assertArrayNotHasKey('error', $update[2]);

        $rows = $this->rows();
        $this->assertCount(3, $rows);

        $byObject = array_column($rows, null, 'object_id');
        $this->assertSame(['ok', 'regular_price', '189', '10'], [$byObject[$a->get_id()]['status'], $byObject[$a->get_id()]['field'], $byObject[$a->get_id()]['old_value'], $byObject[$a->get_id()]['new_value']]);
        $this->assertSame(['ok', 'regular_price', '189', '30'], [$byObject[$c->get_id()]['status'], $byObject[$c->get_id()]['field'], $byObject[$c->get_id()]['old_value'], $byObject[$c->get_id()]['new_value']]);
        $this->assertSame('error', $byObject[$b->get_id()]['status']);
        $this->assertSame('product_invalid_sku', json_decode($byObject[$b->get_id()]['context'], true)['code']);
        $this->assertEqualsCanonicalizing(['sku', 'regular_price'], json_decode($byObject[$b->get_id()]['context'], true)['fields']);

        $this->assertSame('10', wc_get_product($a->get_id())->get_regular_price());
        $this->assertSame('189', wc_get_product($b->get_id())->get_regular_price());
        $this->assertSame('B', wc_get_product($b->get_id())->get_sku());
        $this->assertSame('30', wc_get_product($c->get_id())->get_regular_price());
    }

    /**
     * A batch item is serialised by WooCommerce with the batch's `fields`
     * as its own `_fields`, so the controller never builds what the app
     * will not read (a variable product's price range, its variation
     * list, the gallery), and brands are not queried for it either.
     */
    public function test_batch_items_are_serialised_with_the_batch_fields_only(): void
    {
        if (! taxonomy_exists('product_brand')) {
            $this->markTestSkipped('No product_brand taxonomy.');
        }

        $parent = $this->variableProduct(['38', '39']);
        $brand = wp_insert_term('Saga', 'product_brand');
        $this->assertIsArray($brand);
        wp_set_object_terms($parent->get_id(), [(int) $brand['term_id']], 'product_brand');
        $seen = [];

        // After the brands callback (10), before the trim (1000): what WooCommerce built.
        add_filter('woocommerce_rest_prepare_product_object', static function ($response, $product, $request) use (&$seen) {
            $seen[] = [
                'fields' => $request->get_param('_fields'),
                'keys' => array_keys((array) $response->get_data()),
            ];

            return $response;
        }, 999, 3);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $parent->get_id(), 'status' => 'draft']],
        ], [], ['fields' => 'id,status,wc_products_list.can_edit']));

        $this->assertCount(1, $seen);
        $this->assertSame('id,status,wc_products_list.can_edit,id', $seen[0]['fields']);
        // Nothing the app did not ask for was built: no price range, no
        // images, no description, no brands (`variations` is the one key
        // WooCommerce always adds to a variable product, from the cached
        // children; `wc_products_list` is the plugin's own).
        $this->assertEqualsCanonicalizing(['id', 'status', 'variations', 'wc_products_list'], $seen[0]['keys']);
        $this->assertSame('draft', get_post_status($parent->get_id()));

        // Brands are built when the batch asks for them.
        $seen = [];
        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $parent->get_id(), 'status' => 'publish']],
        ], [], ['fields' => 'id,status,brands']);
        $this->assertContains('brands', $seen[0]['keys']);
        $this->assertSame([(int) $brand['term_id']], array_column($this->data($response)['update'][0]['brands'], 'id'));

        // Without `fields` the sub-request keeps WooCommerce's full row.
        $seen = [];
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', [
            'update' => [['id' => $parent->get_id(), 'status' => 'publish']],
        ]));
        $this->assertNull($seen[0]['fields']);
        $this->assertContains('description', $seen[0]['keys']);
        $this->assertContains('brands', $seen[0]['keys']);
    }

    /**
     * Saving a variable product loads every variation (WooCommerce looks
     * for downloadable children), and serialising it afterwards reads
     * every variation's price (the price transient is gone); the children
     * are primed in bulk rather than loaded one by one.
     */
    public function test_a_saved_variable_product_reads_its_variations_in_bulk(): void
    {
        global $wpdb;

        $parent = $this->variableProduct(['38', '39', '40']);
        $children = $parent->get_children();
        wp_cache_flush();

        $pattern = '/'.preg_quote($wpdb->postmeta, '/').' WHERE post_id IN \\((\\d+)\\) ORDER BY meta_id/';
        $single = $this->queriesMatching($pattern, function () use ($parent): void {
            // `on_sale` and `price_html` read every variation's price.
            $response = $this->request('POST', '/wc/v3/products/batch', [
                'update' => [['id' => $parent->get_id(), 'status' => 'draft']],
            ], [], ['fields' => 'id,status,price,on_sale,price_html']);
            $this->assertStatus(200, $response);
            $row = $this->data($response)['update'][0];
            $this->assertFalse($row['on_sale']);
            $this->assertStringContainsString('189', $row['price_html']);
        });

        $perChild = [];

        foreach ($single as $query) {
            preg_match($pattern, $query, $m);
            $perChild[(int) $m[1]] = true;
        }

        $this->assertSame([], array_values(array_intersect(array_keys($perChild), $children)), 'A variation was loaded with its own meta query: '.implode("\n", $single));
    }

    /**
     * A list-mode products batch primes its items' posts, meta and raw meta
     * up front (no per-item raw meta read) and deletes WooCommerce's
     * global product transients once for the batch, not five times per item.
     */
    public function test_a_products_batch_primes_its_items_and_coalesces_transient_deletes(): void
    {
        $ids = [];

        for ($i = 0; $i < 10; $i++) {
            $ids[] = $this->simpleProduct(['sku' => 'P'.$i])->get_id();
        }

        wp_cache_flush();

        $rawMeta = 0;
        $featuredTransient = 0;
        $filter = static function (string $query) use (&$rawMeta, &$featuredTransient): string {
            if (preg_match('/meta_id, meta_key, meta_value\s+FROM \S*postmeta\s+WHERE post_id = \d+/', $query)) {
                $rawMeta++;
            }

            if (str_contains($query, "option_name = '_transient_wc_featured_products'")) {
                $featuredTransient++;
            }

            return $query;
        };

        add_filter('query', $filter);
        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => array_map(static fn (int $id): array => ['id' => $id, 'featured' => true], $ids),
        ], [], ['fields' => 'id,featured']);
        remove_filter('query', $filter);

        $this->assertStatus(200, $response);
        $this->assertSame(array_fill(0, 10, true), array_column($this->data($response)['update'], 'featured'));
        $this->assertSame(0, $rawMeta, 'raw meta reads before the saves');
        // delete_transient() is a SELECT (and a DELETE when it exists): once for the batch.
        $this->assertLessThanOrEqual(2, $featuredTransient);
        $this->assertCount(10, $this->rows());
    }
}
