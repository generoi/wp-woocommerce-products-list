<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\BatchState;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Rest\Concurrency;
use GeneroWP\ProductsList\Rest\LogController;

/**
 * Server-side protection against concurrent edits (docs/contracts.md §3.6):
 * expected values, the per-object lock, fresh loads under a primed batch,
 * the Trash, the revert lock and the running-batch marker.
 */
class ConcurrencyTest extends RestTestCase
{
    /** @var \mysqli|null a second database connection: "another PHP process" */
    private ?\mysqli $other = null;

    public function tear_down(): void
    {
        if ($this->other !== null) {
            $this->other->close();
            $this->other = null;
        }

        Concurrency::unlockObjects();

        parent::tear_down();
    }

    /**
     * Another process: its own connection, outside this test's transaction.
     */
    private function other(): \mysqli
    {
        return $this->other ??= new \mysqli(DB_HOST, DB_USER, DB_PASSWORD, DB_NAME);
    }

    /**
     * Write a meta value straight to the database, the way another PHP
     * process would: this request's caches still hold the old value.
     */
    private function writeBehindTheCache(int $id, string $key, string $value): void
    {
        global $wpdb;

        $wpdb->update($wpdb->postmeta, ['meta_value' => $value], ['post_id' => $id, 'meta_key' => $key]);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function rows(?string $batch = null): array
    {
        global $wpdb;

        $table = Table::name();

        return $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batch ?? $this->batchId()), ARRAY_A); // phpcs:ignore
    }

    public function test_a_quick_edit_with_a_stale_expected_value_is_refused_and_logged_as_skipped(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        $id = $product->get_id();
        // Another tab changed the price after this editor loaded 15.
        update_post_meta($id, '_regular_price', '20');
        clean_post_cache($id);

        $response = $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '10', Concurrency::EXPECT_KEY => ['regular_price' => '15']]);

        $this->assertStatus(409, $response);
        $data = $this->data($response);
        $this->assertSame(Concurrency::CONFLICT_ERROR, $data['code']);
        $this->assertSame(['regular_price'], $data['data']['fields']);
        $this->assertSame(['regular_price' => '20'], $data['data']['current']);
        $this->assertSame('20', get_post_meta($id, '_regular_price', true));

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame(Logger::STATUS_SKIPPED, $rows[0]['status']);
        $this->assertSame('regular_price', $rows[0]['field']);
        $this->assertSame('conflict', json_decode((string) $rows[0]['context'], true)['reason']);
        $this->assertSame([], Concurrency::heldObjects(), 'the lock is released');
    }

    public function test_matching_expected_values_save_and_are_not_logged_as_fields(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $term = wp_insert_term('Boots', 'product_cat');

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id(), [
            'categories' => [['id' => $term['term_id']]],
        ]));
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id().'/variations/'.$v38, [
            // "189.00" is 189; the list sent its loaded row, names and all.
            'sale_price' => '99',
            Concurrency::EXPECT_KEY => ['regular_price' => '189.00', 'sale_price' => ''],
        ]));
        $this->assertSame('99', wc_get_product($v38)->get_sale_price());

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id(), [
            'name' => 'Renamed',
            Concurrency::EXPECT_KEY => ['categories' => [['id' => $term['term_id'], 'name' => 'Boots', 'slug' => 'boots']]],
        ]));
        $this->assertSame('Renamed', get_post($parent->get_id())->post_title);
        $this->assertNotContains(Concurrency::EXPECT_KEY, array_column($this->rows(), 'field'));
    }

    public function test_a_batch_refuses_only_the_item_that_changed(): void
    {
        $a = $this->simpleProduct(['regular_price' => '15']);
        $b = $this->simpleProduct(['regular_price' => '15']);
        update_post_meta($b->get_id(), '_regular_price', '30');
        clean_post_cache($b->get_id());

        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '12', Concurrency::EXPECT_KEY => ['regular_price' => '15']],
            ['id' => $b->get_id(), 'sale_price' => '12', Concurrency::EXPECT_KEY => ['regular_price' => '15']],
        ]], [Logger::SOURCE_HEADER => 'bulk']);

        $this->assertStatus(200, $response);
        $items = $this->data($response)['update'];
        $this->assertArrayNotHasKey('error', $items[0]);
        $this->assertSame(Concurrency::CONFLICT_ERROR, $items[1]['error']['code']);
        $this->assertSame('12', get_post_meta($a->get_id(), '_sale_price', true));
        $this->assertSame('', get_post_meta($b->get_id(), '_sale_price', true));
    }

    public function test_a_batch_item_is_saved_from_the_stored_state_not_the_primed_cache(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        [$v38, $v39] = $parent->get_children();

        foreach ([$v38, $v39] as $id) {
            $variation = wc_get_product($id);
            $variation->set_regular_price('15');
            $variation->save();
        }

        // Between the two items, another process lowers 39's regular price
        // to 10: the sale of 12 the batch then sets is not lower, and
        // WooCommerce must clear it (sale < regular), as it would have
        // with a fresh load.
        $hook = function ($object) use ($v38, $v39) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $v38) {
                $done = true;
                $this->writeBehindTheCache($v39, '_regular_price', '10');
            }

            return $object;
        };
        add_filter('woocommerce_rest_pre_insert_product_variation_object', $hook, 1);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', ['update' => [
            ['id' => $v38, 'sale_price' => '12'],
            ['id' => $v39, 'sale_price' => '12'],
        ]], [Logger::SOURCE_HEADER => 'bulk']));

        clean_post_cache($v39);
        $this->assertSame('10', get_post_meta($v39, '_regular_price', true));
        $this->assertSame('', get_post_meta($v39, '_sale_price', true), 'no sale at or above the regular price');
        $this->assertSame('10', get_post_meta($v39, '_price', true));
        $this->assertSame('12', get_post_meta($v38, '_sale_price', true));
    }

    public function test_a_trashed_product_is_not_written_unless_the_request_restores_it(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        wp_trash_post($product->get_id());

        $response = $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '99']);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::TRASHED_ERROR, $this->data($response)['code']);
        $this->assertSame('15', get_post_meta($product->get_id(), '_regular_price', true));
        $this->assertSame('trashed', json_decode((string) $this->rows()[0]['context'], true)['reason']);

        $batch = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'regular_price' => '99']]]);
        $this->assertSame(Concurrency::TRASHED_ERROR, $this->data($batch)['update'][0]['error']['code']);

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['status' => 'draft', 'regular_price' => '99']));
        $this->assertSame('99', get_post_meta($product->get_id(), '_regular_price', true));
    }

    public function test_a_save_waits_for_and_then_gives_up_on_another_save_of_the_object(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        add_filter(Concurrency::FILTER_LOCK_TIMEOUT, static fn (): int => 0);

        $name = Concurrency::lockName('o', (string) $product->get_id());
        $this->assertSame('1', (string) $this->other()->query("SELECT GET_LOCK('{$name}', 0)")->fetch_row()[0]);

        $response = $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '20']);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::LOCKED_ERROR, $this->data($response)['code']);
        $this->assertSame('15', get_post_meta($product->get_id(), '_regular_price', true));
        $this->assertSame('locked', json_decode((string) $this->rows()[0]['context'], true)['reason']);

        $this->other()->query("SELECT RELEASE_LOCK('{$name}')");
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '20'], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame('20', get_post_meta($product->get_id(), '_regular_price', true));
        $this->assertSame([], Concurrency::heldObjects());
    }

    public function test_a_revert_leaves_alone_an_edit_made_while_it_runs(): void
    {
        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '11'],
            ['id' => $b->get_id(), 'sale_price' => '11'],
        ]], [Logger::SOURCE_HEADER => 'bulk']));

        // After the revert's up-front check, before its write of $b: a quick
        // edit in another process sets $b's sale to 9.
        $hook = function ($object) use ($b) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $b->get_id()) {
                $done = true;
                $this->writeBehindTheCache($b->get_id(), '_sale_price', '9');
            }

            return $object;
        };
        add_filter('woocommerce_rest_pre_insert_product_object', $hook, 1);

        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(200, $response);
        $revert = (string) $this->data($response)['batch_id'];
        $results = array_column($this->data($response)['results'], null, 'id');

        $this->assertTrue($results[$a->get_id()]['ok']);
        $this->assertFalse($results[$b->get_id()]['ok']);
        $this->assertSame('conflict', $results[$b->get_id()]['code']);
        $this->assertSame(['sale_price' => '9'], $results[$b->get_id()]['current']);
        $this->assertSame(['sale_price' => '11'], $results[$b->get_id()]['batch']);

        clean_post_cache($b->get_id());
        $this->assertSame('9', get_post_meta($b->get_id(), '_sale_price', true), 'the edit made meanwhile is kept');
        $this->assertSame('', get_post_meta($a->get_id(), '_sale_price', true));

        $skipped = array_values(array_filter($this->rows($revert), static fn (array $row): bool => (int) $row['object_id'] === $b->get_id()));
        $this->assertSame(Logger::STATUS_SKIPPED, $skipped[0]['status']);
        $this->assertSame('conflict', json_decode((string) $skipped[0]['context'], true)['reason']);
    }

    public function test_only_one_revert_of_a_batch_runs_at_a_time(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['sale_price' => '11']));

        $name = Concurrency::lockName('r', md5($this->batchId()));
        $this->other()->query("SELECT GET_LOCK('{$name}', 0)");

        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::REVERT_RUNNING_ERROR, $this->data($response)['code']);
        $this->assertSame('11', get_post_meta($product->get_id(), '_sale_price', true));

        $this->other()->query("SELECT RELEASE_LOCK('{$name}')");
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame('', get_post_meta($product->get_id(), '_sale_price', true));
    }

    public function test_chunks_of_one_revert_share_the_claim_and_another_revert_is_refused(): void
    {
        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '11'],
            ['id' => $b->get_id(), 'sale_price' => '12'],
        ]]));

        $first = wp_generate_uuid4();
        $route = '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert';

        // The first chunk of a revert claims the batch...
        $this->assertStatus(200, $this->request('POST', $route, ['ids' => [$a->get_id()], 'revert_batch_id' => $first], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame($first, get_transient(Concurrency::revertClaim($this->batchId())));

        // ...a revert under another id is refused while the claim lasts...
        $response = $this->request('POST', $route, ['ids' => [$b->get_id()], 'revert_batch_id' => wp_generate_uuid4()], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::REVERT_RUNNING_ERROR, $this->data($response)['code']);
        $this->assertSame('12', get_post_meta($b->get_id(), '_sale_price', true));

        // ...and the next chunk of the same revert goes through.
        $this->assertStatus(200, $this->request('POST', $route, ['ids' => [$b->get_id()], 'revert_batch_id' => $first], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame('', get_post_meta($b->get_id(), '_sale_price', true));

        delete_transient(Concurrency::revertClaim($this->batchId()));
    }

    public function test_a_planned_batch_is_running_until_closed_and_interrupted_when_abandoned(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $planned = [BatchState::PLANNED_HEADER => '900', Logger::SOURCE_HEADER => 'bulk'];

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'sale_price' => '11']]], $planned));

        foreach (['/log/batch/'.$this->batchId(), '/log/batch/'.$this->batchId().'/check'] as $route) {
            $response = $this->request('GET', '/wc-products-list/v1'.$route);
            $this->assertStatus(409, $response);
            $this->assertSame(BatchState::RUNNING_ERROR, $this->data($response)['code']);
        }

        $revert = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(409, $revert);
        $this->assertSame('11', get_post_meta($product->get_id(), '_sale_price', true));

        $list = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertSame(BatchState::STATE_RUNNING, $list['items'][0]['state']);
        $this->assertSame(900, $list['items'][0]['planned']);

        // The tab went away: no write for longer than the TTL.
        $marker = BatchState::get($this->batchId());
        $marker['updated'] = time() - BatchState::ttl() - 5;
        update_option(BatchState::option($this->batchId()), $marker, false);

        $list = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertSame(BatchState::STATE_INTERRUPTED, $list['items'][0]['state']);
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));

        $close = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/close', [], [ListMode::BATCH_HEADER => '']);
        $this->assertStatus(200, $close);
        $this->assertTrue($this->data($close)['closed']);
        $this->assertNull(BatchState::get($this->batchId()));
        $this->assertNull($this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0]['state']);
    }

    public function test_a_single_request_marks_its_batch_only_while_it_runs(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $seen = null;

        add_action('woocommerce_rest_insert_product_object', function () use (&$seen): void {
            $seen = BatchState::running($this->batchId()) ? 'running' : 'idle';
            $this->assertNotNull(LogController::runningError($this->batchId()));
        }, 5);

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['sale_price' => '11']));
        $this->assertSame('running', $seen);
        $this->assertNull(BatchState::get($this->batchId()));
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
    }

    public function test_an_interrupted_variations_write_gets_its_parent_synced(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        // What a request killed after saving the variation leaves: the
        // variation is on sale, the parent's price was never synced.
        update_post_meta($v38, '_sale_price', '99');
        update_post_meta($v38, '_price', '99');
        update_option(BatchState::option($this->batchId()), [
            'user' => get_current_user_id(), 'planned' => 10, 'started' => time() - 600, 'updated' => time() - 600, 'parents' => [$parent->get_id()],
        ], false);

        $this->assertSame(BatchState::STATE_INTERRUPTED, BatchState::state($this->batchId()));
        $this->assertSame([], BatchState::get($this->batchId())['parents']);
        $this->assertContains('99', get_post_meta($parent->get_id(), '_price'));
    }

    public function test_another_user_cannot_mark_or_close_someone_elses_running_batch(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'sale_price' => '11']]], [BatchState::PLANNED_HEADER => '5']));
        $owner = BatchState::get($this->batchId())['user'];

        $this->actAs('shop_manager');
        $this->assertStatus(403, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/close', [], [ListMode::BATCH_HEADER => '']));
        $this->assertSame($owner, BatchState::get($this->batchId())['user']);
    }

    public function test_log_rows_are_written_per_item_not_at_the_end_of_the_request(): void
    {
        global $wpdb;

        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);
        $seen = null;
        $table = Table::name();

        add_filter('woocommerce_rest_pre_insert_product_object', function ($object) use ($b, &$seen, $wpdb, $table) {
            if ($object instanceof \WC_Product && $object->get_id() === $b->get_id()) {
                $seen = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE batch_id = %s", $this->batchId())); // phpcs:ignore
            }

            return $object;
        }, 1);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '11'],
            ['id' => $b->get_id(), 'sale_price' => '11'],
        ]]));

        $this->assertSame(1, $seen, "the first item's row is in the table before the second item is saved");
    }

    public function test_the_revert_plan_from_sql_matches_the_rows(): void
    {
        $simple = $this->simpleProduct(['regular_price' => '20']);
        $first = $this->variableProduct(['38', '39']);
        $second = $this->variableProduct(['40']);
        [$v38, $v39] = $first->get_children();
        [$v40] = $second->get_children();

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [
            ['id' => $v40, 'sale_price' => '99'],
            ['id' => $v39, 'sale_price' => '99'],
            ['id' => $v38, 'sale_price' => '99'],
        ]]));
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $simple->get_id(), 'sale_price' => '11', 'post_password' => 'x']]]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$second->get_id()]]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $this->batchId(), 'items' => [['id' => $simple->get_id(), 'reason' => 'unchanged']]]));

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $expected = Revert::objects($this->rows());

        $this->assertSame(array_column($expected['objects'], 'id'), array_merge(...$plan['chunks']));
        $this->assertSame([$simple->get_id(), $v40, $v39, $v38], array_merge(...$plan['chunks']));
        $this->assertEqualsCanonicalizing($expected['skipped'], $plan['skipped']);
        $this->assertSame(['unchanged' => 1], $plan['left_out_reasons']);
        $this->assertSame(1, $plan['left_out']);
    }
}
