<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Bootstrap;

/**
 * What a role with `edit_products` but without `edit_others_products` can
 * do: browse, quick-edit its own products, but not bulk edit, because
 * WooCommerce's batch endpoints require `edit_others_products`. The
 * README's Capabilities section describes exactly this.
 */
class CapabilitiesTest extends RestTestCase
{
    public const ROLE = 'wc_products_list_test_editor';

    public function set_up(): void
    {
        parent::set_up();

        add_role(self::ROLE, 'Catalog editor', [
            'read' => true,
            'edit_products' => true,
            'edit_published_products' => true,
            'publish_products' => true,
            'read_private_products' => true,
        ]);
    }

    public function tear_down(): void
    {
        remove_role(self::ROLE);

        parent::tear_down();
    }

    public function test_edit_products_alone_allows_single_saves_but_not_batch(): void
    {
        $userId = $this->actAs(self::ROLE);
        $own = $this->simpleProduct(['sku' => 'OWN']);
        wp_update_post(['ID' => $own->get_id(), 'post_author' => $userId]);
        clean_post_cache($own->get_id());

        $caps = Bootstrap::settings()['caps'];
        $this->assertTrue($caps['edit']);
        $this->assertFalse($caps['editOthers']);

        // Browsing and the plugin's own routes.
        $this->assertStatus(200, $this->request('GET', '/wc/v3/products', ['include' => [$own->get_id()], '_fields' => 'id']));
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/counts'));

        // Quick edit of an own product: edit_post on that product.
        $response = $this->request('POST', '/wc/v3/products/'.$own->get_id(), ['regular_price' => '99']);
        $this->assertStatus(200, $response);
        $this->assertSame('99', wc_get_product($own->get_id())->get_regular_price());

        // Bulk edit: WooCommerce's batch endpoints need edit_others_products.
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $own->get_id(), 'regular_price' => '98']]]);
        $this->assertStatus(403, $response);
        $this->assertSame('woocommerce_rest_cannot_batch', $this->data($response)['code']);
        $this->assertSame('99', wc_get_product($own->get_id())->get_regular_price());

        $parent = $this->variableProduct(['38']);
        $response = $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', ['update' => [['id' => $parent->get_children()[0], 'regular_price' => '98']]]);
        $this->assertStatus(403, $response);
        $this->assertSame('woocommerce_rest_cannot_batch', $this->data($response)['code']);

        // A shop manager has the capability and the batch goes through.
        $this->actAs('shop_manager');
        $this->assertTrue(Bootstrap::settings()['caps']['editOthers']);
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $own->get_id(), 'regular_price' => '98']]]);
        $this->assertStatus(200, $response);
        $this->assertSame('98', wc_get_product($own->get_id())->get_regular_price());
    }
}
