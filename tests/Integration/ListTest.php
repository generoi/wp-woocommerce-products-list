<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Rest\ListQuery;
use GeneroWP\ProductsList\Rest\Rows;

class ListTest extends RestTestCase
{
    /**
     * @param  array<string, mixed>  $params
     * @param  array<string, string>  $headers
     * @return array<int, int> the ids in response order
     */
    private function ids(array $params, array $headers = []): array
    {
        $response = $this->request('GET', '/wc/v3/products', $params + ['per_page' => 100, '_fields' => 'id'], $headers);
        $this->assertStatus(200, $response);

        return array_map('intval', array_column($this->data($response), 'id'));
    }

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

    public function test_tab_all_shows_every_status_but_trash(): void
    {
        $published = $this->simpleProduct()->get_id();
        $draft = $this->simpleProduct(['status' => 'draft'])->get_id();
        $private = $this->simpleProduct(['status' => 'private'])->get_id();
        $pending = $this->simpleProduct(['status' => 'pending'])->get_id();
        $trashed = $this->simpleProduct(['status' => 'trash'])->get_id();

        $all = $this->ids(['tab' => 'all']);
        $this->assertContains($published, $all);
        $this->assertContains($draft, $all);
        $this->assertContains($private, $all);
        $this->assertContains($pending, $all);
        $this->assertNotContains($trashed, $all);

        $this->assertSame([$trashed], $this->ids(['tab' => 'trash']));
        $this->assertSame([$draft], $this->ids(['tab' => 'draft']));
        $this->assertSame([$private], $this->ids(['tab' => 'private']));

        // The tab is a list-mode parameter: without the header it is just
        // an unknown query argument and WooCommerce's `status=any` applies.
        $this->assertContains($published, $this->ids(['tab' => 'trash'], [ListMode::HEADER => '']));

        $response = $this->request('GET', '/wc/v3/products', ['tab' => 'archived']);
        $this->assertStatus(400, $response);
    }

    public function test_brand_filters_by_term_id(): void
    {
        if (! taxonomy_exists('product_brand')) {
            $this->markTestSkipped('No product_brand taxonomy.');
        }

        $saga = wp_insert_term('Saga', 'product_brand');
        $other = wp_insert_term('Other', 'product_brand');
        $this->assertIsArray($saga);
        $this->assertIsArray($other);

        $branded = $this->simpleProduct()->get_id();
        $otherBrand = $this->simpleProduct()->get_id();
        $this->simpleProduct();
        wp_set_object_terms($branded, [(int) $saga['term_id']], 'product_brand');
        wp_set_object_terms($otherBrand, [(int) $other['term_id']], 'product_brand');

        $this->assertSame([$branded], $this->ids(['brand' => (string) $saga['term_id']]));
        $this->assertEqualsCanonicalizing([$branded, $otherBrand], $this->ids(['brand' => $saga['term_id'].','.$other['term_id']]));
    }

    public function test_exclude_category_and_tag(): void
    {
        $boots = wp_insert_term('Boots', 'product_cat');
        $sale = wp_insert_term('Sale', 'product_tag');
        $this->assertIsArray($boots);
        $this->assertIsArray($sale);

        $boot = $this->simpleProduct()->get_id();
        $tagged = $this->simpleProduct()->get_id();
        $plain = $this->simpleProduct()->get_id();
        wp_set_object_terms($boot, [(int) $boots['term_id']], 'product_cat');
        wp_set_object_terms($tagged, [(int) $sale['term_id']], 'product_tag');

        $this->assertEqualsCanonicalizing([$tagged, $plain], $this->ids(['exclude_category' => (string) $boots['term_id']]));
        $this->assertEqualsCanonicalizing([$boot, $plain], $this->ids(['exclude_tag' => [$sale['term_id']]]));
        $this->assertSame([$plain], $this->ids(['exclude_category' => (string) $boots['term_id'], 'exclude_tag' => (string) $sale['term_id']]));
    }

