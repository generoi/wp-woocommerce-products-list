<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Rest\ListQuery;
use GeneroWP\ProductsList\Rest\Rows;

class VariationsTest extends RestTestCase
{
    /**
     * `rest_do_request()` skips the server's `rest_post_dispatch` step that
     * trims a response to `_fields` over HTTP; apply it here the way
     * `serve_request()` does, so the keys are what the app receives.
     */
    private function trimmed(\WP_REST_Response $response, string $fields): mixed
    {
        $request = new \WP_REST_Request('GET', '/');
        $request->set_query_params(['_fields' => $fields]);

        return $this->data(rest_filter_response_fields($response, $this->server, $request));
    }

    public function test_variation_rows_have_name_parent_and_list_data(): void
    {
        $parent = $this->variableProduct(['38', '39']);

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['per_page' => 100]);
        $this->assertStatus(200, $response);
        $rows = $this->data($response);
        $this->assertCount(2, $rows);

        foreach ($rows as $row) {
            $this->assertSame($parent->get_id(), $row['parent_id']);
            // wc/v3 formats the variation name from its attributes.
            $this->assertContains($row['name'], ['38', '39']);
            $this->assertSame([
                'variation_count' => 0,
                'edit_link' => get_edit_post_link($parent->get_id(), 'raw'),
                'can_edit' => true,
                'can_delete' => true,
                'parent_id' => $parent->get_id(),
            ], $row[Rows::KEY]);
        }

        $this->assertSame(2, (int) $response->get_headers()['X-WP-Total']);
    }

    public function test_variation_rows_respect_fields(): void
    {
        $parent = $this->variableProduct(['38']);

        $fields = 'id,name,parent_id,wc_products_list.parent_id';
        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => $fields]);
        $row = $this->trimmed($response, $fields)[0];
        $this->assertSame(['id', 'name', 'parent_id', Rows::KEY], array_values(array_diff(array_keys($row), ['_links'])));
        $this->assertSame(['parent_id' => $parent->get_id()], $row[Rows::KEY]);

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id,sku']);
        $this->assertArrayNotHasKey(Rows::KEY, $this->data($response)[0]);

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', [], [ListMode::HEADER => '']);
        $this->assertArrayNotHasKey(Rows::KEY, $this->data($response)[0]);
    }

    public function test_variations_come_in_menu_order_then_id(): void
    {
        $parent = $this->variableProduct(['38', '39', '40']);
        $ids = $parent->get_children();
        $this->assertCount(3, $ids);

        // Reverse the editor order, leave a tie for the id to break.
        foreach ([$ids[0] => 5, $ids[1] => 1, $ids[2] => 1] as $id => $order) {
            $variation = wc_get_product($id);
            $variation->set_menu_order($order);
            $variation->save();
        }

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id']);
        $this->assertStatus(200, $response);
        $this->assertSame([$ids[1], $ids[2], $ids[0]], array_column($this->data($response), 'id'));

        // An explicit ordering is left alone.
        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id', 'orderby' => 'id', 'order' => 'desc']);
        $this->assertSame([$ids[2], $ids[1], $ids[0]], array_column($this->data($response), 'id'));

        // Without the header wc/v3 keeps its own default (date, newest first).
        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id'], [ListMode::HEADER => '']);
        $this->assertSame([$ids[2], $ids[1], $ids[0]], array_column($this->data($response), 'id'));
    }

    public function test_variation_query_args_filter(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        $keep = $parent->get_children()[1];

        add_filter(ListQuery::FILTER_VARIATION_ARGS, function (array $args, \WP_REST_Request $request) use ($keep, $parent): array {
            $this->assertSame((string) $parent->get_id(), (string) $request['product_id']);
            $this->assertSame(['menu_order' => 'ASC', 'ID' => 'ASC'], $args['orderby']);
            $args['post__in'] = [$keep];

            return $args;
        }, 10, 2);

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id']);
        $this->assertSame([$keep], array_column($this->data($response), 'id'));

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id'], [ListMode::HEADER => '']);
        $this->assertCount(2, $this->data($response));
    }

    public function test_parent_variation_count_follows_the_children(): void
    {
        $parent = $this->variableProduct(['38', '39', '40']);
        $gone = $parent->get_children()[0];

        wp_trash_post($gone);
        wc_delete_product_transients($parent->get_id());

        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id(), ['_fields' => 'id,wc_products_list']);
        $this->assertStatus(200, $response);
        $this->assertSame(2, $this->data($response)[Rows::KEY]['variation_count']);
    }
}
