<?php

namespace GeneroWP\ProductsList;

use Automattic\WooCommerce\Internal\CostOfGoodsSold\CostOfGoodsSoldController;
use WC_Tax;

/**
 * The settings payload the admin app boots from, printed inline as
 * `window.wcProductsListSettings` on the Catalog screen only.
 *
 * Everything the app needs to render a first page without a round trip, and
 * nothing per product: the lists here are the small, stable option sets.
 */
final class Bootstrap
{
    public const FILTER = 'wc_products_list/bootstrap';

    public const FILTER_ALLOW_HARD_DELETE = 'wc_products_list/allow_hard_delete';

    public const PER_PAGE_MAX = 100;

    public const MAX_CHILDREN_PER_PARENT = 1000;

    public const BATCH_SIZE = 50;

    public const ACTION_BATCH_SIZE = 100;

    /**
     * @return array<string, mixed>
     */
    public static function settings(): array
    {
        $user = wp_get_current_user();

        $settings = [
            'version' => WC_PRODUCTS_LIST_VERSION,
            'locale' => get_user_locale(),
            'currency' => self::currency(),
            'units' => [
                'weight' => (string) get_option('woocommerce_weight_unit', 'kg'),
                'dimension' => (string) get_option('woocommerce_dimension_unit', 'cm'),
            ],
            'dateFormat' => (string) get_option('date_format', 'Y-m-d'),
            'timeFormat' => (string) get_option('time_format', 'H:i'),
            'timezone' => wp_timezone_string(),
            'user' => [
                'id' => (int) $user->ID,
                'name' => (string) $user->display_name,
            ],
            'caps' => self::caps(),
            'statuses' => self::statuses(),
            'productTypes' => self::labelled(wc_get_product_types()),
            'stockStatuses' => self::labelled(wc_get_product_stock_status_options()),
            'catalogVisibility' => self::labelled(wc_get_product_visibility_options()),
            'backorders' => self::labelled([
                'no' => __('Do not allow', 'woocommerce'),
                'notify' => __('Allow, but notify customer', 'woocommerce'),
                'yes' => __('Allow', 'woocommerce'),
            ]),
            'taxStatuses' => self::labelled([
                'taxable' => __('Taxable', 'woocommerce'),
                'shipping' => __('Shipping only', 'woocommerce'),
                'none' => _x('None', 'Tax status', 'woocommerce'),
            ]),
            'taxClasses' => self::taxClasses(),
            'shippingClasses' => self::shippingClasses(),
            'taxonomies' => self::taxonomies(),
            'features' => [
                'cogs' => self::cogsEnabled(),
                'brands' => taxonomy_exists('product_brand'),
                'reviews' => get_option('woocommerce_enable_reviews', 'yes') === 'yes',
                /**
                 * Filters whether "Delete permanently" is offered on rows
                 * outside the Trash. Off by default, as in the classic list.
                 *
                 * @param  bool  $allow
                 */
                'hardDelete' => (bool) apply_filters(self::FILTER_ALLOW_HARD_DELETE, false),
            ],
            'limits' => [
                'perPageMax' => self::PER_PAGE_MAX,
                'maxChildrenPerParent' => self::MAX_CHILDREN_PER_PARENT,
                'batchSize' => self::BATCH_SIZE,
                'actionBatchSize' => self::ACTION_BATCH_SIZE,
            ],
            'links' => self::links(),
            'fields' => Registry::fields(),
            'filters' => Registry::filters(),
            'actions' => Registry::actions(),
            // Set by gds-woo-i18n (or any translation integration) through
            // the bootstrap filter: {default, others, labels, currencies}.
            'languages' => null,
        ];

        /**
         * Filters the settings payload printed for the admin app.
         *
         * @param  array<string, mixed>  $settings
         */
        return apply_filters(self::FILTER, $settings);
    }

    /**
     * @return array<string, mixed>
     */
    private static function currency(): array
    {
        $code = get_woocommerce_currency();

        return [
            'code' => $code,
            'symbol' => html_entity_decode(get_woocommerce_currency_symbol($code), ENT_QUOTES, 'UTF-8'),
            'position' => (string) get_option('woocommerce_currency_pos', 'left'),
            'decimals' => wc_get_price_decimals(),
            'decimalSeparator' => wc_get_price_decimal_separator(),
            'thousandSeparator' => wc_get_price_thousand_separator(),
        ];
    }

