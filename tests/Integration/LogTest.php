<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Prune;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Modules\Log;
use GeneroWP\ProductsList\Plugin;
use GeneroWP\ProductsList\Rest\LogController;

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
        $this->assertEqualsCanonicalizing(['PRIMARY', 'batch_id', 'object_created', 'user_id', 'created_at', 'reverts'], array_values($indexes));

        // Idempotent.
        Table::install();
        $this->assertTrue(Table::exists());
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

    public function test_upgrade_is_a_version_compare_on_the_hot_path(): void
    {
        // Installed: no SHOW TABLES, no dbDelta (which starts with SHOW TABLES and DESCRIBE).
        $queries = $this->queriesMatching('/SHOW TABLES|DESCRIBE|CREATE TABLE|ALTER TABLE/i', static function (): void {
            Table::maybeInstall();
            (new Log)->maybeUpgrade();
        });
        $this->assertSame([], $queries);

        // A plugin update bumped the schema version: dbDelta runs once and the option follows.
        update_option(Table::OPTION, '0');
        $this->assertFalse(Table::installed());

        $queries = $this->queriesMatching('/DESCRIBE|CREATE TABLE|ALTER TABLE/i', static function (): void {
            Table::maybeInstall();
        });
        $this->assertNotSame([], $queries);
        $this->assertSame(Table::VERSION, get_option(Table::OPTION));
        $this->assertTrue(Table::installed());
        $this->assertTrue(Table::exists());
    }

    /**
     * REST requests are known as such only after `init`, so the upgrade
     * also hangs off `rest_api_init`: a plugin update lands on the first
     * app request, not on the next admin page load.
     */
    public function test_upgrade_runs_on_the_first_rest_request(): void
    {
        update_option(Table::OPTION, '0');
        $this->assertFalse(Table::installed());

        $log = new Log;
        $log->maybeUpgrade();
        $this->assertFalse(Table::installed(), 'Not an admin, cron or REST request: nothing happens.');

        $this->assertSame(1, has_action('rest_api_init', [Plugin::getInstance()->module(Log::class), 'maybeUpgrade']));

        $queries = $this->queriesMatching('/DESCRIBE|CREATE TABLE|ALTER TABLE/i', static function (): void {
            do_action('rest_api_init');
        });
        $this->assertNotSame([], $queries);
        $this->assertTrue(Table::installed());
    }

    public function test_the_logger_recreates_a_missing_table_on_its_first_write(): void
    {
        global $wpdb;

        // The test suite turns CREATE/DROP TABLE into temporary tables, which
        // would leave the real table in place; the real one has to go.
        remove_filter('query', [$this, '_create_temporary_tables']);
        remove_filter('query', [$this, '_drop_temporary_tables']);

        try {
            // The option says installed, the table is gone (a restore from an older dump).
            $wpdb->query('DROP TABLE IF EXISTS '.Table::name()); // phpcs:ignore
            $this->assertFalse(Table::exists());
            $this->healAndAssert();
        } finally {
            Table::install();
            add_filter('query', [$this, '_create_temporary_tables']);
            add_filter('query', [$this, '_drop_temporary_tables']);
        }
    }

    private function healAndAssert(): void
    {
        global $wpdb;

        $this->assertTrue(Table::installed());
        $this->assertTrue(Logger::tableIsMissing("Table 'wp_tests.".Table::name()."' doesn't exist"));
        $this->assertFalse(Logger::tableIsMissing('Duplicate entry'));

        // The first INSERT fails (that is the point); its error must not be printed.
        $suppressed = $wpdb->suppress_errors();
        $this->seed([['batch_id' => 'healed', 'object_id' => 1, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b']]);
        $wpdb->suppress_errors($suppressed);

        $this->assertTrue(Table::exists());
        $table = Table::name();
        $this->assertSame(['healed'], $wpdb->get_col("SELECT batch_id FROM {$table}")); // phpcs:ignore
    }

    public function test_prune_is_unscheduled_on_deactivation_and_rescheduled_in_the_admin(): void
    {
        Prune::schedule();
        $this->assertNotFalse(wp_next_scheduled(Prune::HOOK));

        do_action(Plugin::ACTION_DEACTIVATE);
        $this->assertFalse(wp_next_scheduled(Prune::HOOK));

        // Not an admin, cron or REST request: nothing happens.
        (new Log)->maybeUpgrade();
        $this->assertFalse(wp_next_scheduled(Prune::HOOK));

        set_current_screen('dashboard');
        $this->assertTrue(is_admin());
        (new Log)->maybeUpgrade();
        $this->assertNotFalse(wp_next_scheduled(Prune::HOOK));
        $GLOBALS['current_screen'] = null;
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

    public function test_log_users_lists_who_made_changes(): void
    {
        $manager = self::factory()->user->create(['role' => 'shop_manager', 'display_name' => 'Aino Manager']);
        $this->seed([
            ['batch_id' => 'b1', 'object_id' => 1, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b'],
            ['batch_id' => 'b2', 'object_id' => 2, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b', 'user_id' => $manager],
            ['batch_id' => 'b3', 'object_id' => 3, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b', 'user_id' => $manager],
            ['batch_id' => 'b4', 'object_id' => 4, 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b', 'user_id' => 0],
        ]);

        $response = $this->request('GET', '/wc-products-list/v1/log/users');
        $this->assertStatus(200, $response);

        $users = $this->data($response);
        $this->assertEqualsCanonicalizing([get_current_user_id(), $manager], array_column($users, 'id'));
        $this->assertSame('Aino Manager', $users[0]['name']);
        $this->assertSame(wp_get_current_user()->display_name, $users[1]['name']);
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

    /**
     * History shows the first 8 characters of a batch id; typing them
     * finds the batch, in the log and in the batch list.
     */
    public function test_the_batch_filter_takes_the_start_of_an_id(): void
    {
        $product = $this->simpleProduct();
        $a = '04f3e251-a30b-40a8-a97f-cee4cc45d63f';
        $b = '04f3ffff-a30b-40a8-a97f-cee4cc45d63f';

        $this->seed([
            ['batch_id' => $a, 'object_id' => $product->get_id(), 'field' => 'regular_price', 'old_value' => '1', 'new_value' => '2'],
            ['batch_id' => $a, 'object_id' => $product->get_id(), 'field' => 'sale_price', 'old_value' => '', 'new_value' => '1'],
            ['batch_id' => $b, 'object_id' => $product->get_id(), 'field' => 'name', 'old_value' => 'a', 'new_value' => 'b'],
        ]);

        $log = fn (string $batch): array => $this->data($this->request('GET', '/wc-products-list/v1/log', ['batch' => $batch]));
        $batches = fn (string $batch): array => $this->data($this->request('GET', '/wc-products-list/v1/log/batches', ['batch' => $batch]));

        $this->assertSame(2, $log('04f3e251')['total']);
        $this->assertSame(2, $log($a)['total']);
        $this->assertSame(3, $log('04f3')['total']);
        $this->assertSame([$a], array_column($batches('04F3E251')['items'], 'batch_id'));
        // Too short to be meant as an id, and LIKE wildcards are literal.
        $this->assertSame(0, $log('04f')['total']);
        $this->assertSame(0, $log('04f3%')['total']);
        $this->assertSame(['batch_id = %s', 'b1'], LogController::batchCondition('b1'));
    }

    /**
     * A failed change is counted apart from the trash/restore rows a
     * revert skips, and its row says what was tried.
     */
    public function test_the_revert_plan_counts_failed_changes_apart(): void
    {
        $product = $this->simpleProduct();
        $batch = wp_generate_uuid4();

        $this->seed([
            ['batch_id' => $batch, 'object_id' => $product->get_id(), 'field' => 'menu_order', 'old_value' => '0', 'new_value' => '5'],
            ['batch_id' => $batch, 'object_id' => 99999999, 'field' => 'menu_order', 'old_value' => null, 'new_value' => '5', 'status' => 'error', 'message' => 'Invalid ID.'],
        ]);

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$batch));
        $this->assertSame(1, $plan['failed']);
        $this->assertSame([['id' => 99999999, 'object_type' => 'product', 'action' => 'failed']], $plan['skipped']);
        $this->assertNull($plan['reverted_by']);

        $summary = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0];
        $this->assertSame(1, $summary['errors']);
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

    /**
     * A batch id the log holds for two users is one somebody replayed:
     * neither the plan nor the revert treats it as one operation.
     */
    public function test_a_batch_with_rows_of_two_users_is_not_revertable(): void
    {
        $product = $this->simpleProduct(['sale_price' => '1']);
        $other = $this->simpleProduct();
        $mine = get_current_user_id();
        $colleague = self::factory()->user->create(['role' => 'shop_manager']);
        $shared = wp_generate_uuid4();
        $own = wp_generate_uuid4();

        $this->seed([
            ['batch_id' => $shared, 'object_id' => $product->get_id(), 'field' => 'regular_price', 'old_value' => '1', 'new_value' => '2', 'user_id' => $mine],
            ['batch_id' => $shared, 'object_id' => $other->get_id(), 'field' => 'regular_price', 'old_value' => '5', 'new_value' => '6', 'user_id' => $colleague],
            ['batch_id' => $own, 'object_id' => $product->get_id(), 'field' => 'sale_price', 'old_value' => '', 'new_value' => '1', 'user_id' => $mine],
        ]);

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$shared));
        $this->assertSame(2, $plan['users']);
        $this->assertSame(2, $plan['objects']);
        $this->assertFalse($plan['revertable']);

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$own));
        $this->assertSame(1, $plan['users']);
        $this->assertTrue($plan['revertable']);

        $batches = array_column($this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'], null, 'batch_id');
        $this->assertFalse($batches[$shared]['revertable']);
        $this->assertSame(2, $batches[$shared]['users']);
        $this->assertTrue($batches[$own]['revertable']);

        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$shared.'/revert');
        $this->assertStatus(409, $response);
        $this->assertSame('wc_products_list_batch_shared', $this->data($response)['code']);
        $this->assertSame('189', wc_get_product($product->get_id())->get_regular_price());

        // One chunk of it is refused just the same.
        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$shared.'/revert', ['ids' => [$product->get_id()]]);
        $this->assertStatus(409, $response);

        // The revert's own batch id has to be a UUID too.
        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$own.'/revert', ['revert_batch_id' => 'undo-1']);
        $this->assertStatus(400, $response);
        $this->assertSame('rest_invalid_param', $this->data($response)['code']);
        $this->assertSame('1', wc_get_product($product->get_id())->get_sale_price());

        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$own.'/revert'));
        $this->assertTrue($data['results'][0]['ok']);
        $this->assertTrue(ListMode::isBatchId($data['batch_id']));
        $this->assertSame('', wc_get_product($product->get_id())->get_sale_price());
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
