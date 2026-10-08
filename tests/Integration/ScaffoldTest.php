<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Modules\AdminPage;
use GeneroWP\ProductsList\Plugin;

class ScaffoldTest extends RestTestCase
{
    public function test_modules_are_booted(): void
    {
        $this->assertInstanceOf(AdminPage::class, Plugin::getInstance()->module(AdminPage::class));
    }

    public function test_catalog_submenu_is_registered_for_shop_managers(): void
    {
        require_once ABSPATH.'wp-admin/includes/plugin.php';

        $this->actAs('shop_manager');
        $GLOBALS['menu'] = [];
        $GLOBALS['submenu'] = [];

        Plugin::getInstance()->module(AdminPage::class)->addMenu();

        $pages = array_column($GLOBALS['submenu']['edit.php?post_type=product'] ?? [], 2);

        $this->assertContains(Plugin::PAGE, $pages);

        $this->actAs('subscriber');
        $GLOBALS['submenu'] = [];

        Plugin::getInstance()->module(AdminPage::class)->addMenu();

        $this->assertSame([], $GLOBALS['submenu']);
    }

    public function test_bootstrap_payload_has_the_contract_keys(): void
    {
        $settings = Bootstrap::settings();

        foreach (['version', 'currency', 'units', 'caps', 'statuses', 'productTypes', 'stockStatuses', 'catalogVisibility', 'taxClasses', 'shippingClasses', 'taxonomies', 'features', 'limits', 'links', 'fields', 'filters', 'actions', 'languages'] as $key) {
            $this->assertArrayHasKey($key, $settings);
        }

        $this->assertSame([], $settings['fields']);
        $this->assertNull($settings['languages']);
        $this->assertSame(100, $settings['limits']['perPageMax']);
        $this->assertTrue($settings['caps']['edit']);
        $this->assertContains('product_cat', array_column($settings['taxonomies'], 'name'));
    }

    public function test_list_mode_follows_the_header(): void
    {
        $product = $this->simpleProduct(['sku' => 'SCAFFOLD-1']);
        $seen = [];

        add_filter('rest_request_after_callbacks', function ($response) use (&$seen) {
            $seen[] = [ListMode::active(), ListMode::batchId()];

            return $response;
        });

        $response = $this->request('GET', '/wc/v3/products', ['include' => [$product->get_id()], '_fields' => 'id,sku']);
        $this->assertStatus(200, $response);
        $this->assertSame('SCAFFOLD-1', $this->data($response)[0]['sku']);

        $response = $this->request('GET', '/wc/v3/products', ['include' => [$product->get_id()]], [ListMode::HEADER => '']);
        $this->assertStatus(200, $response);

        $response = $this->request('POST', '/wc/v3/products/'.$product->get_id(), ['sku' => 'SCAFFOLD-2']);
        $this->assertStatus(200, $response);

        $this->assertSame([true, null], $seen[0]);
        $this->assertSame([false, null], $seen[1]);
        $this->assertSame([true, $this->batchId()], $seen[2]);
        $this->assertSame('SCAFFOLD-2', wc_get_product($product->get_id())->get_sku());
    }
}
