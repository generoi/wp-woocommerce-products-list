<?php

namespace GeneroWP\ProductsList;

use Automattic\WooCommerce\Utilities\FeaturesUtil;
use GeneroWP\ProductsList\Modules\Actions;
use GeneroWP\ProductsList\Modules\AdminPage;
use GeneroWP\ProductsList\Modules\LegacyRedirect;
use GeneroWP\ProductsList\Modules\Log;
use GeneroWP\ProductsList\Modules\Rest;

class Plugin
{
    /**
     * Rest first: it owns the list-mode plumbing every other module reads.
     *
     * @var class-string<Module>[]
     */
    public const MODULES = [
        Rest::class,
        AdminPage::class,
        Log::class,
        Actions::class,
        LegacyRedirect::class,
    ];

    public const FILTER_MODULES = 'wc_products_list/modules';

    /** Fired once on activation, and from the test bootstrap, after the modules are registered. */
    public const ACTION_ACTIVATE = 'wc_products_list/activate';

    public const TEXT_DOMAIN = 'wp-woocommerce-products-list';

    /** The script and style handle of the admin app. Extensions depend on it. */
    public const HANDLE = 'wc-products-list';

    /** The admin page slug under `edit.php?post_type=product`. */
    public const PAGE = 'wc-products-list';

    /** Own REST namespace for counts, actions, terms and the log. */
    public const REST_NAMESPACE = 'wc-products-list/v1';

    protected static ?self $instance = null;

    protected bool $booted = false;

    /** @var array<class-string<Module>, Module> */
    protected array $modules = [];

    public static function getInstance(): self
    {
        return self::$instance ??= new self;
    }

    public function __construct()
    {
        add_action('before_woocommerce_init', [$this, 'declareCompatibility']);

        // plugins_loaded rather than construction: WooCommerce may load after
        // this file, and the modules filter has to be reachable from a site's
        // own plugins.
        add_action('plugins_loaded', [$this, 'boot']);
    }

    /**
     * The plugin never touches orders and the admin app is a plain screen.
     */
    public function declareCompatibility(): void
    {
        if (! class_exists(FeaturesUtil::class)) {
            return;
        }

        FeaturesUtil::declare_compatibility('custom_order_tables', WC_PRODUCTS_LIST_FILE, true);
        FeaturesUtil::declare_compatibility('cart_checkout_blocks', WC_PRODUCTS_LIST_FILE, true);
    }

    public function boot(): void
    {
        if ($this->booted || ! class_exists(\WooCommerce::class)) {
            return;
        }

        $this->booted = true;

        // The translations that ship with the plugin. Ones installed under
        // wp-content/languages/plugins take precedence, as for any plugin.
        add_action('init', static function (): void {
            load_plugin_textdomain(self::TEXT_DOMAIN, false, dirname(plugin_basename(WC_PRODUCTS_LIST_FILE)).'/languages');
        }, 0);

        // List mode is not a module: every module may read it, and an
        // integration that drops a module must still see the header.
        ListMode::register();

        /**
         * Filters the modules that will be registered.
         *
         * @param  class-string<Module>[]  $modules
         */
        $modules = apply_filters(self::FILTER_MODULES, self::MODULES);

        foreach ($modules as $module) {
            if (! is_subclass_of($module, Module::class)) {
                continue;
            }

            $this->modules[$module] = new $module;
            $this->modules[$module]->register();
        }
    }

    /**
     * Activation hook. The plugin file is included after `plugins_loaded`
     * when activating, so the modules are booted here before the install
     * action fires; modules that own tables listen to it.
     */
    public static function activate(): void
    {
        self::getInstance()->boot();

        do_action(self::ACTION_ACTIVATE);
    }

    /**
     * @template T of Module
     *
     * @param  class-string<T>  $class
     * @return T|null
     */
    public function module(string $class): ?Module
    {
        return $this->modules[$class] ?? null;
    }

    public static function url(string $path = ''): string
    {
        return plugins_url($path, WC_PRODUCTS_LIST_FILE);
    }

    public static function path(string $path = ''): string
    {
        return WC_PRODUCTS_LIST_PATH.'/'.ltrim($path, '/');
    }

    /**
     * Who may use the list. Defaults to WooCommerce's own product editing
     * capability, so shop managers and administrators both see it.
     */
    public static function capability(): string
    {
        /**
         * Filters the capability required to see and use the Catalog screen.
         *
         * @param  string  $capability
         */
        return (string) apply_filters('wc_products_list/capability', 'edit_products');
    }
}
