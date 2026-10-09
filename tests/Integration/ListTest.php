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

    public function test_variable_rows_summarise_their_variations_stock_and_sales(): void
    {
        $sizes = array_map('strval', range(30, 45));
        $variable = $this->variableProduct($sizes);
        $children = $variable->get_children();
        $this->assertCount(16, $children);

        $from = strtotime('2026-12-12 00:00:00 UTC');
        $to = strtotime('2026-12-18 23:59:00 UTC');

        foreach ($children as $index => $id) {
            $variation = wc_get_product($id);

            if ($index < 4) {
                $variation->set_stock_status('outofstock');
            }

            if ($index < 12) {
                $variation->set_sale_price('99');
                $variation->set_date_on_sale_from((string) $from);
                $variation->set_date_on_sale_to((string) $to);
            }

            $variation->save();
        }

        $plain = $this->variableProduct(['38'])->get_id();
        $simple = $this->simpleProduct(['stock_status' => 'outofstock'])->get_id();

        global $wpdb;
        $queries = 0;
        $count = static function (string $query) use (&$queries, $wpdb): string {
            if (str_contains($query, 'GROUP BY v.post_parent') && str_contains($query, $wpdb->wc_product_meta_lookup)) {
                $queries++;
            }

            return $query;
        };
        add_filter('query', $count);
        $response = $this->request('GET', '/wc/v3/products', ['include' => [$variable->get_id(), $plain, $simple], 'orderby' => 'include', '_fields' => 'id,wc_products_list']);
        remove_filter('query', $count);
        $this->assertStatus(200, $response);
        $this->assertSame(1, $queries, 'one summary query per page');

        $rows = array_column($this->data($response), Rows::KEY, 'id');
        $this->assertSame(['out_of_stock' => 4, 'total' => 16], $rows[$variable->get_id()]['variation_stock']);
        $this->assertSame(0, $rows[$variable->get_id()]['sale_summary']['on_sale']);
        $this->assertSame(12, $rows[$variable->get_id()]['sale_summary']['scheduled']);
        $timezone = wp_timezone();
        $this->assertSame((new \DateTimeImmutable('@'.$from))->setTimezone($timezone)->format('Y-m-d\\TH:i:s'), $rows[$variable->get_id()]['sale_summary']['from']);
        $this->assertSame((new \DateTimeImmutable('@'.$to))->setTimezone($timezone)->format('Y-m-d\\TH:i:s'), $rows[$variable->get_id()]['sale_summary']['to']);
        $this->assertSame(['out_of_stock' => 0, 'total' => 1], $rows[$plain]['variation_stock']);
        $this->assertSame(['on_sale' => 0, 'scheduled' => 0, 'from' => null, 'to' => null], $rows[$plain]['sale_summary']);
        $this->assertArrayNotHasKey('variation_stock', $rows[$simple]);

        // A running sale counts as on sale, not scheduled.
        $running = wc_get_product($children[0]);
        $running->set_date_on_sale_from((string) (time() - DAY_IN_SECONDS));
        $running->save();
        $row = $this->data($this->request('GET', '/wc/v3/products', ['include' => [$variable->get_id()], '_fields' => 'id,wc_products_list']))[0][Rows::KEY];
        $this->assertSame(1, $row['sale_summary']['on_sale']);
        $this->assertSame(11, $row['sale_summary']['scheduled']);

        // The restock list: parents with an out-of-stock variation.
        $this->assertSame([$variable->get_id()], $this->ids(['variation_stock_status' => 'outofstock']));
        $this->assertEqualsCanonicalizing([$variable->get_id(), $plain], $this->ids(['variation_stock_status' => 'instock']));
        $this->assertStatus(400, $this->request('GET', '/wc/v3/products', ['variation_stock_status' => 'gone']));
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

    public function test_orderby_post_status_groups_the_all_tab(): void
    {
        $draft = $this->simpleProduct(['status' => 'draft'])->get_id();
        $published = $this->simpleProduct(['status' => 'publish'])->get_id();
        $private = $this->simpleProduct(['status' => 'private'])->get_id();

        $this->assertSame([$draft, $private, $published], $this->ids(['tab' => 'all', 'orderby' => 'post_status', 'order' => 'asc']));
        $this->assertSame([$published, $private, $draft], $this->ids(['tab' => 'all', 'orderby' => 'post_status', 'order' => 'desc']));
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

    public function test_search_finds_a_parent_by_a_variation_attribute_value(): void
    {
        $variable = $this->variableProduct(['38', '39']);
        $variationId = $variable->get_children()[0];
        // WooCommerce titles a variation "Parent - Attribute values".
        wp_update_post(['ID' => $variationId, 'post_title' => $variable->get_name().' - Black with wool, 38']);
        $this->simpleProduct(['name' => 'Plain loafer']);

        $this->assertSame([$variable->get_id()], $this->ids(['search_name_or_sku' => 'Black with wool']));
        $this->assertSame([$variable->get_id()], $this->ids(['search_name_or_sku' => 'wool']));
        $this->assertSame([], $this->ids(['search_name_or_sku' => 'wool loafer']));
    }

    public function test_searched_rows_tell_a_variation_sku_match_from_a_name_match(): void
    {
        $bySku = $this->variableProduct(['38', '39']);
        $variation = wc_get_product($bySku->get_children()[0]);
        $variation->set_sku('SCAN-8434550670741');
        $variation->save();
        $byName = $this->variableProduct(['38', '39']);
        wp_update_post(['ID' => $byName->get_children()[0], 'post_title' => $byName->get_name().' - Black x SCAN, 38']);

        $rows = fn (string $search): array => array_column($this->data($this->request('GET', '/wc/v3/products', ['search_name_or_sku' => $search, 'per_page' => 100, '_fields' => 'id,wc_products_list'])), Rows::KEY, 'id');

        // Both parents are found; only the SKU match is worth expanding.
        $found = $rows('scan');
        $this->assertTrue($found[$bySku->get_id()]['variation_sku_match']);
        $this->assertFalse($found[$byName->get_id()]['variation_sku_match']);

        // Without a search the rows carry no flag.
        $all = $rows('');
        $this->assertArrayNotHasKey('variation_sku_match', $all[$bySku->get_id()]);
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

        // A list-mode write answers with the list's row (featured image
        // only) and does not lose the gallery.
        $response = $this->request('PUT', '/wc/v3/products/'.$id, ['name' => 'Renamed']);
        $this->assertStatus(200, $response);
        $this->assertSame([$featured], array_column($this->data($response)['images'], 'id'));
        $this->assertSame([$gallery], wc_get_product($id)->get_gallery_image_ids('edit'));

        // Batch writes too: `images` is among the row fields of every save.
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $id, 'name' => 'Renamed again']]], [], ['fields' => 'id,name,images']);
        $this->assertStatus(200, $response);
        $this->assertSame([$featured], array_column($this->data($response)['update'][0]['images'], 'id'));
        $this->assertSame([$gallery], wc_get_product($id)->get_gallery_image_ids('edit'));

        // A write that sets the gallery is stored, answered and logged in full.
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $id, 'images' => [['id' => $featured], ['id' => $gallery], ['id' => $featured]]]]], [], ['fields' => 'id,images']);
        $this->assertStatus(200, $response);
        $this->assertSame([$featured, $gallery, $featured], array_column($this->data($response)['update'][0]['images'], 'id'));
        $this->assertSame([$gallery, $featured], wc_get_product($id)->get_gallery_image_ids('edit'));
        $log = $this->data($this->request('GET', '/wc-products-list/v1/log', ['object_id' => $id, 'field' => 'images']));
        $this->assertCount(1, $log['items']);
        $this->assertSame([['id' => $featured], ['id' => $gallery]], json_decode($log['items'][0]['old_value'], true));
        $this->assertSame([['id' => $featured], ['id' => $gallery], ['id' => $featured]], json_decode($log['items'][0]['new_value'], true));

        // No featured image: the first gallery image stands in, as everywhere else.
        $second = self::factory()->attachment->create(['post_mime_type' => 'image/jpeg']);
        update_post_meta($second, '_wp_attached_file', '2026/10/second.jpg');
        $bare = $this->simpleProduct(['gallery_image_ids' => [$gallery, $second]])->get_id();
        $data = $this->data($this->request('GET', '/wc/v3/products/'.$bare));
        $this->assertSame([$gallery], array_column($data['images'], 'id'));
    }

    public function test_list_mode_writes_keep_the_gallery_for_save_listeners(): void
    {
        $featured = self::factory()->attachment->create(['post_mime_type' => 'image/jpeg']);
        update_post_meta($featured, '_wp_attached_file', '2026/10/featured.jpg');
        $gallery = [];

        foreach (['a', 'b'] as $name) {
            $gallery[] = $attachment = self::factory()->attachment->create(['post_mime_type' => 'image/jpeg']);
            update_post_meta($attachment, '_wp_attached_file', '2026/10/'.$name.'.jpg');
        }

        $id = $this->simpleProduct(['image_id' => $featured, 'gallery_image_ids' => $gallery])->get_id();

        // An ERP / feed sync that reads the gallery while the product is saved.
        $seen = [];
        $listener = static function (int $productId) use (&$seen, $id): void {
            if ($productId === $id) {
                $seen[] = wc_get_product($productId)->get_gallery_image_ids();
            }
        };
        add_action('woocommerce_update_product', $listener);
        $inserted = [];
        $insert = static function (\WC_Product $product) use (&$inserted): void {
            $inserted[] = $product->get_gallery_image_ids();
        };
        add_action('woocommerce_rest_insert_product_object', $insert);

        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $id, 'menu_order' => 7]]], [], ['fields' => 'id,images']);
        $this->assertStatus(200, $response);
        $this->assertNotEmpty($seen);
        $this->assertSame([$gallery], array_unique($seen, SORT_REGULAR));
        $this->assertSame([$gallery], $inserted);
        // The response row is still the list's: featured image only.
        $this->assertSame([$featured], array_column($this->data($response)['update'][0]['images'], 'id'));

        // Actions save outside the wc/v3 controllers: the gallery is whole there too.
        $seen = [];
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/feature', ['ids' => [$id], 'args' => ['featured' => true]]));
        $this->assertNotEmpty($seen);
        $this->assertSame([$gallery], array_unique($seen, SORT_REGULAR));

        remove_action('woocommerce_update_product', $listener);
        remove_action('woocommerce_rest_insert_product_object', $insert);
        $this->assertSame($gallery, wc_get_product($id)->get_gallery_image_ids());
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

    /**
     * The query budget of a list page with the default view's columns.
     * Pinned so a per-row query (terms, brands, gallery, children) shows
     * up here before it shows up in the dev audit.
     */
    /**
     * WooCommerce computes the variation price hash (our priming hook)
     * before it reads its price transient, and loads the variations only
     * on a miss. With warm transients a list page must not load a single
     * variation, whatever the sort order, and must read the page's
     * transients in one query rather than one per variable product.
     */
    public function test_a_warm_price_cache_loads_no_variation_on_a_list_page(): void
    {
        global $wpdb;

        $parents = [];
        $children = [];

        for ($i = 0; $i < 6; $i++) {
            $parent = $this->variableProduct(['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'], ['sku' => 'W'.$i]);
            $parents[] = $parent->get_id();
            $children = array_merge($children, array_map('intval', $parent->get_children()));
        }

        $this->assertCount(60, $children);

        // Warm WooCommerce's caches the way a storefront visit does.
        foreach ($parents as $id) {
            $product = wc_get_product($id);
            $this->assertNotSame([], $product->get_variation_prices()['price']);
            $this->assertTrue(Rows::pricesCached($product));
        }

        wp_cache_flush();

        $seen = [];
        $transientReads = 0;
        $filter = static function (string $query) use (&$seen, &$transientReads, $children, $wpdb): string {
            if (preg_match('/SELECT\s+'.preg_quote($wpdb->posts, '/').'\.\*\s+FROM\s+'.preg_quote($wpdb->posts, '/').'\s+WHERE\s+ID\s+IN\s*\(([^)]*)\)/i', $query, $m)) {
                $ids = array_map('intval', explode(',', $m[1]));

                if (array_intersect($ids, $children) !== []) {
                    $seen[] = $query;
                }
            }

            if (str_contains($query, '_transient_wc_var_prices_')) {
                $transientReads++;
            }

            return $query;
        };

        add_filter('query', $filter);
        $response = $this->request('GET', '/wc/v3/products', [
            'per_page' => 100,
            'tab' => 'all',
            'orderby' => 'title',
            'order' => 'asc',
            '_fields' => 'id,name,type,status,sku,price,regular_price,sale_price,price_html,on_sale,stock_status,images,wc_products_list',
        ]);
        remove_filter('query', $filter);

        $this->assertStatus(200, $response);
        $data = $this->data($response);
        $this->assertCount(6, $data);
        $this->assertSame([], $seen, 'Variations were loaded on a list page with a warm price cache: '.implode("\n", $seen));
        $this->assertSame(1, $transientReads, 'The page\'s price and children transients are read in one query');

        foreach ($data as $row) {
            $this->assertSame(10, $row['wc_products_list']['variation_count']);
            // The price range came from the transient.
            $this->assertStringContainsString('189', $row['price_html']);
            $this->assertFalse($row['on_sale']);
        }

        // Cold: the price is computed from the variations, which are loaded in bulk.
        foreach ($parents as $id) {
            delete_transient('wc_var_prices_'.$id);
        }

        wp_cache_flush();
        $before = $wpdb->num_queries;
        $response = $this->request('GET', '/wc/v3/products', ['per_page' => 100, 'tab' => 'all', 'orderby' => 'title', '_fields' => 'id,price_html,wc_products_list']);
        $this->assertStatus(200, $response);

        foreach ($this->data($response) as $row) {
            $this->assertStringContainsString('189', $row['price_html']);
        }

        $this->assertLessThan(60, $wpdb->num_queries - $before, 'A cold price cache loads the variations in a few queries per parent, not per variation');
    }

    public function test_a_list_page_stays_within_the_query_budget(): void
    {
        global $wpdb;

        $boots = wp_insert_term('Boots', 'product_cat');
        $this->assertIsArray($boots);

        for ($i = 0; $i < 10; $i++) {
            $this->simpleProduct(['sku' => 'S'.$i, 'category_ids' => [(int) $boots['term_id']]]);
            $this->variableProduct(['38', '39'], ['sku' => 'V'.$i]);
        }

        wp_cache_flush();

        $before = $wpdb->num_queries;
        $response = $this->request('GET', '/wc/v3/products', [
            'per_page' => 100,
            'tab' => 'all',
            'orderby' => 'date',
            'image_size' => 'thumbnail',
            '_fields' => 'id,name,type,status,sku,price,regular_price,sale_price,date_on_sale_from,date_on_sale_to,stock_status,stock_quantity,manage_stock,categories,images,date_modified,featured,parent_id,wc_products_list',
        ]);
        $this->assertStatus(200, $response);
        $this->assertCount(20, $this->data($response));

        $queries = $wpdb->num_queries - $before;
        $this->assertLessThanOrEqual(20 * 2 + 40, $queries, "{$queries} queries for 20 products");
    }
}
