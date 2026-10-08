<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Prune;
use GeneroWP\ProductsList\Log\Table;

/**
 * The log table, the logger and GET /log, GET /log/batches.
 */
class LogTest extends RestTestCase
{
    public function test_table_is_installed_with_its_indexes(): void
    {
        global $wpdb;

        $this->assertTrue(Table::exists());
        $this->assertTrue(Table::installed());

        $indexes = array_unique(array_column($wpdb->get_results('SHOW INDEX FROM '.Table::name(), ARRAY_A), 'Key_name')); // phpcs:ignore
        $this->assertEqualsCanonicalizing(['PRIMARY', 'batch_id', 'object_created', 'user_id', 'created_at'], array_values($indexes));

        // Idempotent.
        Table::install();
        $this->assertTrue(Table::exists());
    }

    /**
     * @param  array<int, array<string, mixed>>  $rows
     */
    private function seed(array $rows): void
    {
        Logger::log($rows);
        Logger::flush();
    }

    public function test_log_lists_rows_newest_first_with_user_object_and_links(): void
    {
        $product = $this->simpleProduct();
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];

        $this->seed([
            ['batch_id' => 'b1', 'object_id' => $product->get_id(), 'field' => 'regular_price', 'old_value' => '189', 'new_value' => '199', 'created_at' => '2026-10-01 10:00:00'],
            ['batch_id' => 'b1', 'object_id' => $variation, 'object_type' => 'variation', 'parent_id' => $parent->get_id(), 'field' => 'sale_price', 'old_value' => null, 'new_value' => '149', 'created_at' => '2026-10-01 10:00:01'],
            ['batch_id' => 'b2', 'source' => 'action', 'action' => 'trash', 'object_id' => $product->get_id(), 'field' => 'status', 'old_value' => 'publish', 'new_value' => 'trash', 'created_at' => '2026-10-02 10:00:00'],
            ['batch_id' => 'b3', 'source' => 'bulk', 'object_id' => 99999999, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b', 'status' => 'error', 'message' => 'Nope', 'created_at' => '2026-10-03 10:00:00'],
        ]);

        $response = $this->request('GET', '/wc-products-list/v1/log');
        $this->assertStatus(200, $response);
        $this->assertSame('4', $response->get_headers()['X-WP-Total']);

        $data = $this->data($response);
        $this->assertSame(4, $data['total']);
        $this->assertSame(1, $data['totalPages']);
        $this->assertSame(['b3', 'b2', 'b1', 'b1'], array_column($data['items'], 'batch_id'));

        $error = $data['items'][0];
        $this->assertSame('error', $error['status']);
        $this->assertSame('Nope', $error['message']);
        $this->assertSame('', $error['object_name']);
        $this->assertNull($error['edit_link']);
        $this->assertSame('2026-10-03T10:00:00', $error['created_at_gmt']);
        $this->assertSame(get_date_from_gmt('2026-10-03 10:00:00', 'Y-m-d\TH:i:s'), $error['created_at']);
        $this->assertSame(get_current_user_id(), $error['user']['id']);
        $this->assertSame(wp_get_current_user()->display_name, $error['user']['name']);

        $variationRow = $data['items'][2];
        $this->assertSame('variation', $variationRow['object_type']);
        $this->assertSame($parent->get_id(), $variationRow['parent_id']);
        $this->assertNull($variationRow['old_value']);
        $this->assertSame('149', $variationRow['new_value']);
        $this->assertStringContainsString('post='.$parent->get_id(), $variationRow['edit_link']);

        $productRow = $data['items'][3];
        $this->assertSame('Saga wide toe boot', $productRow['object_name']);
        $this->assertStringContainsString('post='.$product->get_id(), $productRow['edit_link']);
    }

    public function test_log_filters(): void
    {
        $product = $this->simpleProduct();
        $other = $this->simpleProduct();
        $otherUser = self::factory()->user->create(['role' => 'shop_manager']);

        $this->seed([
            ['batch_id' => 'b1', 'object_id' => $product->get_id(), 'field' => 'regular_price', 'old_value' => '1', 'new_value' => '2', 'created_at' => '2026-10-01 10:00:00'],
            ['batch_id' => 'b1', 'object_id' => $product->get_id(), 'field' => 'i18n.se.name', 'old_value' => '', 'new_value' => 'Saga', 'created_at' => '2026-10-01 10:00:00'],
            ['batch_id' => 'b2', 'object_id' => $other->get_id(), 'parent_id' => $product->get_id(), 'object_type' => 'variation', 'field' => 'sale_price', 'old_value' => '', 'new_value' => '9', 'source' => 'bulk', 'user_id' => $otherUser, 'created_at' => '2026-10-05 10:00:00'],
            ['batch_id' => 'b3', 'object_id' => $other->get_id(), 'field' => 'status', 'action' => 'trash', 'source' => 'action', 'created_at' => '2026-10-07 10:00:00'],
        ]);

        $ids = fn (array $params): array => array_column($this->data($this->request('GET', '/wc-products-list/v1/log', $params))['items'], 'batch_id');

        $this->assertSame(['b1', 'b1'], $ids(['object_id' => $product->get_id()]));
        $this->assertSame(['b2'], $ids(['parent_id' => $product->get_id()]));
        $this->assertSame(['b2'], $ids(['batch' => 'b2']));
        $this->assertSame(['b2'], $ids(['user' => $otherUser]));
        $this->assertSame(['b1'], $ids(['field' => 'regular_price']));
        $this->assertSame(['b1'], $ids(['field' => 'i18n.se.*']));
        $this->assertSame(['b2'], $ids(['source' => 'bulk']));
        $this->assertSame(['b3'], $ids(['action' => 'trash']));
        $this->assertSame(['b3', 'b2'], $ids(['since' => '2026-10-05']));
        $this->assertSame(['b1', 'b1'], $ids(['until' => '2026-10-04T00:00:00']));
        $this->assertSame(['b2'], $ids(['since' => '2026-10-02', 'until' => '2026-10-06']));
        $this->assertSame(['b1'], $ids(['search' => 'saga']));
        $this->assertSame([], $ids(['search' => '100%']));
    }

