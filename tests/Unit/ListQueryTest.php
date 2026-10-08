<?php

namespace GeneroWP\ProductsList\Tests\Unit;

use GeneroWP\ProductsList\Rest\ListQuery;
use PHPUnit\Framework\TestCase;

class ListQueryTest extends TestCase
{
    public function test_tabs_map_to_statuses(): void
    {
        $this->assertSame(['publish', 'future', 'draft', 'pending', 'private'], ListQuery::statusesForTab('all'));
        $this->assertSame(['trash'], ListQuery::statusesForTab('trash'));
        $this->assertSame(['draft'], ListQuery::statusesForTab('draft'));
        $this->assertNull(ListQuery::statusesForTab('any'));
        $this->assertNull(ListQuery::statusesForTab(''));
    }

    public function test_vars_from_a_full_request(): void
    {
        $vars = ListQuery::vars([
            'tab' => 'publish',
            'brand' => '12,13',
            'exclude_category' => [5, '6', 0, 'x'],
            'exclude_tag' => '7',
            'min_stock_quantity' => '1',
            'max_stock_quantity' => 10.5,
            'has_variations' => 'true',
            'orderby' => 'SKU',
            'per_page' => 100,
        ]);

        $this->assertSame(['publish'], $vars['statuses']);
        $this->assertSame([12, 13], $vars['brand']);
        $this->assertSame([5, 6], $vars['exclude_category']);
        $this->assertSame([7], $vars['exclude_tag']);
        $this->assertSame(1.0, $vars['min_stock']);
        $this->assertSame(10.5, $vars['max_stock']);
        $this->assertTrue($vars['has_variations']);
        $this->assertNull($vars['sale_scheduled']);
        $this->assertTrue(ListQuery::vars(['sale_scheduled' => 'true'])['sale_scheduled']);
        $this->assertSame('sku', $vars['orderby']);
        $this->assertNull($vars['variation_stock_status']);
        $this->assertSame('outofstock', ListQuery::vars(['variation_stock_status' => 'outofstock'])['variation_stock_status']);
        $this->assertNull(ListQuery::vars(['variation_stock_status' => "x' OR 1=1"])['variation_stock_status']);
    }

    public function test_vars_from_an_empty_request_are_all_off(): void
    {
        $vars = ListQuery::vars(['orderby' => 'date', 'search_name_or_sku' => 'boot']);

        $this->assertNull($vars['statuses']);
        $this->assertSame([], $vars['brand']);
        $this->assertSame([], $vars['exclude_category']);
        $this->assertSame([], $vars['exclude_tag']);
        $this->assertNull($vars['min_stock']);
        $this->assertNull($vars['max_stock']);
        $this->assertNull($vars['has_variations']);
        $this->assertNull($vars['orderby']);
    }

    public function test_search_tokens_are_split_on_whitespace(): void
    {
        $this->assertSame(['saga', 'ab-1'], ListQuery::vars(['search_name_or_sku' => '  saga   ab-1 '])['search']);
        $this->assertSame([], ListQuery::vars([])['search']);
        $this->assertSame([], ListQuery::vars(['search_name_or_sku' => ''])['search']);
    }

    public function test_has_variations_accepts_the_rest_boolean_spellings(): void
    {
        $this->assertTrue(ListQuery::vars(['has_variations' => true])['has_variations']);
        $this->assertTrue(ListQuery::vars(['has_variations' => '1'])['has_variations']);
        $this->assertFalse(ListQuery::vars(['has_variations' => '0'])['has_variations']);
        $this->assertFalse(ListQuery::vars(['has_variations' => 'false'])['has_variations']);
        $this->assertFalse(ListQuery::vars(['has_variations' => false])['has_variations']);
        $this->assertNull(ListQuery::vars(['has_variations' => ''])['has_variations']);
    }

    public function test_only_known_orderings_and_numeric_bounds_count(): void
    {
        $this->assertSame('stock_quantity', ListQuery::vars(['orderby' => 'stock_quantity'])['orderby']);
        $this->assertSame('menu_order', ListQuery::vars(['orderby' => 'menu_order'])['orderby']);
        $this->assertSame('post_status', ListQuery::vars(['orderby' => 'post_status'])['orderby']);
        $this->assertNull(ListQuery::vars(['orderby' => 'price'])['orderby']);
        $this->assertNull(ListQuery::vars(['orderby' => ['sku']])['orderby']);
        $this->assertNull(ListQuery::vars(['min_stock_quantity' => 'many'])['min_stock']);
        $this->assertNull(ListQuery::vars(['tab' => ['all']])['statuses']);
    }

    public function test_declared_params_cover_the_contract(): void
    {
        $params = ListQuery::params();

        $this->assertSame(
            ['tab', 'brand', 'exclude_category', 'exclude_tag', 'min_stock_quantity', 'max_stock_quantity', 'has_variations', 'sale_scheduled', 'variation_stock_status'],
            array_keys($params)
        );
        $this->assertSame(ListQuery::TABS, $params['tab']['enum']);
        $this->assertSame(['sku', 'stock_quantity', 'menu_order', 'post_status'], ListQuery::ORDERBY);
    }
}
