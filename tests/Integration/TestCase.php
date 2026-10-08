<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use WC_Product_Simple;
use WC_Product_Variable;
use WC_Product_Variation;
use WP_UnitTestCase;

/**
 * Every test runs in a database transaction that is rolled back, so
 * products, terms and log rows never leak from one test into the next.
 */
abstract class TestCase extends WP_UnitTestCase
{
    /** @var array<string, int> */
    private static array $users = [];

    public function set_up(): void
    {
        parent::set_up();

        ListMode::force(null);
        ListMode::reset();
        $this->actAs('administrator');
    }

    public function tear_down(): void
    {
        ListMode::force(null);
        wp_set_current_user(0);

        parent::tear_down();
    }

    /**
     * Become a user with the given role ('administrator', 'shop_manager',
     * 'editor', 'subscriber', ...), 'guest' for nobody. One user per role is
     * created on demand and reused within the test.
     */
    protected function actAs(string $role): int
    {
        if ($role === 'guest' || $role === '') {
            wp_set_current_user(0);

            return 0;
        }

        $key = $role.':'.spl_object_id($this);

        if (! isset(self::$users[$key])) {
            self::$users[$key] = self::factory()->user->create(['role' => $role]);
        }

        wp_set_current_user(self::$users[$key]);

        return self::$users[$key];
    }

    /**
     * @param  array<string, mixed>  $props  setters without `set_`, e.g. ['sku' => 'A1', 'regular_price' => '10']
     */
    protected function simpleProduct(array $props = []): WC_Product_Simple
    {
        $product = new WC_Product_Simple;
        $product->set_name('Saga wide toe boot');
        $product->set_regular_price('189');
        $product->set_status('publish');

        $this->apply($product, $props);
        $product->save();

        return $product;
    }

    /**
     * A variable product with one attribute (size) and one variation per
     * given size, each priced.
     *
     * @param  array<int, string>  $sizes
     * @param  array<string, mixed>  $props
     */
    protected function variableProduct(array $sizes = ['38', '39', '40'], array $props = []): WC_Product_Variable
    {
        $product = new WC_Product_Variable;
        $product->set_name('Saga wide toe boot');
        $product->set_status('publish');

        $attribute = new \WC_Product_Attribute;
        $attribute->set_name('size');
        $attribute->set_options($sizes);
        $attribute->set_visible(true);
        $attribute->set_variation(true);
        $product->set_attributes([$attribute]);

        $this->apply($product, $props);
        $product->save();

        foreach ($sizes as $size) {
            $variation = new WC_Product_Variation;
            $variation->set_parent_id($product->get_id());
            $variation->set_attributes(['size' => $size]);
            $variation->set_regular_price('189');
            $variation->set_status('publish');
            $variation->save();
        }

        return wc_get_product($product->get_id());
    }

    /**
     * @param  array<string, mixed>  $props
     */
    private function apply(\WC_Product $product, array $props): void
    {
        foreach ($props as $prop => $value) {
            $product->{'set_'.$prop}($value);
        }
    }
}