    public function test_log_paginates_and_caps_per_page(): void
    {
        $rows = [];

        for ($i = 1; $i <= 7; $i++) {
            $rows[] = ['batch_id' => 'b', 'object_id' => $i, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b'];
        }

        $this->seed($rows);

        $response = $this->request('GET', '/wc-products-list/v1/log', ['per_page' => 3, 'page' => 3]);
        $data = $this->data($response);
        $this->assertSame(7, $data['total']);
        $this->assertSame(3, $data['totalPages']);
        $this->assertSame([1], array_column($data['items'], 'object_id'));
        $this->assertSame('3', $response->get_headers()['X-WP-TotalPages']);

        $response = $this->request('GET', '/wc-products-list/v1/log', ['per_page' => 500]);
        $this->assertStatus(400, $response);
    }

    public function test_batches_are_grouped_summaries(): void
    {
        $product = $this->simpleProduct();

        $this->seed([
            ['batch_id' => 'b1', 'object_id' => $product->get_id(), 'field' => 'regular_price', 'old_value' => '1', 'new_value' => '2', 'created_at' => '2026-10-01 10:00:00'],
            ['batch_id' => 'b1', 'object_id' => $product->get_id(), 'field' => 'sale_price', 'old_value' => '', 'new_value' => '1', 'created_at' => '2026-10-01 10:00:01'],
            ['batch_id' => 'b1', 'object_id' => $product->get_id() + 1, 'field' => 'sale_price', 'old_value' => '', 'new_value' => '1', 'created_at' => '2026-10-01 10:00:02'],
            ['batch_id' => 'b2', 'object_id' => $product->get_id(), 'field' => 'status', 'action' => 'trash', 'source' => 'action', 'old_value' => 'publish', 'new_value' => 'trash', 'created_at' => '2026-10-02 10:00:00'],
        ]);

        $response = $this->request('GET', '/wc-products-list/v1/log/batches');
        $this->assertStatus(200, $response);
        $data = $this->data($response);

        $this->assertSame(2, $data['total']);
        $this->assertSame('b2', $data['items'][0]['batch_id']);
        $this->assertFalse($data['items'][0]['revertable']);
        $this->assertSame('action', $data['items'][0]['source']);

        $b1 = $data['items'][1];
        $this->assertSame('b1', $b1['batch_id']);
        $this->assertSame(3, $b1['rows']);
        $this->assertSame(2, $b1['objects']);
        $this->assertSame(['regular_price', 'sale_price'], $b1['fields']);
        $this->assertTrue($b1['revertable']);
        $this->assertSame('2026-10-01T10:00:00', $b1['created_at_gmt']);
        $this->assertSame(get_current_user_id(), $b1['user']['id']);

        $data = $this->data($this->request('GET', '/wc-products-list/v1/log/batches', ['source' => 'action']));
        $this->assertSame(['b2'], array_column($data['items'], 'batch_id'));
    }

    public function test_log_requires_the_capability(): void
    {
        $this->actAs('editor');
        $this->assertStatus(403, $this->request('GET', '/wc-products-list/v1/log'));
        $this->assertStatus(403, $this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertStatus(403, $this->request('POST', '/wc-products-list/v1/log/batch/x/revert'));

        $this->actAs('guest');
        $this->assertStatus(401, $this->request('GET', '/wc-products-list/v1/log'));

        $this->actAs('shop_manager');
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/log'));
    }

    public function test_prune_drops_rows_older_than_the_retention(): void
    {
        global $wpdb;

        $this->seed([
            ['batch_id' => 'old', 'object_id' => 1, 'field' => 'name', 'created_at' => gmdate('Y-m-d H:i:s', time() - 200 * DAY_IN_SECONDS)],
            ['batch_id' => 'edge', 'object_id' => 1, 'field' => 'name', 'created_at' => gmdate('Y-m-d H:i:s', time() - 179 * DAY_IN_SECONDS)],
            ['batch_id' => 'new', 'object_id' => 1, 'field' => 'name'],
        ]);

        $this->assertSame(180, Prune::retentionDays());
        $this->assertSame(1, Prune::run());

        $table = Table::name();
        $this->assertEqualsCanonicalizing(['edge', 'new'], $wpdb->get_col("SELECT batch_id FROM {$table}")); // phpcs:ignore

        add_filter('wc_products_list/log_retention_days', static fn (): int => 0);
        $this->assertSame(0, Prune::run());

        remove_all_filters('wc_products_list/log_retention_days');
        add_filter('wc_products_list/log_retention_days', static fn (): int => 1);
        $this->assertSame(1, Prune::run());
        $this->assertSame(['new'], $wpdb->get_col("SELECT batch_id FROM {$table}")); // phpcs:ignore

        $this->assertNotFalse(wp_next_scheduled(Prune::HOOK));
    }
}
