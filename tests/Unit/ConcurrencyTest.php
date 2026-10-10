<?php

namespace GeneroWP\ProductsList\Tests\Unit;

use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Rest\Concurrency;
use GeneroWP\ProductsList\Rest\LogController;
use PHPUnit\Framework\TestCase;

/**
 * The pure parts of the concurrency checks and of the logging of
 * WooCommerce's side effects.
 */
class ConcurrencyTest extends TestCase
{
    public function test_expected_values_compare_the_way_the_editor_loaded_them(): void
    {
        $this->assertTrue(Concurrency::same('15', '15'));
        $this->assertTrue(Concurrency::same(null, ''));
        $this->assertTrue(Concurrency::same('15', '15.00'));
        $this->assertTrue(Concurrency::same('[{"id":3,"name":"Boots"},{"id":1}]', '[{"id":1},{"id":3}]'));
        $this->assertTrue(Concurrency::same('[]', '[]'));

        $this->assertFalse(Concurrency::same('15', '10'));
        $this->assertFalse(Concurrency::same('', '0'));
        $this->assertFalse(Concurrency::same('[{"id":3}]', '[{"id":4}]'));
        $this->assertFalse(Concurrency::same('Saga', 'saga'));
        $this->assertFalse(Concurrency::same('true', 'false'));
    }

    public function test_a_stale_refresh_reapplies_every_prop_the_request_names(): void
    {
        $data = ['manage_stock' => false, 'regular_price' => '11', 'stock_quantity' => 4, 'category_ids' => [3], 'image_id' => 0, 'gallery_image_ids' => [], 'length' => '', 'width' => '', 'height' => '', 'sku' => 'A1'];

        $this->assertSame(['manage_stock', 'regular_price'], Concurrency::requestedProps(['id' => 1, 'manage_stock' => false, 'regular_price' => '11.00'], $data));
        $this->assertSame(['manage_stock'], Concurrency::requestedProps(['manage_stock' => 'no'], $data));
        $this->assertSame(['category_ids', 'image_id', 'gallery_image_ids'], Concurrency::requestedProps(['categories' => [['id' => 3]], 'images' => []], $data));
        $this->assertSame(['width'], Concurrency::requestedProps(['dimensions' => ['width' => '2']], $data), 'only the dimensions sent');
        $this->assertSame([], Concurrency::requestedProps(['stock_quantity' => 5], $data), 'a value WooCommerce did not take is not put back');
        $this->assertSame([], Concurrency::requestedProps(['manage_stock' => true, 'meta_data' => [], Concurrency::EXPECT_KEY => []], $data));
    }

    public function test_the_expect_key_is_addressing_not_a_logged_field(): void
    {
        $this->assertSame(['regular_price'], Recorder::paths(['id' => 1, 'regular_price' => '10', Concurrency::EXPECT_KEY => ['regular_price' => '15']]));
    }

    public function test_a_sale_key_watches_the_fields_woocommerce_clears_with_it(): void
    {
        $this->assertSame(['name'], Recorder::watched(['name']));
        $this->assertSame(['regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to'], Recorder::watched(['regular_price']));
        $this->assertSame(['sale_price', 'name', 'date_on_sale_from', 'date_on_sale_to'], Recorder::watched(['sale_price', 'name']));
    }

    public function test_turning_stock_management_off_watches_what_woocommerce_clears_with_it(): void
    {
        // WC_Product::validate_props() empties the quantity, backorders and low stock threshold: logged, a revert puts them back.
        $this->assertSame(['manage_stock', 'stock_status', 'stock_quantity', 'backorders', 'low_stock_amount'], Recorder::watched(['manage_stock', 'stock_status']));
        $this->assertSame(['stock_quantity'], Recorder::watched(['stock_quantity']));
    }

    public function test_making_an_item_virtual_watches_the_shipping_data_woocommerce_clears_with_it(): void
    {
        // The wc/v3 controllers empty the weight, dimensions and shipping class of a virtual item: logged, a revert puts them back.
        $this->assertSame(['virtual', 'weight', 'dimensions', 'shipping_class'], Recorder::watched(['virtual']));
        $this->assertSame(['weight'], Recorder::watched(['weight']));
    }

    public function test_the_plan_writes_products_first_then_variations_by_parent(): void
    {
        $this->assertSame([5, 1, 3, 2, 4], LogController::writeOrder([
            ['object_id' => 1, 'object_type' => 'variation', 'parent_id' => 10, 'first_id' => 1],
            ['object_id' => 2, 'object_type' => 'variation', 'parent_id' => 20, 'first_id' => 2],
            ['object_id' => 3, 'object_type' => 'variation', 'parent_id' => 10, 'first_id' => 3],
            ['object_id' => 5, 'object_type' => 'product', 'parent_id' => 0, 'first_id' => 4],
            ['object_id' => 4, 'object_type' => 'variation', 'parent_id' => 20, 'first_id' => 5],
        ]));
    }
}
