<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Modules\Rest;
use GeneroWP\ProductsList\Plugin;
use GeneroWP\ProductsList\Registry;

class BootstrapTest extends RestTestCase
{
    public function set_up(): void
    {
        parent::set_up();

        Registry::reset();
    }

    public function tear_down(): void
    {
        Registry::reset();

        parent::tear_down();
    }

    public function test_declarative_definitions_are_serialised_into_the_settings(): void
    {
        add_filter(Registry::FILTER_FIELDS, static fn (array $fields): array => $fields + [
            'i18n:se.name' => ['label' => 'Name (Svenska)', 'path' => 'i18n.se.name.value', 'writePath' => 'i18n.se.name', 'reference' => 'name', 'group' => 'i18n:se', 'visible' => true, 'order' => 10],
            ['id' => 'i18n:se.sale_price', 'type' => 'price', 'path' => 'i18n.se.sale_price.value', 'writePath' => 'i18n.se.sale_price', 'applies' => ['product' => ['simple', 'external'], 'variation' => true], 'order' => 20],
            ['id' => 'Broken Id'],
        ]);
        add_filter(Registry::FILTER_FILTERS, static fn (array $filters): array => $filters + [
            'translation' => ['label' => 'Translation', 'options' => [['value' => 'missing:se', 'label' => 'Missing in Svenska', 'params' => ['gds_i18n[lang]' => 'se', 'gds_i18n[status]' => 'missing']]], 'isPrimary' => true],
        ]);
        add_filter(Registry::FILTER_ACTIONS, static fn (array $actions): array => $actions + [
            'i18n_copy' => ['label' => 'Copy default language', 'scope' => 'both', 'args' => ['lang' => ['type' => 'select', 'required' => true, 'options' => ['se' => 'Svenska']]]],
        ]);

        $settings = Bootstrap::settings();

        $this->assertSame(['i18n:se.name', 'i18n:se.sale_price'], array_column($settings['fields'], 'id'));
        $this->assertSame('i18n', $settings['fields'][0]['writeKey']);
        $this->assertSame('i18n:se', $settings['fields'][0]['tab']);
        $this->assertTrue($settings['fields'][0]['visible']);
        $this->assertSame('money', $settings['fields'][1]['bulk']);
        $this->assertSame(['product' => ['simple', 'external'], 'variation' => true], $settings['fields'][1]['applies']);

        $this->assertSame('translation', $settings['filters'][0]['id']);
        $this->assertSame(['gds_i18n[lang]' => 'se', 'gds_i18n[status]' => 'missing'], $settings['filters'][0]['options'][0]['params']);

        $this->assertSame('i18n_copy', $settings['actions'][0]['id']);
        $this->assertSame('both', $settings['actions'][0]['scope']);
        $this->assertSame('lang', $settings['actions'][0]['args'][0]['id']);

        $this->assertSame(['i18n'], Registry::writeKeys());
        $this->assertSame('i18n:se.sale_price', Registry::field('i18n:se.sale_price')['id']);
        $this->assertNull(Registry::field('nope'));
        $this->assertCount(2, Registry::fieldsByWriteKey('i18n'));

        // The payload is JSON for the inline script.
        $this->assertIsString(wp_json_encode($settings));
        $this->assertNull($settings['languages']);
    }

    public function test_definitions_are_collected_once_until_reset(): void
    {
        $calls = 0;

        add_filter(Registry::FILTER_FIELDS, static function (array $fields) use (&$calls): array {
            $calls++;

            return $fields + ['x' => ['label' => 'X']];
        });

        Registry::fields();
        Registry::writeKeys();
        Bootstrap::settings();
        $this->assertSame(1, $calls);

        Registry::reset();
        Registry::fields();
        $this->assertSame(2, $calls);
    }

    public function test_bootstrap_filter_sets_languages(): void
    {
        add_filter(Bootstrap::FILTER, static function (array $settings): array {
            $settings['languages'] = ['default' => 'fi', 'others' => ['se', 'en'], 'labels' => ['fi' => 'Suomi', 'se' => 'Svenska', 'en' => 'English']];

            return $settings;
        });

        $settings = Bootstrap::settings();

        $this->assertSame('fi', $settings['languages']['default']);
        $this->assertSame(['se', 'en'], $settings['languages']['others']);
        $this->assertSame(100, $settings['limits']['perPageMax']);
        $this->assertSame(50, $settings['limits']['batchSize']);
        $this->assertSame(100, $settings['limits']['actionBatchSize']);
        $this->assertSame(Plugin::capability(), 'edit_products');
        $this->assertStringContainsString('page='.Plugin::PAGE, $settings['links']['page']);
    }

    public function test_rest_module_registers_the_read_routes(): void
    {
        $module = Plugin::getInstance()->module(Rest::class);
        $this->assertInstanceOf(Rest::class, $module);

        $routes = $this->server->get_routes(Plugin::REST_NAMESPACE);
        $this->assertArrayHasKey('/wc-products-list/v1/counts', $routes);
        $this->assertArrayHasKey('/wc-products-list/v1/terms/(?P<taxonomy>[a-z0-9_-]+)', $routes);

        // The list parameters are declared on wc/v3 products.
        $products = $this->server->get_routes('wc/v3')['/wc/v3/products'][0];
        $this->assertContains('sku', $products['args']['orderby']['enum']);
        $this->assertContains('stock_quantity', $products['args']['orderby']['enum']);
        $this->assertContains('menu_order', $products['args']['orderby']['enum']);
        $this->assertArrayHasKey('tab', $products['args']);
        $this->assertArrayHasKey('has_variations', $products['args']);

        $variations = $this->server->get_routes('wc/v3')['/wc/v3/products/(?P<product_id>[\d]+)/variations'][0];
        $this->assertContains('menu_order', $variations['args']['orderby']['enum']);
    }

    public function test_rest_response_cache_key_varies_on_list_mode(): void
    {
        $plain = new \WP_REST_Request('GET', '/wc/v3/products');
        $this->assertSame(['route'], apply_filters('woocommerce_rest_api_cache_key_info', ['route'], $plain, false, null));

        $list = new \WP_REST_Request('GET', '/wc/v3/products');
        $list->set_header(ListMode::HEADER, '1');
        $this->assertSame(
            ['route', ListMode::CACHE_KEY_PART, 'user_'.get_current_user_id()],
            apply_filters('woocommerce_rest_api_cache_key_info', ['route'], $list, false, null)
        );

        $this->assertSame('x', apply_filters('woocommerce_rest_api_cache_key_info', 'x', $list, false, null));
    }

    public function test_source_header(): void
    {
        $seen = [];

        add_filter('rest_request_after_callbacks', function ($response) use (&$seen) {
            $seen[] = ListMode::source();

            return $response;
        });

        $this->request('GET', '/wc-products-list/v1/counts');
        $this->request('GET', '/wc-products-list/v1/counts', [], [ListMode::SOURCE_HEADER => 'bulk']);
        $this->request('GET', '/wc-products-list/v1/counts', [], [ListMode::SOURCE_HEADER => 'rocket']);

        $this->assertSame(['quick', 'bulk', 'quick'], $seen);
    }
}
