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

    /** Chunks webpack loads on demand: their strings ride along with the app's translations. */
    public const LAZY_CHUNKS = ['build/edit.js', 'build/history.js'];

    private bool $mergingTranslations = false;

    public function register(): void
    {
        add_action('admin_menu', [$this, 'addMenu']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue']);
        add_filter('pre_load_script_translations', [$this, 'withChunkTranslations'], 10, 4);
    }

    /**
     * The lazy chunks (quick/bulk edit, History) are not script handles, so
     * WordPress never loads their JSON translation files (named after the
     * md5 of each chunk's path). Merge them into the app handle's
     * translations: the chunks share its `wp.i18n` text domain.
     *
     * @param  string|false|null  $translations
     * @param  string|false  $file
     * @return string|false|null
     */
    public function withChunkTranslations($translations, $file, string $handle, string $domain)
    {
        if ($translations !== null || $this->mergingTranslations || $handle !== Plugin::HANDLE || $domain !== Plugin::TEXT_DOMAIN || ! is_string($file) || $file === '') {
            return $translations;
        }

        $this->mergingTranslations = true;
        $index = load_script_translations($file, $handle, $domain);
        $this->mergingTranslations = false;

        $merged = is_string($index) ? json_decode($index, true) : null;
        $locale = determine_locale();
        $found = false;

        foreach (self::LAZY_CHUNKS as $chunk) {
            $chunkFile = dirname($file).'/'.$domain.'-'.$locale.'-'.md5($chunk).'.json';

            if (! is_readable($chunkFile)) {
                continue;
            }

            $data = json_decode((string) file_get_contents($chunkFile), true);
            $messages = is_array($data) ? ($data['locale_data']['messages'] ?? $data['locale_data'][$domain] ?? null) : null;

            if (! is_array($messages)) {
                continue;
            }

            if (! is_array($merged)) {
                $merged = $data;
                $merged['locale_data'] = ['messages' => $messages];
            } else {
                $key = isset($merged['locale_data']['messages']) ? 'messages' : $domain;
                $merged['locale_data'][$key] = array_merge($messages, (array) ($merged['locale_data'][$key] ?? []));
            }

            $found = true;
        }

        if (! $found) {
            return $index;
        }

        return (string) wp_json_encode($merged);
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

        // HEX flags as wp_localize_script() uses them: a `</script>` in a
        // term name or an extension's label cannot end the script block.
        wp_add_inline_script(
            Plugin::HANDLE,
            'window.wcProductsListSettings = '.wp_json_encode(Bootstrap::settings(), JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT).';',
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
