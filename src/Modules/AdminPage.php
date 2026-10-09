<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\ListMode;
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
            __('All Products (New)', 'wp-woocommerce-products-list'),
            __('All Products (New)', 'wp-woocommerce-products-list'),
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

    /** Shimmer rows the server-rendered skeleton shows until the app mounts. */
    public const SKELETON_ROWS = 10;

    /**
     * localStorage key under which the app remembers, per admin URL query
     * string, the GET paths of its first requests (list, counts). The
     * prefetch script starts them while the bundle downloads.
     */
    public const PREFETCH_STORAGE_KEY = 'wc-products-list:prefetch';

    /** The global the prefetch script fills: `{ [path]: Promise<{ok, status, headers, data}> }`. */
    public const PREFETCH_GLOBAL = 'wcProductsListPrefetch';

    /** Paths the prefetch script starts at most. */
    public const PREFETCH_MAX = 4;

    /**
     * The screen before the 2 MB bundle has run: the title, tab bar,
     * toolbar and grey rows (createRoot() replaces them when the app
     * mounts), and a small inline script that starts the list requests
     * the app made last time on this URL, so the first rows do not wait
     * for the bundle to download and parse.
     */
    public function render(): void
    {
        echo '<div class="wrap wc-products-list-wrap"><div id="'.esc_attr(self::ROOT_ID).'">';
        echo self::skeleton(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in skeleton()
        echo '</div></div>';
        echo self::prefetchScript(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- static script, JSON-encoded values
    }

    public static function skeleton(): string
    {
        $rows = '';

        for ($i = 0; $i < self::SKELETON_ROWS; $i++) {
            $rows .= '<div class="wc-pl-skeleton__row"><span class="wc-pl-skeleton__box"></span><span class="wc-pl-skeleton__bar" style="width:'.(28 + (($i * 17) % 30)).'%"></span><span class="wc-pl-skeleton__bar"></span><span class="wc-pl-skeleton__bar"></span></div>';
        }

        $style = '.wc-pl-skeleton__tabs,.wc-pl-skeleton__toolbar{display:flex;gap:16px;margin:12px 0}'
            .'.wc-pl-skeleton__tab{width:72px;height:16px}.wc-pl-skeleton__search{width:240px;height:32px}.wc-pl-skeleton__button{width:96px;height:32px}'
            .'.wc-pl-skeleton__table{background:#fff;border:1px solid #dcdcde}'
            .'.wc-pl-skeleton__row{display:flex;align-items:center;gap:24px;height:48px;padding:0 16px;border-top:1px solid #f0f0f1}'
            .'.wc-pl-skeleton__row:first-child{border-top:0}.wc-pl-skeleton__box{flex:none;width:32px;height:32px}'
            .'.wc-pl-skeleton__bar{display:block;flex:none;width:12%;height:12px}'
            .'.wc-pl-skeleton__tab,.wc-pl-skeleton__search,.wc-pl-skeleton__button,.wc-pl-skeleton__box,.wc-pl-skeleton__bar{border-radius:2px;background:linear-gradient(90deg,#f0f0f1 25%,#e6e6e8 50%,#f0f0f1 75%);background-size:200% 100%;animation:wc-pl-skeleton 1.4s ease-in-out infinite}'
            .'@keyframes wc-pl-skeleton{from{background-position:200% 0}to{background-position:-200% 0}}'
            .'@media (prefers-reduced-motion:reduce){.wc-pl-skeleton *{animation:none!important}}';

        return '<style>'.$style.'</style>'
            .'<div class="wc-pl-skeleton" aria-busy="true">'
            .'<h1 class="wp-heading-inline wc-products-list__title">'.esc_html__('All Products (New)', 'wp-woocommerce-products-list').'</h1>'
            .'<div class="wc-pl-skeleton__tabs" aria-hidden="true">'.str_repeat('<span class="wc-pl-skeleton__tab"></span>', 5).'</div>'
            .'<div class="wc-pl-skeleton__toolbar" aria-hidden="true"><span class="wc-pl-skeleton__search"></span><span class="wc-pl-skeleton__button"></span></div>'
            .'<div class="wc-pl-skeleton__table" aria-hidden="true">'.$rows.'</div>'
            .'<p class="screen-reader-text">'.esc_html__('Loading products…', 'wp-woocommerce-products-list').'</p>'
            .'</div>';
    }

    /**
     * The inline prefetch: reads the paths the app stored for this URL's
     * query string (`localStorage[PREFETCH_STORAGE_KEY][location.search]`,
     * GET paths under /wc/v3/ or /wc-products-list/v1/) and fetches them
     * with the REST nonce, the list-mode header and `_locale=user`, as
     * apiFetch would.
     * Nothing is fetched on a first visit, or when the app never stored
     * paths, so it never doubles a request the app does not reuse.
     */
    public static function prefetchScript(): string
    {
        $config = [
            'root' => esc_url_raw(rest_url()),
            'nonce' => wp_create_nonce('wp_rest'),
            'key' => self::PREFETCH_STORAGE_KEY,
            'global' => self::PREFETCH_GLOBAL,
            'max' => self::PREFETCH_MAX,
            'header' => ListMode::HEADER,
        ];

        $script = <<<'JS'
(function(c){try{var all=JSON.parse(window.localStorage.getItem(c.key)||'{}'),paths=all&&all[window.location.search];if(!Array.isArray(paths)){return;}var out=window[c.global]=window[c.global]||{};paths.slice(0,c.max).forEach(function(path){if(typeof path!=='string'||!/^\/(wc\/v3|wc-products-list\/v1)\//.test(path)||out[path]){return;}var full=/[?&]_locale=/.test(path)?path:path+(path.indexOf('?')>=0?'&':'?')+'_locale=user';var url=c.root.indexOf('?')>=0?c.root+full.replace('?','&'):c.root+full.replace(/^\//,'');var headers={'Accept':'application/json','X-WP-Nonce':c.nonce};headers[c.header]='1';out[path]=window.fetch(url,{credentials:'same-origin',headers:headers}).then(function(r){return r.json().then(function(data){return{ok:r.ok,status:r.status,headers:{total:r.headers.get('X-WP-Total'),totalPages:r.headers.get('X-WP-TotalPages')},data:data};});});out[path].catch(function(){});});}catch(e){}})(%s);
JS;

        return '<script>'.sprintf($script, (string) wp_json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES)).'</script>';
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