    public function test_stock_quantity_range_uses_the_lookup_table(): void
    {
        $none = $this->simpleProduct()->get_id();
        $low = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 2])->get_id();
        $mid = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 10])->get_id();
        $high = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 50])->get_id();

        $this->assertEqualsCanonicalizing([$mid, $high], $this->ids(['min_stock_quantity' => 10]));
        $this->assertEqualsCanonicalizing([$low, $mid], $this->ids(['max_stock_quantity' => 10]));
        $this->assertSame([$mid], $this->ids(['min_stock_quantity' => 5, 'max_stock_quantity' => 20]));
        $this->assertSame([$low], $this->ids(['max_stock_quantity' => '2.5']));
        $this->assertNotContains($none, $this->ids(['min_stock_quantity' => 0]));
    }

    public function test_has_variations(): void
    {
        $variable = $this->variableProduct(['38', '39'])->get_id();
        $childless = $this->variableProduct([])->get_id();
        $simple = $this->simpleProduct()->get_id();

        $this->assertSame([$variable], $this->ids(['has_variations' => 'true']));
        $this->assertEqualsCanonicalizing([$childless, $simple], $this->ids(['has_variations' => 'false']));
        $this->assertEqualsCanonicalizing([$variable, $childless, $simple], $this->ids([]));
    }

    public function test_sale_scheduled_finds_products_and_parents_with_a_future_sale(): void
    {
        $nextWeek = (string) (time() + WEEK_IN_SECONDS);
        $lastWeek = (string) (time() - WEEK_IN_SECONDS);

        $scheduled = $this->simpleProduct(['sale_price' => '149', 'date_on_sale_from' => $nextWeek])->get_id();
        $running = $this->simpleProduct(['sale_price' => '149', 'date_on_sale_from' => $lastWeek])->get_id();
        $datesOnly = $this->simpleProduct(['date_on_sale_from' => $nextWeek])->get_id();
        $plain = $this->simpleProduct()->get_id();

        $variable = $this->variableProduct(['38', '39']);
        $variations = $variable->get_children();
        $scheduledVariation = wc_get_product($variations[0]);
        $scheduledVariation->set_sale_price('99');
        $scheduledVariation->set_date_on_sale_from($nextWeek);
        $scheduledVariation->save();
        $untouched = $this->variableProduct(['38'])->get_id();

        $this->assertEqualsCanonicalizing([$scheduled, $variable->get_id()], $this->ids(['sale_scheduled' => 'true']));
        $this->assertEqualsCanonicalizing([$running, $datesOnly, $plain, $untouched], $this->ids(['sale_scheduled' => 'false']));

        // The variations route filters on the variation's own sale.
        $response = $this->request('GET', "/wc/v3/products/{$variable->get_id()}/variations", ['_fields' => 'id', 'sale_scheduled' => 'true'], [ListMode::HEADER => '1']);
        $this->assertStatus(200, $response);
        $this->assertSame([$variations[0]], array_map('intval', array_column($this->data($response), 'id')));

        // Outside list mode the parameter is unknown and ignored.
        $this->assertCount(6, $this->ids(['sale_scheduled' => 'true'], [ListMode::HEADER => '']));
    }

    public function test_orderby_sku_stock_quantity_and_menu_order(): void
    {
        $b = $this->simpleProduct(['sku' => 'B-2', 'manage_stock' => true, 'stock_quantity' => 20, 'menu_order' => 3])->get_id();
        $c = $this->simpleProduct(['sku' => 'C-3', 'manage_stock' => true, 'stock_quantity' => 5, 'menu_order' => 1])->get_id();
        $a = $this->simpleProduct(['sku' => 'A-1', 'manage_stock' => true, 'stock_quantity' => 10, 'menu_order' => 2])->get_id();

        $this->assertSame([$a, $b, $c], $this->ids(['orderby' => 'sku', 'order' => 'asc']));
        $this->assertSame([$c, $b, $a], $this->ids(['orderby' => 'sku', 'order' => 'desc']));
        $this->assertSame([$c, $a, $b], $this->ids(['orderby' => 'stock_quantity', 'order' => 'asc']));
        $this->assertSame([$b, $a, $c], $this->ids(['orderby' => 'stock_quantity', 'order' => 'desc']));
        $this->assertSame([$c, $a, $b], $this->ids(['orderby' => 'menu_order', 'order' => 'asc']));
    }

    public function test_sku_ordering_combines_with_a_sku_search(): void
    {
        // The SKU search joins the lookup table itself; the ordering must
        // reuse that join rather than add a second one.
        $b = $this->simpleProduct(['sku' => 'ZZ-B'])->get_id();
        $a = $this->simpleProduct(['sku' => 'ZZ-A'])->get_id();
        $this->simpleProduct(['sku' => 'QQ-1']);

        $this->assertSame([$a, $b], $this->ids(['search_name_or_sku' => 'ZZ-', 'orderby' => 'sku', 'order' => 'asc']));
        $this->assertSame([$b, $a], $this->ids(['search_name_or_sku' => 'ZZ-', 'orderby' => 'sku', 'order' => 'desc']));
    }

    public function test_search_matches_name_or_sku_tokens_on_parents_only(): void
    {
        $simple = $this->simpleProduct(['sku' => 'TOKEN-SIMPLE', 'name' => 'Nordic sandal'])->get_id();
        $variable = $this->variableProduct(['38', '39']);
        $variationId = $variable->get_children()[0];
        $variation = wc_get_product($variationId);
        $variation->set_sku('TOKEN-VAR-38');
        $variation->save();
        $this->simpleProduct(['sku' => 'OTHER', 'name' => 'Plain loafer']);

        // A variation's SKU finds its parent; the variation itself is never a row.
        $this->assertSame([$variable->get_id()], $this->ids(['search_name_or_sku' => 'TOKEN-VAR']));

        // Tokens AND together, each across name and SKU.
        $this->assertSame([$simple], $this->ids(['search_name_or_sku' => 'Nordic TOKEN']));
        $this->assertSame([], $this->ids(['search_name_or_sku' => 'Nordic TOKEN-VAR']));
        $this->assertEqualsCanonicalizing([$simple, $variable->get_id()], $this->ids(['search_name_or_sku' => 'TOKEN']));
        $this->assertSame([$variable->get_id()], $this->ids(['search_name_or_sku' => 'wide toe']));

        // Without the header WooCommerce's own search lists the variation as a row.
        $this->assertContains($variationId, $this->ids(['search_name_or_sku' => 'TOKEN-VAR'], [ListMode::HEADER => '']));
    }

    public function test_list_mode_reads_skip_the_gallery(): void
    {
        // Attachment posts with a file path and mime type are all
        // wc/v3's image serialiser needs; no image library involved.
        $featured = self::factory()->attachment->create(['post_mime_type' => 'image/jpeg']);
        update_post_meta($featured, '_wp_attached_file', '2026/10/featured.jpg');
        $gallery = self::factory()->attachment->create(['post_mime_type' => 'image/jpeg']);
        update_post_meta($gallery, '_wp_attached_file', '2026/10/gallery.jpg');
        $id = $this->simpleProduct(['image_id' => $featured, 'gallery_image_ids' => [$gallery]])->get_id();

        $seen = [];
        add_filter(Rows::FILTER_ROW, static function (array $row, \WC_Product $product) use (&$seen): array {
            $seen[] = $product->get_gallery_image_ids();

            return $row;
        }, 10, 2);

        $data = $this->data($this->request('GET', '/wc/v3/products/'.$id));
        $this->assertSame([[]], $seen);
        $this->assertCount(1, $data['images']);
        $this->assertSame($featured, $data['images'][0]['id']);

        // Other consumers get the whole gallery.
        $data = $this->data($this->request('GET', '/wc/v3/products/'.$id, [], [ListMode::HEADER => '']));
        $this->assertCount(2, $data['images']);

        // A list-mode write neither sees nor loses the gallery.
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$id, ['name' => 'Renamed']));
        $this->assertSame([$gallery], wc_get_product($id)->get_gallery_image_ids('edit'));

        // No featured image: the first gallery image stands in, as everywhere else.
        $second = self::factory()->attachment->create(['post_mime_type' => 'image/jpeg']);
        update_post_meta($second, '_wp_attached_file', '2026/10/second.jpg');
        $bare = $this->simpleProduct(['gallery_image_ids' => [$gallery, $second]])->get_id();
        $data = $this->data($this->request('GET', '/wc/v3/products/'.$bare));
        $this->assertSame([$gallery], array_column($data['images'], 'id'));
    }

    public function test_product_query_args_filter_runs_last_and_only_in_list_mode(): void
    {
        $keep = $this->simpleProduct()->get_id();
        $this->simpleProduct();
        $calls = 0;

        add_filter(ListQuery::FILTER_PRODUCT_ARGS, function (array $args, \WP_REST_Request $request) use ($keep, &$calls): array {
            $calls++;
            $this->assertSame('all', $request['tab']);
            $this->assertSame(['publish', 'future', 'draft', 'pending', 'private'], $request['include_status']);
            $args['post__in'] = [$keep];

            return $args;
        }, 10, 2);

        $this->assertSame([$keep], $this->ids(['tab' => 'all']));
        $this->assertSame(1, $calls);

        $this->assertCount(2, $this->ids(['tab' => 'all'], [ListMode::HEADER => '']));
        $this->assertSame(1, $calls);
    }

    public function test_rows_carry_the_list_data_and_respect_fields(): void
    {
        $simple = $this->simpleProduct();
        $variable = $this->variableProduct(['38', '39', '40']);

        $response = $this->request('GET', '/wc/v3/products', ['include' => [$simple->get_id(), $variable->get_id()], 'orderby' => 'include']);
        $this->assertStatus(200, $response);
        [$simpleRow, $variableRow] = $this->data($response);

        $this->assertSame([
            'variation_count' => 0,
            'edit_link' => get_edit_post_link($simple->get_id(), 'raw'),
            'can_edit' => true,
            'can_delete' => true,
            'parent_id' => 0,
        ], $simpleRow[Rows::KEY]);
        $this->assertSame(3, $variableRow[Rows::KEY]['variation_count']);
        $this->assertSame('variable', $variableRow['type']);

        // Trimmed to the fields the app asks for.
        $fields = 'id,name,wc_products_list.can_edit';
        $response = $this->request('GET', '/wc/v3/products', ['include' => [$simple->get_id()], '_fields' => $fields]);
        $row = $this->trimmed($response, $fields)[0];
        $this->assertSame(['id', 'name', Rows::KEY], array_values(array_diff(array_keys($row), ['_links'])));
        $this->assertSame(['can_edit' => true], $row[Rows::KEY]);

        $response = $this->request('GET', '/wc/v3/products', ['include' => [$simple->get_id()], '_fields' => 'id,sku']);
        $this->assertArrayNotHasKey(Rows::KEY, $this->data($response)[0]);

        // Not a list request: nothing added.
        $response = $this->request('GET', '/wc/v3/products', ['include' => [$simple->get_id()]], [ListMode::HEADER => '']);
        $this->assertArrayNotHasKey(Rows::KEY, $this->data($response)[0]);
    }

    public function test_row_filter_sees_the_product_and_can_check_fields(): void
    {
        $product = $this->simpleProduct(['sku' => 'ROW-1']);

        add_filter(Rows::FILTER_ROW, function (array $row, \WC_Product $object, \WP_REST_Request $request): array {
            $this->assertArrayHasKey(Rows::KEY, $row);

            if (Rows::includes('i18n', $request)) {
                $row['i18n'] = ['se' => ['name' => ['value' => '', 'source' => $object->get_name()]]];
            }

            return $row;
        }, 10, 3);

        $fields = 'id,i18n.se,wc_products_list';
        $response = $this->request('GET', '/wc/v3/products', ['include' => [$product->get_id()], '_fields' => $fields]);
        $row = $this->trimmed($response, $fields)[0];
        $this->assertSame('Saga wide toe boot', $row['i18n']['se']['name']['source']);
        $this->assertSame(['id', Rows::KEY, 'i18n'], array_values(array_diff(array_keys($row), ['_links'])));

        $response = $this->request('GET', '/wc/v3/products', ['include' => [$product->get_id()], '_fields' => 'id,wc_products_list']);
        $this->assertArrayNotHasKey('i18n', $this->data($response)[0]);
    }

    /**
     * WooCommerce Brands adds `brands` to every product response with a
     * query per product that ignores the term cache and `_fields`; in list
     * mode the plugin's callback respects both.
     */
    public function test_brands_are_not_queried_per_row_unless_asked(): void
    {
        if (! taxonomy_exists('product_brand') || ! class_exists(\WC_Brands::class)) {
            $this->markTestSkipped('WooCommerce Brands is not loaded.');
        }

        $brand = wp_insert_term('Saga', 'product_brand');
        $this->assertIsArray($brand);
        $ids = [];

        for ($i = 0; $i < 3; $i++) {
            $product = $this->simpleProduct(['sku' => 'BRAND-'.$i]);
            wp_set_object_terms($product->get_id(), [$brand['term_id']], 'product_brand');
            $ids[] = $product->get_id();
        }

        $perRow = static fn (string $query): bool => (bool) preg_match('/taxonomy IN \(\'product_brand\'\)/', $query);
        $seen = [];
        add_filter('query', static function (string $query) use (&$seen, $perRow): string {
            if ($perRow($query)) {
                $seen[] = $query;
            }

            return $query;
        });

        // Not asked for: no key, no query.
        $response = $this->request('GET', '/wc/v3/products', ['include' => $ids, '_fields' => 'id,name']);
        $this->assertStatus(200, $response);
        $this->assertSame([], $seen);
        $this->assertArrayNotHasKey('brands', $this->data($response)[0]);

        // Asked for: names from the terms the list query primed.
        $seen = [];
        $response = $this->request('GET', '/wc/v3/products', ['include' => $ids, '_fields' => 'id,brands']);
        $this->assertStatus(200, $response);
        $this->assertSame([], $seen);

        foreach ($this->data($response) as $row) {
            $this->assertSame([['id' => $brand['term_id'], 'name' => 'Saga', 'slug' => 'saga']], $row['brands']);
        }

        // Outside list mode WooCommerce's own callback still answers.
        $response = $this->request('GET', '/wc/v3/products', ['include' => $ids, '_fields' => 'id,brands'], [ListMode::HEADER => '']);
        $this->assertStatus(200, $response);
        $this->assertSame('Saga', $this->data($response)[0]['brands'][0]['name']);
    }

    public function test_capabilities_follow_the_user(): void
    {
        $product = $this->simpleProduct();

        $this->actAs('shop_manager');
        $response = $this->request('GET', '/wc/v3/products', ['include' => [$product->get_id()], '_fields' => 'id,wc_products_list']);
        $this->assertStatus(200, $response);
        $this->assertTrue($this->data($response)[0][Rows::KEY]['can_edit']);
        $this->assertTrue($this->data($response)[0][Rows::KEY]['can_delete']);
    }
}
