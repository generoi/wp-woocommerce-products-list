<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Actions\Action;
use GeneroWP\ProductsList\Actions\Duplicate;
use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Table;
use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * POST /wc-products-list/v1/actions/{action}.
 */
class ActionsTest extends RestTestCase
{
    /**
     * @param  array<int, int>  $ids
     * @param  array<string, mixed>  $args
     * @return array<string, mixed>
     */
    private function act(string $action, array $ids, array $args = [], array $query = []): array
    {
        $response = $this->request('POST', '/wc-products-list/v1/actions/'.$action, ['ids' => $ids, 'args' => $args] + $query);
        $this->assertStatus(200, $response);

        return $this->data($response);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function rows(): array
    {
        global $wpdb;

        $table = Table::name();

        return $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $this->batchId()), ARRAY_A); // phpcs:ignore
    }

    public function test_trash_and_restore_keep_the_previous_status(): void
    {
        $published = $this->simpleProduct();
        $draft = $this->simpleProduct(['status' => 'draft']);
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];

        $data = $this->act('trash', [$published->get_id(), $draft->get_id(), $variation]);

        $this->assertSame($this->batchId(), $data['batch_id']);
        $this->assertSame([true, true, true], array_column($data['results'], 'ok'));
        $this->assertSame('trash', get_post_status($published->get_id()));
        $this->assertSame('trash', get_post_status($draft->get_id()));
        $this->assertSame('trash', get_post_status($variation));

        // Refreshed rows: trashed ones are still found.
        $items = array_column($data['items'], null, 'id');
        $this->assertSame('trash', $items[$published->get_id()]['status']);
        $this->assertArrayHasKey($variation, $items);
        $this->assertSame($parent->get_id(), $items[$variation]['wc_products_list']['parent_id'] ?? $items[$variation]['parent_id'] ?? null);

        $rows = $this->rows();
        $this->assertCount(3, $rows);
        $this->assertSame(['action', 'trash', 'status', 'publish', 'trash', 'ok'], [$rows[0]['source'], $rows[0]['action'], $rows[0]['field'], $rows[0]['old_value'], $rows[0]['new_value'], $rows[0]['status']]);
        $this->assertSame(['variation', (string) $parent->get_id()], [$rows[2]['object_type'], $rows[2]['parent_id']]);

        $data = $this->act('restore', [$published->get_id(), $draft->get_id(), $variation]);
        $this->assertSame([true, true, true], array_column($data['results'], 'ok'));
        $this->assertSame('publish', get_post_status($published->get_id()));
        $this->assertSame('draft', get_post_status($draft->get_id()));
        $this->assertSame('publish', get_post_status($variation));

        $data = $this->act('restore', [$published->get_id()]);
        $this->assertFalse($data['results'][0]['ok']);
        $this->assertSame('wc_products_list_not_trashed', $data['results'][0]['code']);
    }

    /**
     * A product trashed without a slug (a never-published draft, a fresh
     * copy) must not come back as `__trashed`; one with a slug keeps it.
     */
    public function test_restore_does_not_leave_a_trashed_slug(): void
    {
        global $wpdb;

        $draft = $this->simpleProduct(['status' => 'draft', 'name' => 'Organic Care (Copy)']);
        $wpdb->update($wpdb->posts, ['post_name' => ''], ['ID' => $draft->get_id()]);
        clean_post_cache($draft->get_id());
        $published = $this->simpleProduct(['name' => 'Nocturna']);
        $slug = get_post($published->get_id())->post_name;
        $this->assertNotSame('', $slug);

        $this->act('trash', [$draft->get_id(), $published->get_id()]);
        $this->assertSame('__trashed', get_post($draft->get_id())->post_name);

        $this->act('restore', [$draft->get_id(), $published->get_id()]);
        $this->assertSame('draft', get_post_status($draft->get_id()));
        $this->assertSame('', get_post($draft->get_id())->post_name);
        $this->assertSame($slug, get_post($published->get_id())->post_name);

        // A published product whose remembered slug is gone gets one from its title.
        $this->act('trash', [$published->get_id()]);
        delete_post_meta($published->get_id(), '_wp_desired_post_slug');
        $this->act('restore', [$published->get_id()]);
        $this->assertSame('publish', get_post_status($published->get_id()));
        $this->assertSame($slug, get_post($published->get_id())->post_name);
    }

    public function test_delete_is_permanent_and_takes_variations_along(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        $children = $parent->get_children();
        $gone = $parent->get_id() + 100000;
        wp_trash_post($parent->get_id());

        $data = $this->act('delete', [$parent->get_id(), $gone]);

        $this->assertTrue($data['results'][0]['ok']);
        $this->assertFalse($data['results'][1]['ok']);
        $this->assertSame('not_found', $data['results'][1]['code']);
        $this->assertNull(get_post($parent->get_id()));
        $this->assertNull(get_post($children[0]));
        $this->assertSame([], $data['items']);

        $rows = $this->rows();
        $this->assertCount(2, $rows);
        $this->assertSame(['delete', 'status', 'trash', null, 'ok'], [$rows[0]['action'], $rows[0]['field'], $rows[0]['old_value'], $rows[0]['new_value'], $rows[0]['status']]);
        $this->assertSame(['error', $gone], [$rows[1]['status'], (int) $rows[1]['object_id']]);
    }

    /**
     * The UI offers "Delete permanently" outside the Trash only behind
     * `wc_products_list/allow_hard_delete`; the route enforces the same.
     */
    public function test_delete_outside_the_trash_needs_the_hard_delete_filter(): void
    {
        $published = $this->simpleProduct();
        $draft = $this->simpleProduct(['status' => 'draft']);
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];

        $data = $this->act('delete', [$published->get_id(), $draft->get_id()]);

        $this->assertSame([false, false], array_column($data['results'], 'ok'));
        $this->assertSame(['wc_products_list_not_trashed'], array_unique(array_column($data['results'], 'code')));
        $this->assertSame('publish', get_post_status($published->get_id()));
        $this->assertSame('draft', get_post_status($draft->get_id()));

        $rows = $this->rows();
        $this->assertCount(2, $rows);
        $this->assertSame(['error'], array_unique(array_column($rows, 'status')));
        $this->assertSame('wc_products_list_not_trashed', json_decode($rows[0]['context'], true)['code']);

        // Variations have no Trash: retiring a colour deletes them directly.
        $data = $this->act('delete', [$variation]);
        $this->assertTrue($data['results'][0]['ok']);
        $this->assertNull(get_post($variation));
        $this->assertNotNull(get_post($parent->get_id()));

        add_filter(Bootstrap::FILTER_ALLOW_HARD_DELETE, '__return_true');

        try {
            $data = $this->act('delete', [$published->get_id()]);
        } finally {
            remove_filter(Bootstrap::FILTER_ALLOW_HARD_DELETE, '__return_true');
        }

        $this->assertTrue($data['results'][0]['ok']);
        $this->assertNull(get_post($published->get_id()));
    }

    public function test_duplicate_returns_the_draft_copy(): void
    {
        $product = $this->simpleProduct(['sku' => 'DUP']);

        $data = $this->act('duplicate', [$product->get_id()]);

        $this->assertTrue($data['results'][0]['ok']);
        $newId = $data['results'][0]['data']['new_id'];
        $copy = wc_get_product($newId);
        $this->assertInstanceOf(WC_Product::class, $copy);
        $this->assertSame('draft', $copy->get_status());
        $this->assertStringContainsString('Saga wide toe boot', $copy->get_name());
        $this->assertNotSame('DUP', $copy->get_sku());

        // The log names the copy: History can link to it.
        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame(['duplicate', 'duplicate', null, (string) $newId, 'ok'], [$rows[0]['action'], $rows[0]['field'], $rows[0]['old_value'], $rows[0]['new_value'], $rows[0]['status']]);
        $context = json_decode($rows[0]['context'], true);
        $this->assertSame($newId, $context['new_id']);
        $this->assertSame($copy->get_name(), $context['new_title']);
        $this->assertSame([], $context['args']);

        $log = $this->data($this->request('GET', '/wc-products-list/v1/log', ['batch' => $this->batchId()]));
        $this->assertSame((string) $newId, $log['items'][0]['new_value']);
        $this->assertSame(['id' => $newId, 'name' => $copy->get_name(), 'edit_link' => get_edit_post_link($newId, 'raw')], $log['items'][0]['related']);
        $this->assertNull($this->data($this->request('GET', '/wc-products-list/v1/log', ['object_id' => $product->get_id(), 'action' => 'update']))['items'][0]['related'] ?? null);

        // A duplicate row is not an update: a revert of the batch skips it.
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $this->assertSame('skipped', $data['results'][0]['code']);
        $this->assertInstanceOf(WC_Product::class, wc_get_product($newId));

        // Variations are not duplicated on their own.
        $parent = $this->variableProduct(['38']);
        $data = $this->act('duplicate', [$parent->get_children()[0]]);
        $this->assertSame('not_applicable', $data['results'][0]['code']);
    }

    /**
     * Over HTTP, `WC()->is_rest_api_request()` is true and WooCommerce
     * takes a "SKU lock" before saving the copy; a third party answering
     * `wc_product_pre_lock_on_sku` with false (Polylang for WooCommerce
     * does, for a product without a language, which every fresh copy is)
     * makes WooCommerce delete the copy and throw. `rest_do_request()` in
     * a test is not an HTTP request, so both are simulated.
     */
    public function test_duplicate_survives_the_rest_sku_lock(): void
    {
        $parent = $this->variableProduct(['38', '39'], ['sku' => 'LOCKED']);
        $variation = wc_get_product($parent->get_children()[0]);
        $variation->set_sku('VAR-38');
        $variation->save();

        // WC()->is_rest_api_request() looks at REQUEST_URI before its filter.
        $uri = $_SERVER['REQUEST_URI'] ?? null;
        $_SERVER['REQUEST_URI'] = '/wp-json/wc-products-list/v1/actions/duplicate';
        $this->assertTrue(WC()->is_rest_api_request());
        $asked = 0;
        add_filter('wc_product_pre_lock_on_sku', function ($locked) use (&$asked) {
            $asked++;

            return $locked ?? false;
        }, 10);

        $data = $this->act('duplicate', [$parent->get_id()]);

        $this->assertTrue($data['results'][0]['ok'], wp_json_encode($data['results']));
        $copy = wc_get_product($data['results'][0]['data']['new_id']);
        $this->assertInstanceOf(WC_Product::class, $copy);
        $this->assertSame('draft', $copy->get_status());
        $this->assertSame('LOCKED-1', $copy->get_sku());
        $this->assertCount(2, $copy->get_children());
        $this->assertContains('VAR-38-1', array_map(static fn (int $id): string => wc_get_product($id)->get_sku(), $copy->get_children()));
        // The lock was asked for (the product data store takes it; the
        // variation data store does not) and answered before the third party.
        $this->assertSame(1, $asked);

        // The answer does not leak into later saves.
        $this->assertTrue(has_filter('wc_product_pre_lock_on_sku') !== false);
        $this->assertFalse(has_filter('wc_product_pre_lock_on_sku', [Duplicate::class, 'lockObtained']));

        $rows = $this->rows();
        $this->assertSame(['ok'], array_unique(array_column($rows, 'status')));

        if ($uri === null) {
            unset($_SERVER['REQUEST_URI']);
        } else {
            $_SERVER['REQUEST_URI'] = $uri;
        }
    }

    public function test_duplicate_reports_sku_conflicts_in_plain_words(): void
    {
        $product = $this->simpleProduct(['sku' => 'TAKEN']);
        $this->simpleProduct(['sku' => 'TAKEN-1']);

        // The copy ends up with a SKU somebody else holds, as when a trashed
        // copy exists or a concurrent request got there first.
        add_action('woocommerce_product_duplicate_before_save', static function (WC_Product $duplicate): void {
            $duplicate->set_sku('TAKEN-1');
        });

        $data = $this->act('duplicate', [$product->get_id()]);

        $this->assertFalse($data['results'][0]['ok'], wp_json_encode($data['results']));
        $this->assertSame('wc_products_list_duplicate_sku', $data['results'][0]['code']);
        $this->assertStringContainsString('Could not duplicate "Saga wide toe boot"', $data['results'][0]['message']);
        $this->assertStringContainsString('TAKEN', $data['results'][0]['message']);
        $this->assertStringNotContainsString('lookup table', $data['results'][0]['message']);

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('error', $rows[0]['status']);
        $this->assertSame('wc_products_list_duplicate_sku', json_decode($rows[0]['context'], true)['code']);
    }

    /**
     * Refreshing the rows after an action must not cost a nested list
     * request per (parent, status) group: variations are serialised
     * directly, products in one request per status.
     */
    public function test_refresh_covers_variations_of_several_parents_in_bounded_requests(): void
    {
        $a = $this->variableProduct(['38', '39']);
        $b = $this->variableProduct(['40', '41']);
        $c = $this->variableProduct(['42']);
        $published = $this->simpleProduct();
        $draft = $this->simpleProduct(['status' => 'draft']);
        $variations = array_merge($a->get_children(), $b->get_children(), $c->get_children());

        $nested = [];
        add_filter('rest_request_before_callbacks', function ($response, $handler, WP_REST_Request $request) use (&$nested) {
            if (str_starts_with($request->get_route(), '/wc/v3/')) {
                $nested[] = $request->get_route();
            }

            return $response;
        }, 10, 3);

        $ids = array_merge($variations, [$published->get_id(), $draft->get_id()]);
        $data = $this->act('trash', $ids);

        $this->assertSame(array_fill(0, 7, true), array_column($data['results'], 'ok'));
        // Both products are in the trash now: one products request, no variations requests.
        $this->assertSame(['/wc/v3/products'], $nested);

        $items = array_column($data['items'], null, 'id');
        $this->assertEqualsCanonicalizing($ids, array_keys($items));

        foreach ([$a, $b, $c] as $parent) {
            foreach ($parent->get_children() as $variation) {
                $this->assertSame('trash', $items[$variation]['status']);
                $this->assertSame($parent->get_id(), $items[$variation]['parent_id']);
                $this->assertSame($parent->get_id(), $items[$variation]['wc_products_list']['parent_id']);
                $this->assertArrayNotHasKey('_links', $items[$variation]);
            }
        }

        // Mixed statuses on the way back: publish and draft are two product groups.
        $nested = [];
        $data = $this->act('restore', [$variations[0], $variations[2], $variations[4], $published->get_id(), $draft->get_id()], [], ['fields' => 'id,status,parent_id']);

        $this->assertCount(2, $nested);
        $this->assertSame(['/wc/v3/products'], array_unique($nested));

        $items = array_column($data['items'], null, 'id');
        $this->assertCount(5, $items);
        $this->assertSame('publish', $items[$published->get_id()]['status']);
        $this->assertSame('draft', $items[$draft->get_id()]['status']);
        $this->assertSame('publish', $items[$variations[0]]['status']);
        $this->assertSame($b->get_id(), $items[$variations[2]]['parent_id']);
        $this->assertSame(['id', 'status', 'parent_id'], array_keys($items[$variations[4]]));
    }

    public function test_publish_draft_and_feature(): void
    {
        $product = $this->simpleProduct(['status' => 'draft']);

        $data = $this->act('publish', [$product->get_id()]);
        $this->assertTrue($data['results'][0]['ok']);
        $this->assertSame('publish', get_post_status($product->get_id()));
        $this->assertSame('publish', $data['items'][0]['status']);

        $data = $this->act('draft', [$product->get_id()]);
        $this->assertSame('draft', get_post_status($product->get_id()));

        $data = $this->act('feature', [$product->get_id()], ['featured' => true]);
        $this->assertTrue(wc_get_product($product->get_id())->get_featured());
        $this->assertTrue($data['items'][0]['featured']);

        $data = $this->act('feature', [$product->get_id()], ['featured' => 'false']);
        $this->assertFalse(wc_get_product($product->get_id())->get_featured());

        $fields = array_column($this->rows(), 'new_value', 'field');
        $this->assertSame('false', $fields['featured']);
        $this->assertSame('draft', $fields['status']);
    }

    public function test_items_respect_fields(): void
    {
        $product = $this->simpleProduct();

        $data = $this->act('publish', [$product->get_id()], [], ['fields' => 'id,status']);

        $item = $data['items'][0];
        $this->assertSame($product->get_id(), $item['id']);
        $this->assertSame('publish', $item['status']);
        $this->assertArrayNotHasKey('name', $item);
        $this->assertArrayNotHasKey('sku', $item);
        $this->assertArrayNotHasKey('_links', $item);
    }

    public function test_limits_and_unknown_actions(): void
    {
        $response = $this->request('POST', '/wc-products-list/v1/actions/nope', ['ids' => [1]]);
        $this->assertStatus(404, $response);

        $response = $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => range(1, 101)]);
        $this->assertStatus(400, $response);
        $this->assertSame('wc_products_list_too_many_ids', $this->data($response)['code']);

        $response = $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => []]);
        $this->assertStatus(400, $response);

        $response = $this->request('POST', '/wc-products-list/v1/actions/trash', []);
        $this->assertStatus(400, $response);
    }

    public function test_route_and_per_id_capabilities(): void
    {
        $product = $this->simpleProduct();

        $this->actAs('editor');
        $response = $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$product->get_id()]]);
        $this->assertStatus(403, $response);

        $this->actAs('shop_manager');
        add_filter('map_meta_cap', function (array $caps, string $cap, int $user, array $args) use ($product): array {
            if ($cap === 'delete_post' && (int) ($args[0] ?? 0) === $product->get_id()) {
                return ['do_not_allow'];
            }

            return $caps;
        }, 10, 4);

        $data = $this->act('trash', [$product->get_id()]);
        $this->assertFalse($data['results'][0]['ok']);
        $this->assertSame('forbidden', $data['results'][0]['code']);
        $this->assertSame('publish', get_post_status($product->get_id()));

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame('error', $rows[0]['status']);
    }

    public function test_extension_actions_are_run_and_logged_with_their_changes(): void
    {
        add_filter('wc_products_list/action_handlers', static function (array $handlers): array {
            $handlers['i18n_copy'] = new class implements Action
            {
                public function id(): string
                {
                    return 'i18n_copy';
                }

                public function appliesTo(): string
                {
                    return 'both';
                }

                public function can(WC_Product $product): bool
                {
                    return true;
                }

                public function sanitizeArgs(array $args): array|WP_Error
                {
                    $lang = (string) ($args['lang'] ?? '');

                    return $lang === '' ? new WP_Error('missing_lang', 'lang is required') : ['lang' => $lang];
                }

                public function run(WC_Product $product, array $args, WP_REST_Request $request): array|WP_Error
                {
                    $key = '_i18n_name_'.$args['lang'];
                    $old = (string) get_post_meta($product->get_id(), $key, true);
                    update_post_meta($product->get_id(), $key, $product->get_name());

                    return ['changes' => ['i18n.'.$args['lang'].'.name' => [$old, $product->get_name()]]];
                }
            };

            return $handlers;
        });

        $product = $this->simpleProduct();

        $response = $this->request('POST', '/wc-products-list/v1/actions/i18n_copy', ['ids' => [$product->get_id()], 'args' => []]);
        $this->assertStatus(400, $response);
        $this->assertSame('missing_lang', $this->data($response)['code']);

        $data = $this->act('i18n_copy', [$product->get_id()], ['lang' => 'se']);
        $this->assertTrue($data['results'][0]['ok']);
        $this->assertSame('Saga wide toe boot', get_post_meta($product->get_id(), '_i18n_name_se', true));

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame(['i18n_copy', 'i18n.se.name', '', 'Saga wide toe boot', 'action'], [$rows[0]['action'], $rows[0]['field'], $rows[0]['old_value'], $rows[0]['new_value'], $rows[0]['source']]);
        $this->assertSame(['lang' => 'se'], json_decode($rows[0]['context'], true)['args']);
    }

    /**
     * The refresh dispatches wc/v3 requests from inside the action
     * request; once they are done the action request is the current one
     * again for everything that still runs on it, and nothing is current
     * after it.
     */
    public function test_a_nested_dispatch_restores_the_outer_request(): void
    {
        $product = $this->simpleProduct();
        $seen = [];

        add_filter('rest_request_after_callbacks', static function ($response, $handler, WP_REST_Request $request) use (&$seen) {
            $current = ListMode::request();
            $seen[$request->get_route()] = [$current?->get_route(), ListMode::method(), ListMode::batchId()];

            return $response;
        }, 10, 3);

        $this->act('publish', [$product->get_id()]);

        $this->assertSame(['/wc/v3/products', 'GET', null], $seen['/wc/v3/products']);
        $this->assertSame(['/wc-products-list/v1/actions/publish', 'POST', $this->batchId()], $seen['/wc-products-list/v1/actions/publish']);
        $this->assertNull(ListMode::request());
    }

    public function test_heavy_actions_take_fewer_ids_per_request(): void
    {
        $this->assertSame(5, Bootstrap::actionBatchSize('duplicate'));
        $this->assertSame(20, Bootstrap::actionBatchSize('trash'));
        $this->assertSame(Bootstrap::ACTION_BATCH_SIZE, Bootstrap::actionBatchSize('publish'));

        $sizes = Bootstrap::settings()['limits']['actionBatchSizes'];
        $this->assertSame(5, $sizes['duplicate']);
        $this->assertSame(Bootstrap::ACTION_BATCH_SIZE, $sizes['feature']);

        $response = $this->request('POST', '/wc-products-list/v1/actions/duplicate', ['ids' => range(1, 6)]);
        $this->assertStatus(400, $response);
        $data = $this->data($response);
        $this->assertSame('wc_products_list_too_many_ids', $data['code']);
        $this->assertSame(5, $data['data']['max']);

        add_filter(Bootstrap::FILTER_ACTION_BATCH_SIZE, static fn (int $size, string $action): int => $action === 'duplicate' ? 2 : $size, 10, 2);
        $this->assertSame(2, Bootstrap::actionBatchSize('duplicate'));
        $this->assertSame(400, $this->request('POST', '/wc-products-list/v1/actions/duplicate', ['ids' => [1, 2, 3]])->get_status());
    }

    public function test_trashing_a_variation_updates_the_parent_price_range(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        [$cheap, $dear] = $parent->get_children();

        $variation = wc_get_product($cheap);
        $variation->set_regular_price('5');
        $variation->save();
        $variation = wc_get_product($dear);
        $variation->set_regular_price('50');
        $variation->save();

        $parent = wc_get_product($parent->get_id());
        $this->assertEquals(5, (float) $parent->get_variation_price('min'));
        $this->assertCount(2, $parent->get_children());

        $this->act('trash', [$cheap]);

        $parent = wc_get_product($parent->get_id());
        $this->assertSame([$dear], array_map('intval', $parent->get_children()));
        $this->assertEquals(50, (float) $parent->get_variation_price('min'));
        $this->assertEquals(50, (float) $parent->get_variation_price('max'));
        $this->assertEquals(50, (float) get_post_meta($parent->get_id(), '_price', true));

        $this->act('restore', [$cheap]);

        $parent = wc_get_product($parent->get_id());
        $this->assertCount(2, $parent->get_children());
        $this->assertEquals(5, (float) $parent->get_variation_price('min'));
    }

    public function test_an_action_that_changes_nothing_logs_a_skipped_row(): void
    {
        $featured = $this->simpleProduct(['featured' => true]);
        $plain = $this->simpleProduct();

        $data = $this->act('feature', [$featured->get_id(), $plain->get_id()], ['featured' => true]);
        $this->assertSame([0, 1], array_column($data['results'], 'changed'));

        $rows = array_column($this->rows(), null, 'object_id');
        $this->assertSame('skipped', $rows[$featured->get_id()]['status']);
        $this->assertSame('unchanged', json_decode($rows[$featured->get_id()]['context'], true)['reason']);
        $this->assertSame('ok', $rows[$plain->get_id()]['status']);

        $batch = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0];
        $this->assertSame(1, $batch['rows']);
        $this->assertSame(1, $batch['skipped']);
        $this->assertSame(['unchanged'], $batch['skipped_reasons']);
        $this->assertSame('Mark as featured', $batch['summary']);

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $this->assertSame([], $plan['skipped']);
        $this->assertSame(['unchanged' => 1], $plan['left_out_reasons']);
    }

    public function test_batch_summaries_can_be_named_by_integrations(): void
    {
        $product = $this->simpleProduct();
        $this->act('trash', [$product->get_id()]);

        $this->assertSame('Move to Trash', $this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0]['summary']);

        add_filter('wc_products_list/log_batch_summary', static fn (?string $summary, ?string $action, array $args): ?string => $action === 'trash' ? 'Binned' : $summary, 10, 3);
        $this->assertSame('Binned', $this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0]['summary']);

        // A batch of field edits has none: History lists its fields.
        $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '1'], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertNull($this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0]['summary']);
    }
}
