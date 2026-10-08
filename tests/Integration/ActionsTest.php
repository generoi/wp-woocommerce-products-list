<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Actions\Action;
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

    public function test_delete_is_permanent_and_takes_variations_along(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        $children = $parent->get_children();
        $gone = $parent->get_id() + 100000;

        $data = $this->act('delete', [$parent->get_id(), $gone]);

        $this->assertTrue($data['results'][0]['ok']);
        $this->assertFalse($data['results'][1]['ok']);
        $this->assertSame('not_found', $data['results'][1]['code']);
        $this->assertNull(get_post($parent->get_id()));
        $this->assertNull(get_post($children[0]));
        $this->assertSame([], $data['items']);

        $rows = $this->rows();
        $this->assertCount(2, $rows);
        $this->assertSame(['delete', 'status', 'publish', null, 'ok'], [$rows[0]['action'], $rows[0]['field'], $rows[0]['old_value'], $rows[0]['new_value'], $rows[0]['status']]);
        $this->assertSame(['error', $gone], [$rows[1]['status'], (int) $rows[1]['object_id']]);
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

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame(['duplicate', '', 'ok'], [$rows[0]['action'], $rows[0]['field'], $rows[0]['status']]);

        // Variations are not duplicated on their own.
        $parent = $this->variableProduct(['38']);
        $data = $this->act('duplicate', [$parent->get_children()[0]]);
        $this->assertSame('not_applicable', $data['results'][0]['code']);
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
}
