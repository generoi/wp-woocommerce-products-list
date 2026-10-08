<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Table;
use WP_REST_Request;

/**
 * POST /wc-products-list/v1/variations/batch: one write for variations of
 * any number of parents.
 */
class VariationsBatchTest extends RestTestCase
{
    /**
     * @return array<int, array<string, mixed>>
     */
    private function rows(): array
    {
        global $wpdb;

        $table = Table::name();

        return $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $this->batchId()), ARRAY_A); // phpcs:ignore
    }

    public function test_variations_of_several_parents_are_written_in_one_request(): void
    {
        $a = $this->variableProduct(['38', '39']);
        $b = $this->variableProduct(['40']);
        [$a38, $a39] = $a->get_children();
        [$b40] = $b->get_children();
        $simple = $this->simpleProduct(['sku' => 'TAKEN']);

        $nested = [];
        add_filter('rest_request_before_callbacks', static function ($response, $handler, WP_REST_Request $request) use (&$nested) {
            if (str_starts_with($request->get_route(), '/wc/v3/')) {
                $nested[] = $request->get_route();
            }

            return $response;
        }, 10, 3);

        $response = $this->request('POST', '/wc-products-list/v1/variations/batch', [
            'update' => [
                ['id' => $b40, 'sale_price' => '149', 'date_on_sale_from' => '2026-11-02', 'parent_id' => 1],
                ['id' => $a38, 'sale_price' => '149', 'date_on_sale_from' => '2026-11-02'],
                ['id' => $simple->get_id(), 'sale_price' => '149'],
                ['id' => $a39, 'sku' => 'TAKEN'],
                ['id' => 0],
            ],
        ], [Logger::SOURCE_HEADER => 'bulk'], ['fields' => 'id,sale_price,parent_id']);
        $this->assertStatus(200, $response);

        // One wc/v3 request per parent, whatever the order of the items.
        $this->assertEqualsCanonicalizing(['/wc/v3/products/'.$a->get_id().'/variations/batch', '/wc/v3/products/'.$b->get_id().'/variations/batch'], $nested);

        $update = $this->data($response)['update'];
        $this->assertCount(5, $update);
        // Request order, rows trimmed to `fields`.
        $this->assertSame([$b40, $a38, $simple->get_id(), $a39, 0], array_column($update, 'id'));
        $this->assertSame(['id' => $b40, 'sale_price' => '149', 'parent_id' => $b->get_id()], array_diff_key($update[0], ['_links' => 1]));
        $this->assertSame($a->get_id(), $update[1]['parent_id']);
        $this->assertSame('woocommerce_rest_product_variation_invalid_id', $update[2]['error']['code']);
        $this->assertSame('woocommerce_rest_product_variation_invalid_id', $update[4]['error']['code']);
        // WooCommerce's own validation, per item.
        $this->assertSame('product_invalid_sku', $update[3]['error']['code']);

        $this->assertSame('149', wc_get_product($b40)->get_sale_price());
        $this->assertSame('149', wc_get_product($a38)->get_sale_price());
        $this->assertSame('', wc_get_product($a39)->get_sku());
        $this->assertSame('', wc_get_product($simple->get_id())->get_sale_price());

        // Logged under the request's batch id and source, with the parents.
        $rows = $this->rows();
        $byObject = [];

        foreach ($rows as $row) {
            $byObject[(int) $row['object_id']][] = $row;
        }

        $this->assertSame(['bulk'], array_unique(array_column($rows, 'source')));
        $this->assertSame(['variation'], array_unique(array_column($rows, 'object_type')));
        $this->assertEqualsCanonicalizing(['sale_price', 'date_on_sale_from'], array_column($byObject[$b40], 'field'));
        $this->assertSame($b->get_id(), (int) $byObject[$b40][0]['parent_id']);
        $this->assertSame($a->get_id(), (int) $byObject[$a38][0]['parent_id']);
        $this->assertSame('error', $byObject[$a39][0]['status']);
        // The rejected id gets an error row like any rejected item; nothing for id 0.
        $this->assertSame('error', $byObject[$simple->get_id()][0]['status']);
        $this->assertSame('woocommerce_rest_product_variation_invalid_id', json_decode($byObject[$simple->get_id()][0]['context'], true)['code']);
        $this->assertArrayNotHasKey(0, $byObject);

        // And the batch reverts as one (the two error rows are reported as skipped).
        $data = $this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert'));
        $results = array_column($data['results'], null, 'id');
        $this->assertTrue($results[$b40]['ok']);
        $this->assertTrue($results[$a38]['ok']);
        $this->assertSame('skipped', $results[$a39]['code']);
        $this->assertSame('skipped', $results[$simple->get_id()]['code']);
        $this->assertSame('', wc_get_product($b40)->get_sale_price());
        $this->assertSame('', wc_get_product($a38)->get_sale_price());
    }

    public function test_limits_and_permissions(): void
    {
        $parent = $this->variableProduct(['38']);
        $variation = $parent->get_children()[0];

        $response = $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => []]);
        $this->assertStatus(400, $response);

        $response = $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => array_fill(0, 101, ['id' => $variation])]);
        $this->assertStatus(413, $response);
        $this->assertSame('woocommerce_rest_request_entity_too_large', $this->data($response)['code']);

        add_role(CapabilitiesTest::ROLE, 'Catalog editor', ['read' => true, 'edit_products' => true, 'edit_published_products' => true, 'publish_products' => true, 'read_private_products' => true]);

        try {
            // What wc/v3 asks of a batch: edit_others_products.
            $this->actAs(CapabilitiesTest::ROLE);
            $response = $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [['id' => $variation, 'sale_price' => '99']]]);
            $this->assertStatus(403, $response);
            $this->assertSame('woocommerce_rest_cannot_batch', $this->data($response)['code']);
            $this->assertSame('', wc_get_product($variation)->get_sale_price());

            $this->actAs('editor');
            $this->assertStatus(403, $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [['id' => $variation, 'sale_price' => '99']]]));

            $this->actAs('shop_manager');
            $response = $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [['id' => $variation, 'sale_price' => '99']]]);
            $this->assertStatus(200, $response);
            $this->assertSame('99', wc_get_product($variation)->get_sale_price());
        } finally {
            remove_role(CapabilitiesTest::ROLE);
        }
    }
}
