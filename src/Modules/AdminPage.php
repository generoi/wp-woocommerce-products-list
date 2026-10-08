<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\Module;
use GeneroWP\ProductsList\Plugin;

/**
 * Products → Catalog: the screen the app mounts on. One script, one style,
 * one inline settings object; nothing is enqueued anywhere else.
 */
class AdminPage implements Module
{
    /** The `$hook_suffix` WordPress gives the screen. */
    public const SCREEN = 'product_page_'.Plugin::PAGE;

    public const ROOT_ID = 'wc-products-list-root';

    /** Fired after the app script is enqueued so extensions can add theirs. */
    public const ACTION_ENQUEUE = 'wc_products_list/enqueue';

    public function register(): void
    {
        add_action('admin_menu', [$this, 'addMenu']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue']);
    }

    public function addMenu(): void
    {
        add_submenu_page(
            'edit.php?post_type=product',
            __('Catalog', 'wp-woocommerce-products-list'),
            __('Catalog', 'wp-woocommerce-products-list'),
            Plugin::capability(),
            Plugin::PAGE,
            [$this, 'render'],
            1
        );
    }

    public static function isScreen(?string $hookSuffix = null): bool
    {
        $hookSuffix ??= $GLOBALS['hook_suffix'] ?? null;

        return $hookSuffix === self::SCREEN;
    }

    public function render(): void
    {
        echo '<div class="wrap wc-products-list-wrap"><div id="'.esc_attr(self::ROOT_ID).'"></div></div>';
    }

    public function enqueue(string $hookSuffix): void
    {
        if (! self::isScreen($hookSuffix)) {
            return;
        }

        $asset = $this->asset();

        wp_register_script(
            Plugin::HANDLE,
            Plugin::url('build/index.js'),
            array_values(array_unique(array_merge($asset['dependencies'], ['wp-api-fetch', 'wp-dom-ready']))),
            $asset['version'],
            ['in_footer' => true]
        );

        wp_set_script_translations(Plugin::HANDLE, Plugin::TEXT_DOMAIN, Plugin::path('languages'));

        wp_add_inline_script(
            Plugin::HANDLE,
            'window.wcProductsListSettings = '.wp_json_encode(Bootstrap::settings()).';',
            'before'
        );

        wp_enqueue_script(Plugin::HANDLE);

        // DataViews' stylesheet reads the --wpds-* design tokens that core's
        // wp-components stylesheet defines, so it has to come after it.
        wp_enqueue_style(
            Plugin::HANDLE,
            Plugin::url('build/style-index.css'),
            ['wp-components'],
            $asset['version']
        );

        /**
         * Fires after the app script is enqueued. Enqueue extension scripts
         * here with the handle as a dependency; they run before the app
         * mounts and may call `window.wcProductsList` once `ready` fires.
         *
         * @param  string  $handle  The app's script handle, `wc-products-list`.
         */
        do_action(self::ACTION_ENQUEUE, Plugin::HANDLE);
    }

    /**
     * @return array{dependencies: array<int, string>, version: string}
     */
    private function asset(): array
    {
        $file = Plugin::path('build/index.asset.php');
        $asset = is_file($file) ? include $file : [];

        return [
            'dependencies' => is_array($asset['dependencies'] ?? null) ? $asset['dependencies'] : [],
            'version' => (string) ($asset['version'] ?? WC_PRODUCTS_LIST_VERSION),
        ];
    }
}
