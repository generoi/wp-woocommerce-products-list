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

    /**
     * The settings are printed inline; a `</script>` in a term name or an
     * extension's label must not end the script block.
     */
    public function test_inline_settings_cannot_close_the_script_tag(): void
    {
        add_filter(Bootstrap::FILTER, static function (array $settings): array {
            $settings['fields'][] = ['id' => 'ext:evil', 'label' => '</script><script>alert(1)</script>&amp;\'"'];

            return $settings;
        });

        $GLOBALS['wp_scripts'] = null;
        Plugin::getInstance()->module(AdminPage::class)->enqueue(AdminPage::SCREEN);

        $inline = wp_scripts()->get_inline_script_data(Plugin::HANDLE, 'before');
        $this->assertStringStartsWith('window.wcProductsListSettings = {', $inline);
        $this->assertStringNotContainsString('</script', $inline);
        $this->assertStringNotContainsString('<script', $inline);
        $this->assertStringContainsString('\\u003C\\/script\\u003E', $inline);

        $json = substr($inline, strlen('window.wcProductsListSettings = '));
        $decoded = json_decode(substr($json, 0, strrpos($json, '};') + 1), true);
        $this->assertIsArray($decoded);
        $this->assertSame('</script><script>alert(1)</script>&amp;\'"', end($decoded['fields'])['label']);

        $GLOBALS['wp_scripts'] = null;
    }

    public function test_lazy_chunk_translations_are_merged_into_the_app_translations(): void
    {
        $dir = get_temp_dir().'wc-pl-l10n-'.wp_generate_password(6, false);
        wp_mkdir_p($dir);
        $locale = determine_locale();
        $domain = Plugin::TEXT_DOMAIN;
        $json = static fn (array $messages): string => (string) wp_json_encode(['domain' => 'messages', 'locale_data' => ['messages' => ['' => ['domain' => 'messages']] + $messages]]);
        $index = $dir.'/'.$domain.'-'.$locale.'-'.md5('build/index.js').'.json';
        file_put_contents($index, $json(['Catalog' => ['Katalog']]));
        file_put_contents($dir.'/'.$domain.'-'.$locale.'-'.md5('build/edit.js').'.json', $json(['Update' => ['Uppdatera']]));
        file_put_contents($dir.'/'.$domain.'-'.$locale.'-'.md5('build/history.js').'.json', $json(['Revert batch' => ['Återställ']]));

        $loaded = json_decode((string) load_script_translations($index, Plugin::HANDLE, $domain), true);
        $messages = $loaded['locale_data']['messages'];

        $this->assertSame(['Katalog'], $messages['Catalog']);
        $this->assertSame(['Uppdatera'], $messages['Update']);
        $this->assertSame(['Återställ'], $messages['Revert batch']);

        // Other handles are left alone.
        $this->assertSame(['Katalog'], json_decode((string) load_script_translations($index, 'other', $domain), true)['locale_data']['messages']['Catalog']);
        $this->assertArrayNotHasKey('Update', json_decode((string) load_script_translations($index, 'other', $domain), true)['locale_data']['messages']);

        array_map('unlink', glob($dir.'/*.json') ?: []);
        rmdir($dir);
    }

    public function test_the_screen_renders_a_skeleton_and_the_prefetch_script(): void
    {
        $this->actAs('administrator');

        ob_start();
        Plugin::getInstance()->module(AdminPage::class)->render();
        $html = (string) ob_get_clean();

        $this->assertStringContainsString('<div id="'.AdminPage::ROOT_ID.'"><style>', $html);
        $this->assertStringContainsString('<h1 class="wp-heading-inline wc-products-list__title">All Products (New)</h1>', $html);
        $this->assertSame(AdminPage::SKELETON_ROWS, substr_count($html, 'class="wc-pl-skeleton__row"'));

        // The prefetch script comes after the root (createRoot() replaces the skeleton, not the script).
        $script = substr($html, (int) strpos($html, '<script>'));
        $this->assertStringContainsString(wp_create_nonce('wp_rest'), $script);
        $this->assertStringContainsString('"key":"'.AdminPage::PREFETCH_STORAGE_KEY.'"', $script);
        $this->assertStringContainsString('"global":"'.AdminPage::PREFETCH_GLOBAL.'"', $script);
        $this->assertStringContainsString('"header":"X-WC-Products-List"', $script);
        $this->assertStringNotContainsString('</script><', substr($script, 0, -9));
    }
}