    /**
     * @return array<string, bool>
     */
    private static function caps(): array
    {
        return [
            'edit' => current_user_can('edit_products'),
            'editOthers' => current_user_can('edit_others_products'),
            'publish' => current_user_can('publish_products'),
            'delete' => current_user_can('delete_products'),
            'deleteOthers' => current_user_can('delete_others_products'),
            'manageWoocommerce' => current_user_can('manage_woocommerce'),
            'manageTerms' => current_user_can('manage_product_terms'),
        ];
    }

    /**
     * @return array<int, array{value: string, label: string}>
     */
    private static function statuses(): array
    {
        return self::labelled([
            'publish' => __('Published', 'woocommerce'),
            'future' => __('Scheduled', 'woocommerce'),
            'draft' => __('Draft', 'woocommerce'),
            'pending' => __('Pending', 'woocommerce'),
            'private' => __('Private', 'woocommerce'),
            'trash' => __('Trash', 'woocommerce'),
        ]);
    }

    /**
     * @return array<int, array{value: string, label: string}>
     */
    private static function taxClasses(): array
    {
        $classes = [['value' => '', 'label' => __('Standard', 'woocommerce')]];

        foreach (WC_Tax::get_tax_class_slugs() as $index => $slug) {
            $classes[] = ['value' => (string) $slug, 'label' => (string) (WC_Tax::get_tax_classes()[$index] ?? $slug)];
        }

        return $classes;
    }

    /**
     * @return array<int, array{id: int, value: string, label: string}>
     */
    private static function shippingClasses(): array
    {
        $terms = get_terms(['taxonomy' => 'product_shipping_class', 'hide_empty' => false]);

        if (! is_array($terms)) {
            return [];
        }

        return array_values(array_map(static fn (\WP_Term $term): array => [
            'id' => (int) $term->term_id,
            'value' => (string) $term->slug,
            'label' => (string) $term->name,
        ], $terms));
    }

    /**
     * The taxonomies the app can filter by and edit as token fields. The
     * terms themselves are fetched lazily from /terms/{taxonomy}.
     *
     * @return array<int, array{name: string, label: string, restKey: string, hierarchical: bool, attribute: bool}>
     */
    private static function taxonomies(): array
    {
        $taxonomies = [
            ['name' => 'product_cat', 'label' => __('Categories', 'woocommerce'), 'restKey' => 'categories', 'hierarchical' => true, 'attribute' => false],
            ['name' => 'product_tag', 'label' => __('Tags', 'woocommerce'), 'restKey' => 'tags', 'hierarchical' => false, 'attribute' => false],
            ['name' => 'product_shipping_class', 'label' => __('Shipping class', 'woocommerce'), 'restKey' => 'shipping_class', 'hierarchical' => false, 'attribute' => false],
        ];

        if (taxonomy_exists('product_brand')) {
            $taxonomies[] = ['name' => 'product_brand', 'label' => __('Brands', 'woocommerce'), 'restKey' => 'brands', 'hierarchical' => true, 'attribute' => false];
        }

        foreach (wc_get_attribute_taxonomies() as $attribute) {
            $taxonomies[] = [
                'name' => wc_attribute_taxonomy_name($attribute->attribute_name),
                'label' => (string) $attribute->attribute_label,
                'restKey' => 'attributes',
                'hierarchical' => false,
                'attribute' => true,
            ];
        }

        return $taxonomies;
    }

    /**
     * @return array<string, string>
     */
    private static function links(): array
    {
        return [
            'admin' => admin_url(),
            'rest' => rest_url(),
            'page' => admin_url('edit.php?post_type=product&page='.Plugin::PAGE),
            'history' => admin_url('edit.php?post_type=product&page='.Plugin::PAGE.'&screen=history'),
            'legacyList' => admin_url('edit.php?post_type=product&legacy=1'),
            'newProduct' => admin_url('post-new.php?post_type=product'),
            // sprintf-style: %d is the product id.
            'editProduct' => admin_url('post.php?post=%d&action=edit'),
            'assets' => Plugin::url('build/'),
        ];
    }

    private static function cogsEnabled(): bool
    {
        if (! class_exists(CostOfGoodsSoldController::class) || ! function_exists('wc_get_container')) {
            return false;
        }

        try {
            return (bool) wc_get_container()->get(CostOfGoodsSoldController::class)->feature_is_enabled();
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * @param  array<string, string>  $map
     * @return array<int, array{value: string, label: string}>
     */
    private static function labelled(array $map): array
    {
        $list = [];

        foreach ($map as $value => $label) {
            $list[] = ['value' => (string) $value, 'label' => (string) $label];
        }

        return $list;
    }
}
