<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Rest\TermsController;

class TermsTest extends RestTestCase
{
    /**
     * @return array<string, int> name => term id
     */
    private function categories(string ...$names): array
    {
        $ids = [];

        foreach ($names as $name) {
            $term = wp_insert_term($name, 'product_cat');
            $this->assertIsArray($term, $name);
            $ids[$name] = (int) $term['term_id'];
        }

        return $ids;
    }

    public function test_terms_are_listed_by_name_with_totals(): void
    {
        $ids = $this->categories('Sandals', 'Boots', 'Sneakers');
        $product = $this->simpleProduct();
        wp_set_object_terms($product->get_id(), [$ids['Boots']], 'product_cat');

        $response = $this->request('GET', '/wc-products-list/v1/terms/product_cat');
        $this->assertStatus(200, $response);
        $data = $this->data($response);

        $names = array_column($data['items'], 'name');
        $this->assertSame(['Boots', 'Sandals', 'Sneakers'], $names);
        $this->assertSame(3, $data['total']);
        $this->assertSame(1, $data['totalPages']);
        $this->assertSame('3', $response->get_headers()['X-WP-Total']);
        $this->assertSame('1', $response->get_headers()['X-WP-TotalPages']);

        $boots = $data['items'][0];
        $this->assertSame(['id', 'name', 'slug', 'parent', 'count'], array_keys($boots));
        $this->assertSame($ids['Boots'], $boots['id']);
        $this->assertSame('boots', $boots['slug']);
        $this->assertSame(0, $boots['parent']);
        $this->assertSame(1, $boots['count']);
    }

    public function test_search_include_and_paging(): void
    {
        $ids = $this->categories('Sandals', 'Boots', 'Sneakers', 'Snow boots');

        $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/product_cat', ['search' => 'boot']));
        $this->assertSame(['Boots', 'Snow boots'], array_column($data['items'], 'name'));
        $this->assertSame(2, $data['total']);

        $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/product_cat', ['include' => $ids['Sneakers'].','.$ids['Sandals']]));
        $this->assertSame([$ids['Sandals'], $ids['Sneakers']], array_column($data['items'], 'id'));
        $this->assertSame(2, $data['total']);

        $response = $this->request('GET', '/wc-products-list/v1/terms/product_cat', ['per_page' => 2, 'page' => 2]);
        $data = $this->data($response);
        $this->assertSame(['Sneakers', 'Snow boots'], array_column($data['items'], 'name'));
        $this->assertSame(4, $data['total']);
        $this->assertSame(2, $data['totalPages']);
        $this->assertSame('2', $response->get_headers()['X-WP-TotalPages']);

        $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/product_cat', ['per_page' => 3, 'page' => 2]));
        $this->assertSame(['Snow boots'], array_column($data['items'], 'name'));

        $this->assertStatus(400, $this->request('GET', '/wc-products-list/v1/terms/product_cat', ['per_page' => 500]));
    }

    public function test_attribute_shipping_class_tag_and_brand_taxonomies(): void
    {
        $attribute = wc_create_attribute(['name' => 'Width', 'slug' => 'width']);
        $this->assertIsInt($attribute);
        // Attribute taxonomies are registered on init; a new one needs a
        // registration pass of its own within the test.
        register_taxonomy('pa_width', 'product', ['hierarchical' => false, 'show_ui' => false]);
        $wide = wp_insert_term('Wide', 'pa_width');
        $this->assertIsArray($wide);

        $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/pa_width'));
        $this->assertSame(['Wide'], array_column($data['items'], 'name'));

        $express = wp_insert_term('Express', 'product_shipping_class');
        $this->assertIsArray($express);
        $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/product_shipping_class'));
        $this->assertContains('Express', array_column($data['items'], 'name'));

        $tag = wp_insert_term('Sale', 'product_tag');
        $this->assertIsArray($tag);
        $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/product_tag', ['search' => 'sal']));
        $this->assertSame(['Sale'], array_column($data['items'], 'name'));

        if (taxonomy_exists('product_brand')) {
            $brand = wp_insert_term('Saga', 'product_brand');
            $this->assertIsArray($brand);
            $data = $this->data($this->request('GET', '/wc-products-list/v1/terms/product_brand'));
            $this->assertContains('Saga', array_column($data['items'], 'name'));
        }
    }

    public function test_other_taxonomies_are_not_found(): void
    {
        $this->assertStatus(404, $this->request('GET', '/wc-products-list/v1/terms/category'));
        $this->assertStatus(404, $this->request('GET', '/wc-products-list/v1/terms/product_type'));
        $this->assertStatus(404, $this->request('GET', '/wc-products-list/v1/terms/pa_nothing'));
        $this->assertStatus(404, $this->request('GET', '/wc-products-list/v1/terms/product_visibility'));

        $this->assertFalse(TermsController::allows('post_tag'));
        $this->assertTrue(TermsController::allows('product_cat'));
    }

    public function test_terms_need_the_list_capability(): void
    {
        $this->actAs('shop_manager');
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/terms/product_cat'));

        $this->actAs('subscriber');
        $this->assertStatus(403, $this->request('GET', '/wc-products-list/v1/terms/product_cat'));

        $this->actAs('guest');
        $this->assertStatus(401, $this->request('GET', '/wc-products-list/v1/terms/product_cat'));
    }
}
