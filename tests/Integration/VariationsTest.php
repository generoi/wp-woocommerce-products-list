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

    /**
     * @return array<int, string> the queries run while `$run` executes that match `$pattern`
     */
    private function queriesMatching(string $pattern, callable $run): array
    {
        $seen = [];
        $filter = static function (string $query) use (&$seen, $pattern): string {
            if (preg_match($pattern, $query)) {
                $seen[] = $query;
            }

            return $query;
        };

        add_filter('query', $filter);
        $run();
        remove_filter('query', $filter);

        return $seen;
    }

    /**
     * A plugin that keeps per-variation terms in a taxonomy registered
     * for products only (Polylang's `language`) reads them while each
     * variation loads; WP_Query primes only the variation taxonomies.
     * In list mode the page's relationships are primed in one query.
     */
    public function test_expanding_variations_primes_product_taxonomies_for_every_row(): void
    {
        // Registered the way Polylang does: for no post type in particular.
        register_taxonomy('language', [], ['public' => false]);
        $term = wp_insert_term('fi', 'language');
        $this->assertContains('language', Rows::variationTaxonomies());
        $this->assertIsArray($term);

        $parent = $this->variableProduct(['38', '39', '40']);
        $ids = $parent->get_children();
        wp_set_object_terms($ids[0], [(int) $term['term_id']], 'language');
        wp_cache_flush();

        try {
            // The queries reading the variations' relationships (the parent's own load is one more).
            $forRows = '/\'language\'[^;]*object_id IN \\((?:[\\d, ]*\\b(?:'.implode('|', $ids).')\\b)/';
            $queries = $this->queriesMatching($forRows, function () use ($parent): void {
                $this->assertStatus(200, $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id']));
            });

            $this->assertCount(1, $queries, implode("\n", $queries));

            foreach ($ids as $id) {
                $cached = get_object_term_cache($id, 'language');
                $this->assertIsArray($cached, "variation #{$id}");
            }

            $this->assertSame([(int) $term['term_id']], wp_list_pluck(get_object_term_cache($ids[0], 'language'), 'term_id'));
            $this->assertSame([], get_object_term_cache($ids[1], 'language'));

            // A lookup the way plugins read terms (through the object cache) is a hit: no query per row.
            $queries = $this->queriesMatching($forRows, static function () use ($ids): void {
                foreach ($ids as $id) {
                    get_the_terms($id, 'language');
                }
            });
            $this->assertSame([], $queries);

            // Not primed outside list mode.
            wp_cache_flush();
            $queries = $this->queriesMatching($forRows, function () use ($parent): void {
                $this->assertStatus(200, $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['_fields' => 'id'], [ListMode::HEADER => '']));
            });
            $this->assertSame([], $queries);
        } finally {
            unregister_taxonomy('language');
        }
    }

    /**
     * The query budget of an expand: posts, meta, terms and WooCommerce's
     * own raw meta cache are primed per page, so the count does not grow
     * with the rows. Pinned so a regression to a query per row for
     * terms, posts, raw meta or prices shows up here.
     */
    public function test_expanding_a_page_of_variations_stays_within_the_query_budget(): void
    {
        global $wpdb;

        $parent = $this->variableProduct(array_map('strval', range(20, 49)));
        $this->assertCount(30, $parent->get_children());
        wp_cache_flush();

        $before = $wpdb->num_queries;
        $response = $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', [
            'per_page' => 100,
            'image_size' => 'thumbnail',
            '_fields' => 'id,name,sku,price,regular_price,sale_price,date_on_sale_from,date_on_sale_to,stock_status,stock_quantity,manage_stock,status,parent_id,image,attributes,wc_products_list',
        ]);
        $this->assertStatus(200, $response);
        $this->assertCount(30, $this->data($response));

        $queries = $wpdb->num_queries - $before;
        $this->assertLessThanOrEqual(30, $queries, "{$queries} queries for 30 variations");
    }

    /**
     * WooCommerce's raw meta read (`SELECT meta_id … WHERE post_id = N`)
     * is answered from the primed cache: no such query per row.
     */
    public function test_expanding_variations_reads_raw_meta_once_for_the_page(): void
    {
        $parent = $this->variableProduct(['36', '37', '38', '39']);
        $ids = $parent->get_children();
        wp_cache_flush();

        $perRow = '/meta_id, meta_key, meta_value\s+FROM \S*postmeta\s+WHERE post_id = \d+/';
        $queries = $this->queriesMatching($perRow, function () use ($parent): void {
            $this->assertStatus(200, $this->request('GET', '/wc/v3/products/'.$parent->get_id().'/variations', ['per_page' => 100, '_fields' => 'id,sku,regular_price']));
        });

        $this->assertSame([], $queries, implode("\n", $queries));

        foreach ($ids as $id) {
            $this->assertIsArray(wp_cache_get(\WC_Data::generate_meta_cache_key($id, 'products'), 'products'), "variation #{$id}");
        }
    }

    /**
     * `GET /wc/v3/variations?parent=…`: many parents' variations in a few
     * pages instead of one request per parent (expand all, bulk edit of a
     * whole page), grouped by parent in the order given, each parent's in
     * menu order, and within the query budget of one parent's expand.
     */
    public function test_variations_across_parents_come_grouped_in_the_given_order(): void
    {
        global $wpdb;

        $first = $this->variableProduct(['38', '39', '40']);
        $second = $this->variableProduct(['41', '42']);
        $a = $first->get_children();
        $b = $second->get_children();

        foreach ([$a[0] => 5, $a[1] => 1, $a[2] => 1, $b[0] => 9, $b[1] => 0] as $id => $order) {
            $variation = wc_get_product($id);
            $variation->set_menu_order($order);
            $variation->save();
        }

        $parents = [$second->get_id(), $first->get_id()];
        $expected = [$b[1], $b[0], $a[1], $a[2], $a[0]];

        $response = $this->request('GET', '/wc/v3/variations', ['parent' => $parents, 'per_page' => 100, '_fields' => 'id,parent_id,wc_products_list']);
        $this->assertStatus(200, $response);
        $rows = $this->data($response);
        $this->assertSame($expected, array_column($rows, 'id'));
        $this->assertSame($second->get_id(), $rows[0][Rows::KEY]['parent_id']);

        // The app's explicit menu order keeps the grouping, and pages split nothing.
        $paged = [];

        foreach ([1, 2, 3] as $page) {
            $response = $this->request('GET', '/wc/v3/variations', ['parent' => $parents, 'per_page' => 2, 'page' => $page, 'orderby' => 'menu_order', 'order' => 'asc', '_fields' => 'id']);
            $this->assertStatus(200, $response);
            array_push($paged, ...array_column($this->data($response), 'id'));
        }

        $this->assertSame($expected, $paged);

        // Budget: one request for both parents costs no more than expanding one.
        $big = $this->variableProduct(array_map('strval', range(20, 49)));
        wp_cache_flush();
        $before = $wpdb->num_queries;
        $response = $this->request('GET', '/wc/v3/variations', [
            'parent' => [$big->get_id(), $first->get_id(), $second->get_id()],
            'per_page' => 100,
            '_fields' => 'id,name,sku,price,regular_price,sale_price,stock_status,stock_quantity,status,parent_id,image,attributes,wc_products_list',
        ]);
        $this->assertCount(35, $this->data($response));
        $queries = $wpdb->num_queries - $before;
        $this->assertLessThanOrEqual(35, $queries, "{$queries} queries for 35 variations of 3 parents");
    }

    public function test_the_cross_parent_route_reads_by_parent_or_by_id(): void
    {
        $first = $this->variableProduct(['38', '39', '40']);
        $second = $this->variableProduct(['41', '42']);
        $a = $first->get_children();
        $b = $second->get_children();
        $route = '/wc-products-list/v1/variations';

        // By parent, comma-separated as the app sends it: grouped in the order given, paged with the wc/v3 headers.
        $response = $this->request('GET', $route, ['parent' => $second->get_id().','.$first->get_id(), 'per_page' => 4, '_fields' => 'id,parent_id,wc_products_list']);
        $this->assertStatus(200, $response);
        $this->assertSame([...$b, $a[0], $a[1]], array_column($this->data($response), 'id'));
        $this->assertSame($second->get_id(), $this->data($response)[0][Rows::KEY]['parent_id']);
        $this->assertSame(5, (int) $response->get_headers()['X-WP-Total']);
        $this->assertSame(2, (int) $response->get_headers()['X-WP-TotalPages']);

        $response = $this->request('GET', $route, ['parent' => [$second->get_id(), $first->get_id()], 'per_page' => 4, 'page' => 2]);
        $this->assertSame([$a[2]], array_column($this->data($response), 'id'));

        // By id, across parents; a product id is no variation and is left out.
        $response = $this->request('GET', $route, ['include' => implode(',', [$a[1], $b[0], $first->get_id()])]);
        $this->assertStatus(200, $response);
        $ids = array_column($this->data($response), 'id');
        sort($ids);
        $this->assertSame([$a[1], $b[0]], $ids);

        // Exactly one of the two, at most 100 ids.
        $this->assertStatus(400, $this->request('GET', $route, []));
        $this->assertStatus(400, $this->request('GET', $route, ['include' => [$a[0]], 'parent' => [$first->get_id()]]));
        $this->assertStatus(400, $this->request('GET', $route, ['include' => range(1, 101)]));
        $this->assertStatus(400, $this->request('GET', $route, ['parent' => [$first->get_id()], 'per_page' => 101]));

        // The list capability, as every route of the app.
        $this->actAs('subscriber');
        $this->assertStatus(403, $this->request('GET', $route, ['parent' => [$first->get_id()]]));
    }
}
