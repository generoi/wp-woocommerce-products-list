<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Table;

/**
 * Who can put rows into the change log and who can read it: a refused
 * write logs nothing, a replayed batch id cannot reach into another
 * user's batch, and the log is for users who may edit everyone's products.
 */
class LogSecurityTest extends RestTestCase
{
    public function set_up(): void
    {
        parent::set_up();

        add_role('catalog_limited', 'Limited', ['read' => true, 'edit_products' => true, 'edit_product' => true]);
    }

    public function tear_down(): void
    {
        remove_role('catalog_limited');

        parent::tear_down();
    }

    private function logCount(): int
    {
        global $wpdb;

        $table = Table::name();

        return (int) $wpdb->get_var("SELECT COUNT(*) FROM {$table}"); // phpcs:ignore
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

    public function test_an_anonymous_write_logs_nothing(): void
    {
        $product = $this->simpleProduct();
        $before = $this->logCount();
        $this->actAs('guest');

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['name' => 'Injected <b>x</b>', 'regular_price' => '0.01']);
        $this->assertStatus(401, $response);

        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'name' => 'Injected']]]);
        $this->assertStatus(401, $response);

        $response = $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [['id' => $product->get_id(), 'name' => 'Injected']]]);
        $this->assertStatus(401, $response);

        $this->assertSame($before, $this->logCount());
        $this->assertSame('Saga wide toe boot', wc_get_product($product->get_id())->get_name());
    }

    public function test_a_subscriber_write_logs_nothing(): void
    {
        $product = $this->simpleProduct();
        $before = $this->logCount();
        $this->actAs('subscriber');

        $this->assertStatus(403, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['name' => 'Injected']));
        $this->assertSame($before, $this->logCount());
    }

    public function test_a_write_refused_for_the_product_logs_nothing(): void
    {
        // Created by the administrator: a user with edit_products alone may not edit it.
        $product = $this->simpleProduct();
        $before = $this->logCount();
        $this->actAs('catalog_limited');

        $response = $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['name' => 'Injected']);
        $this->assertSame(403, $response->get_status());
        $this->assertSame($before, $this->logCount());
    }

    public function test_a_failed_save_of_an_allowed_user_is_still_logged(): void
    {
        $taken = $this->simpleProduct(['sku' => 'TAKEN-1']);
        $product = $this->simpleProduct(['sku' => 'FREE-1']);

        $response = $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['sku' => 'TAKEN-1']);
        $this->assertSame(400, $response->get_status());

        $rows = $this->rows($this->batchId());
        $this->assertCount(1, $rows);
        $this->assertSame('error', $rows[0]['status']);
        $this->assertSame($product->get_id(), (int) $rows[0]['object_id']);
        $this->assertNotSame(0, $taken->get_id());
    }

    public function test_a_batch_id_of_another_user_is_not_joined(): void
    {
        $product = $this->simpleProduct();
        $other = $this->simpleProduct();
        $admin = get_current_user_id();
        $batch = $this->batchId();

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '199']));
        $this->assertCount(1, $this->rows($batch));

        // Anonymous, refused: nothing at all.
        $this->actAs('guest');
        $this->assertStatus(401, $this->request('PUT', '/wc/v3/products/'.$other->get_id(), ['regular_price' => '1'], [ListMode::BATCH_HEADER => $batch]));

        // Another user who may write: the rows go under a batch id of their own.
        $manager = $this->actAs('shop_manager');
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$other->get_id(), ['regular_price' => '209'], [ListMode::BATCH_HEADER => $batch]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/feature', ['ids' => [$other->get_id()]], [ListMode::BATCH_HEADER => $batch]));

        $rows = $this->rows($batch);
        $this->assertCount(1, $rows);
        $this->assertSame($admin, (int) $rows[0]['user_id']);

        // The manager's rows exist, under another id.
        global $wpdb;
        $table = Table::name();
        $theirs = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT batch_id FROM {$table} WHERE user_id = %d", $manager)); // phpcs:ignore
        $this->assertNotEmpty($theirs);
        $this->assertNotContains($batch, $theirs);

        // And reusing the admin's id as the id of a revert is refused.
        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$theirs[0].'/revert', ['revert_batch_id' => $batch]);
        $this->assertSame(409, $response->get_status());

        // The admin's batch is still theirs alone and revertable.
        $this->actAs('administrator');
        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$batch));
        $this->assertSame(1, $plan['users']);
        $this->assertTrue($plan['revertable']);
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/batch/'.$batch.'/revert'));
        $this->assertSame('189', wc_get_product($product->get_id())->get_regular_price());
    }

    public function test_the_log_needs_the_log_capability(): void
    {
        $this->actAs('catalog_limited');

        foreach (['/log', '/log/users', '/log/batches', '/log/batch/'.wp_generate_uuid4()] as $route) {
            $this->assertSame(403, $this->request('GET', '/wc-products-list/v1'.$route)->get_status(), $route);
        }

        $this->assertSame(403, $this->request('POST', '/wc-products-list/v1/log/batch/'.wp_generate_uuid4().'/revert')->get_status());
        $this->assertFalse(Bootstrap::settings()['caps']['viewLog']);
        // No History link for the app to show.
        $this->assertSame('', Bootstrap::settings()['links']['history']);

        $this->actAs('shop_manager');
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/log'));
        $this->assertTrue(Bootstrap::settings()['caps']['viewLog']);
        $this->assertStringContainsString('screen=history', Bootstrap::settings()['links']['history']);
    }
}
