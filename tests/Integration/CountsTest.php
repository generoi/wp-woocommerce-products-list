<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Rest\CountsController;

class CountsTest extends RestTestCase
{
    public function test_counts_per_status_and_all_without_trash(): void
    {
        $this->simpleProduct();
        $this->simpleProduct();
        $this->simpleProduct(['status' => 'draft']);
        $this->simpleProduct(['status' => 'private']);
        $this->simpleProduct(['status' => 'pending']);
        $this->simpleProduct(['status' => 'trash']);

        $response = $this->request('GET', '/wc-products-list/v1/counts');
        $this->assertStatus(200, $response);

        $this->assertSame([
            'all' => 5,
            'publish' => 2,
            'future' => 0,
            'draft' => 1,
            'pending' => 1,
            'private' => 1,
            'trash' => 1,
        ], $this->data($response));
    }

    public function test_counts_are_fresh_after_a_change(): void
    {
        $product = $this->simpleProduct();

        $this->assertSame(1, $this->data($this->request('GET', '/wc-products-list/v1/counts'))['publish']);

        wp_trash_post($product->get_id());

        $counts = $this->data($this->request('GET', '/wc-products-list/v1/counts'));
        $this->assertSame(0, $counts['publish']);
        $this->assertSame(1, $counts['trash']);
        $this->assertSame(0, $counts['all']);
    }

    public function test_counts_filter(): void
    {
        $this->simpleProduct();

        add_filter(CountsController::FILTER_COUNTS, static function (array $counts): array {
            $counts['missing:se'] = 7;

            return $counts;
        });

        $counts = $this->data($this->request('GET', '/wc-products-list/v1/counts'));
        $this->assertSame(7, $counts['missing:se']);
        $this->assertSame(1, $counts['publish']);
    }

    public function test_counts_need_the_list_capability(): void
    {
        $this->actAs('shop_manager');
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/counts'));

        $this->actAs('subscriber');
        $this->assertStatus(403, $this->request('GET', '/wc-products-list/v1/counts'));

        $this->actAs('guest');
        $this->assertStatus(401, $this->request('GET', '/wc-products-list/v1/counts'));
    }
}
