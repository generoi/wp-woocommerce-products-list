<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\BatchState;
use GeneroWP\ProductsList\Log\Logger;
use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Log\Table;
use GeneroWP\ProductsList\Rest\Concurrency;
use GeneroWP\ProductsList\Rest\LogController;

/**
 * Server-side protection against concurrent edits (docs/contracts.md §3.6):
 * expected values, the per-object lock, fresh loads under a primed batch,
 * the Trash, the revert lock and the running-batch marker.
 */
class ConcurrencyTest extends RestTestCase
{
    /** @var \mysqli|null a second database connection: "another PHP process" */
    private ?\mysqli $other = null;

    public function tear_down(): void
    {
        if ($this->other !== null) {
            $this->other->close();
            $this->other = null;
        }

        Concurrency::unlockObjects();

        parent::tear_down();
    }

    /**
     * Another process: its own connection, outside this test's transaction.
     */
    private function other(): \mysqli
    {
        return $this->other ??= new \mysqli(DB_HOST, DB_USER, DB_PASSWORD, DB_NAME);
    }

    /**
     * Write a meta value straight to the database, the way another PHP
     * process would: this request's caches still hold the old value.
     */
    private function writeBehindTheCache(int $id, string $key, string $value): void
    {
        global $wpdb;

        $wpdb->update($wpdb->postmeta, ['meta_value' => $value], ['post_id' => $id, 'meta_key' => $key]);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function rows(?string $batch = null): array
    {
        global $wpdb;

        $table = Table::name();

        return $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE batch_id = %s ORDER BY id ASC", $batch ?? $this->batchId()), ARRAY_A); // phpcs:ignore
    }

    public function test_a_quick_edit_with_a_stale_expected_value_is_refused_and_logged_as_skipped(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        $id = $product->get_id();
        // Another tab changed the price after this editor loaded 15.
        update_post_meta($id, '_regular_price', '20');
        clean_post_cache($id);

        $response = $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '10', Concurrency::EXPECT_KEY => ['regular_price' => '15']]);

        $this->assertStatus(409, $response);
        $data = $this->data($response);
        $this->assertSame(Concurrency::CONFLICT_ERROR, $data['code']);
        $this->assertSame(['regular_price'], $data['data']['fields']);
        $this->assertSame(['regular_price' => '20'], $data['data']['current']);
        $this->assertSame('20', get_post_meta($id, '_regular_price', true));

        $rows = $this->rows();
        $this->assertCount(1, $rows);
        $this->assertSame(Logger::STATUS_SKIPPED, $rows[0]['status']);
        $this->assertSame('regular_price', $rows[0]['field']);
        $this->assertSame('conflict', json_decode((string) $rows[0]['context'], true)['reason']);
        $this->assertSame([], Concurrency::heldObjects(), 'the lock is released');
    }

    public function test_matching_expected_values_save_and_are_not_logged_as_fields(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $term = wp_insert_term('Boots', 'product_cat');

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id(), [
            'categories' => [['id' => $term['term_id']]],
        ]));
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id().'/variations/'.$v38, [
            // "189.00" is 189; the list sent its loaded row, names and all.
            'sale_price' => '99',
            Concurrency::EXPECT_KEY => ['regular_price' => '189.00', 'sale_price' => ''],
        ]));
        $this->assertSame('99', wc_get_product($v38)->get_sale_price());

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id(), [
            'name' => 'Renamed',
            Concurrency::EXPECT_KEY => ['categories' => [['id' => $term['term_id'], 'name' => 'Boots', 'slug' => 'boots']]],
        ]));
        $this->assertSame('Renamed', get_post($parent->get_id())->post_title);
        $this->assertNotContains(Concurrency::EXPECT_KEY, array_column($this->rows(), 'field'));
    }

    public function test_a_batch_refuses_only_the_item_that_changed(): void
    {
        $a = $this->simpleProduct(['regular_price' => '15']);
        $b = $this->simpleProduct(['regular_price' => '15']);
        update_post_meta($b->get_id(), '_regular_price', '30');
        clean_post_cache($b->get_id());

        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '12', Concurrency::EXPECT_KEY => ['regular_price' => '15']],
            ['id' => $b->get_id(), 'sale_price' => '12', Concurrency::EXPECT_KEY => ['regular_price' => '15']],
        ]], [Logger::SOURCE_HEADER => 'bulk']);

        $this->assertStatus(200, $response);
        $items = $this->data($response)['update'];
        $this->assertArrayNotHasKey('error', $items[0]);
        $this->assertSame(Concurrency::CONFLICT_ERROR, $items[1]['error']['code']);
        $this->assertSame('12', get_post_meta($a->get_id(), '_sale_price', true));
        $this->assertSame('', get_post_meta($b->get_id(), '_sale_price', true));
    }

    public function test_a_batch_item_is_saved_from_the_stored_state_not_the_primed_cache(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        [$v38, $v39] = $parent->get_children();

        foreach ([$v38, $v39] as $id) {
            $variation = wc_get_product($id);
            $variation->set_regular_price('15');
            $variation->save();
        }

        // Between the two items, another process lowers 39's regular price
        // to 10: the sale of 12 the batch then sets is not lower, and
        // WooCommerce must clear it (sale < regular), as it would have
        // with a fresh load.
        $hook = function ($object) use ($v38, $v39) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $v38) {
                $done = true;
                $this->writeBehindTheCache($v39, '_regular_price', '10');
            }

            return $object;
        };
        add_filter('woocommerce_rest_pre_insert_product_variation_object', $hook, 1);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', ['update' => [
            ['id' => $v38, 'sale_price' => '12'],
            ['id' => $v39, 'sale_price' => '12'],
        ]], [Logger::SOURCE_HEADER => 'bulk']));

        clean_post_cache($v39);
        $this->assertSame('10', get_post_meta($v39, '_regular_price', true));
        $this->assertSame('', get_post_meta($v39, '_sale_price', true), 'no sale at or above the regular price');
        $this->assertSame('10', get_post_meta($v39, '_price', true));
        $this->assertSame('12', get_post_meta($v38, '_sale_price', true));
    }

    /**
     * WooCommerce prepares a batch item against the cache primed at the
     * start of the batch. A requested value equal to that stale copy
     * records no change, but must still win over what another process
     * stored since, and be logged.
     */
    public function test_a_requested_value_equal_to_the_stale_copy_still_overwrites_the_stored_one(): void
    {
        $first = $this->simpleProduct();
        $flag = $this->simpleProduct(['manage_stock' => false]);
        $price = $this->simpleProduct(['regular_price' => '11']);
        $delta = $this->simpleProduct(['manage_stock' => true, 'stock_quantity' => 10]);

        add_filter('woocommerce_rest_pre_insert_product_object', function ($object) use ($first, $flag, $price, $delta) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $first->get_id()) {
                $done = true;
                $this->writeBehindTheCache($flag->get_id(), '_manage_stock', 'yes');
                $this->writeBehindTheCache($price->get_id(), '_regular_price', '9');
                $this->writeBehindTheCache($delta->get_id(), '_stock', '8');
            }

            return $object;
        }, 1);

        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $first->get_id(), 'sale_price' => '100'],
            ['id' => $flag->get_id(), 'manage_stock' => false],
            ['id' => $price->get_id(), 'regular_price' => '11'],
            ['id' => $delta->get_id(), 'inventory_delta' => -1],
        ]], [Logger::SOURCE_HEADER => 'bulk']);

        $this->assertStatus(200, $response);

        foreach ([$flag, $price, $delta] as $product) {
            Concurrency::forget($product->get_id());
        }

        $this->assertSame('no', get_post_meta($flag->get_id(), '_manage_stock', true));
        $this->assertSame('11', get_post_meta($price->get_id(), '_regular_price', true));
        $this->assertEquals(7, get_post_meta($delta->get_id(), '_stock', true), 'the delta is added to the stored quantity');

        $fields = [];

        foreach ($this->rows() as $row) {
            $fields[(int) $row['object_id']][] = $row['field'];
        }

        $this->assertContains('manage_stock', $fields[$flag->get_id()] ?? [], 'the overwrite is logged');
        $this->assertContains('regular_price', $fields[$price->get_id()] ?? [], 'the overwrite is logged');
    }

    public function test_a_trashed_product_is_not_written_unless_the_request_restores_it(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        wp_trash_post($product->get_id());

        $response = $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '99']);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::TRASHED_ERROR, $this->data($response)['code']);
        $this->assertSame('15', get_post_meta($product->get_id(), '_regular_price', true));
        $this->assertSame('trashed', json_decode((string) $this->rows()[0]['context'], true)['reason']);

        $batch = $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'regular_price' => '99']]]);
        $this->assertSame(Concurrency::TRASHED_ERROR, $this->data($batch)['update'][0]['error']['code']);

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['status' => 'draft', 'regular_price' => '99']));
        $this->assertSame('99', get_post_meta($product->get_id(), '_regular_price', true));
    }

    public function test_a_save_waits_for_and_then_gives_up_on_another_save_of_the_object(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        add_filter(Concurrency::FILTER_LOCK_TIMEOUT, static fn (): int => 0);

        $name = Concurrency::lockName('o', (string) $product->get_id());
        $this->assertSame('1', (string) $this->other()->query("SELECT GET_LOCK('{$name}', 0)")->fetch_row()[0]);

        $response = $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '20']);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::LOCKED_ERROR, $this->data($response)['code']);
        $this->assertSame('15', get_post_meta($product->get_id(), '_regular_price', true));
        $this->assertSame('locked', json_decode((string) $this->rows()[0]['context'], true)['reason']);

        $this->other()->query("SELECT RELEASE_LOCK('{$name}')");
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['regular_price' => '20'], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame('20', get_post_meta($product->get_id(), '_regular_price', true));
        $this->assertSame([], Concurrency::heldObjects());
    }

    /**
     * Delete a row the way another process would: gone from the database,
     * still in this request's caches.
     */
    private function deleteBehindTheCache(int $id): void
    {
        global $wpdb;

        $wpdb->delete($wpdb->posts, ['ID' => $id]);
        $wpdb->delete($wpdb->postmeta, ['post_id' => $id]);
        $wpdb->delete($wpdb->wc_product_meta_lookup, ['product_id' => $id]);
    }

    private function metaRows(int $id): int
    {
        global $wpdb;

        return (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE post_id = %d", $id));
    }

    private function lookupRows(int $id): int
    {
        global $wpdb;

        return (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->wc_product_meta_lookup} WHERE product_id = %d", $id));
    }

    public function test_a_variation_deleted_for_good_while_a_batch_runs_is_skipped_and_nothing_is_written_for_it(): void
    {
        $parent = $this->variableProduct(['38', '39', '40']);
        [$v38, $v39, $v40] = $parent->get_children();

        add_filter('woocommerce_rest_pre_insert_product_variation_object', function ($object) use ($v38, $v39) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $v38) {
                $done = true;
                $this->deleteBehindTheCache($v39);
            }

            return $object;
        }, 1);

        $response = $this->request('POST', '/wc/v3/products/'.$parent->get_id().'/variations/batch', ['update' => [
            ['id' => $v38, 'regular_price' => '12'],
            ['id' => $v39, 'regular_price' => '12'],
            ['id' => $v40, 'regular_price' => '12'],
        ]], [Logger::SOURCE_HEADER => 'bulk']);

        $this->assertStatus(200, $response);
        $items = $this->data($response)['update'];
        $this->assertSame(Concurrency::DELETED_ERROR, $items[1]['error']['code']);
        $this->assertArrayNotHasKey('error', $items[2], 'the rest of the batch carries on');
        $this->assertSame(0, $this->metaRows($v39), 'no orphan meta');
        $this->assertSame(0, $this->lookupRows($v39), 'no orphan lookup row');
        $this->assertSame('12', get_post_meta($v40, '_regular_price', true));

        $skipped = array_values(array_filter($this->rows(), static fn (array $row): bool => (int) $row['object_id'] === $v39));
        $this->assertNotEmpty($skipped);
        $this->assertSame(Logger::STATUS_SKIPPED, $skipped[0]['status']);
        $this->assertSame('deleted', json_decode((string) $skipped[0]['context'], true)['reason']);
        $this->assertSame([], Concurrency::heldObjects());
    }

    public function test_a_product_deleted_for_good_while_a_products_batch_runs_is_skipped(): void
    {
        $first = $this->simpleProduct(['regular_price' => '15']);
        $gone = $this->simpleProduct(['regular_price' => '15']);

        add_filter('woocommerce_rest_pre_insert_product_object', function ($object) use ($first, $gone) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $first->get_id()) {
                $done = true;
                $this->deleteBehindTheCache($gone->get_id());
            }

            return $object;
        }, 1);

        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $first->get_id(), 'regular_price' => '12'],
            ['id' => $gone->get_id(), 'regular_price' => '12'],
        ]], [Logger::SOURCE_HEADER => 'bulk']);

        $this->assertStatus(200, $response);
        $this->assertSame(Concurrency::DELETED_ERROR, $this->data($response)['update'][1]['error']['code']);
        $this->assertSame(0, $this->metaRows($gone->get_id()));
        $this->assertSame(0, $this->lookupRows($gone->get_id()));
        $this->assertSame('12', get_post_meta($first->get_id(), '_regular_price', true));
    }

    public function test_row_actions_wait_for_a_save_of_the_row_and_give_up_on_a_held_lock(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        add_filter(Concurrency::FILTER_LOCK_TIMEOUT, static fn (): int => 0);

        $name = Concurrency::lockName('o', (string) $product->get_id());
        $this->assertSame('1', (string) $this->other()->query("SELECT GET_LOCK('{$name}', 0)")->fetch_row()[0]);

        foreach (['trash', 'draft'] as $action) {
            $response = $this->request('POST', '/wc-products-list/v1/actions/'.$action, ['ids' => [$product->get_id()]]);
            $this->assertStatus(200, $response);
            $data = $this->data($response);
            $this->assertFalse($data['results'][0]['ok'], $action);
            $this->assertSame(Concurrency::LOCKED_ERROR, $data['results'][0]['code']);
            $row = $this->rows($data['batch_id'])[0];
            $this->assertSame(Logger::STATUS_SKIPPED, $row['status']);
            $this->assertSame('locked', json_decode((string) $row['context'], true)['reason']);
        }

        clean_post_cache($product->get_id());
        $this->assertSame('publish', get_post_status($product->get_id()));

        $this->other()->query("SELECT RELEASE_LOCK('{$name}')");
        $response = $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$product->get_id()]]);
        $this->assertTrue($this->data($response)['results'][0]['ok']);
        $this->assertSame('trash', get_post_status($product->get_id()));
        $this->assertSame([], Concurrency::heldObjects(), 'the action let its lock go');
    }

    public function test_expected_values_in_the_form_wc_v3_shows_them_match_the_stored_value(): void
    {
        // Cost of goods is a WooCommerce feature; its getters warn while it is off.
        update_option('woocommerce_feature_cost_of_goods_sold_enabled', 'yes');

        $product = $this->simpleProduct(['description' => "First line.\n\nSecond line.", 'short_description' => 'Short one.', 'image_id' => 0]);
        $id = $product->get_id();
        $image = self::factory()->attachment->create_object(['file' => 'a.jpg', 'post_mime_type' => 'image/jpeg', 'post_parent' => $id]);
        $gallery = self::factory()->attachment->create_object(['file' => 'b.jpg', 'post_mime_type' => 'image/jpeg', 'post_parent' => $id]);
        $product = wc_get_product($id);
        $product->set_image_id($image);
        $product->set_gallery_image_ids([$gallery]);
        $product->save();
        $stored = wc_get_product($id);

        $rendered = wpautop(do_shortcode("First line.\n\nSecond line."));
        $short = apply_filters('woocommerce_short_description', 'Short one.');

        foreach ([
            'description' => [$rendered, "First line.\n\nSecond line."],
            'short_description' => [$short, 'Short one.'],
            'images' => [wp_json_encode([['id' => $image]]), wp_json_encode([['id' => $image], ['id' => $gallery]])],
            'cost_of_goods_sold' => [wp_json_encode(['values' => [['defined_value' => 0, 'effective_value' => 0]], 'total_value' => 0]), '0'],
        ] as $path => $forms) {
            foreach ($forms as $form) {
                $this->assertSame([], Concurrency::conflicts($stored, [$path => $form]), $path.': '.$form);
            }
        }

        foreach ([
            'description' => '<p>Someone else wrote this.</p>',
            'short_description' => 'Another short one.',
            'images' => wp_json_encode([['id' => $gallery]]),
            'cost_of_goods_sold' => wp_json_encode(['values' => [['defined_value' => 4.5]]]),
        ] as $path => $value) {
            $this->assertArrayHasKey($path, Concurrency::conflicts($stored, [$path => $value]), $path);
        }

        $this->assertNull(Concurrency::cogsNumber('{"other":1}'));
        $this->assertSame(4.5, Concurrency::cogsNumber('{"value":"4.5"}'));
        $this->assertSame(7.0, Concurrency::cogsNumber('{"values":[{"defined_value":3},{"defined_value":4}]}'));
    }

    public function test_a_description_saved_by_someone_else_is_a_conflict_through_rest(): void
    {
        $product = $this->simpleProduct(['description' => 'Original.']);
        $id = $product->get_id();
        $loaded = wpautop(do_shortcode('Original.'));

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$id, ['description' => 'Mine.', Concurrency::EXPECT_KEY => ['description' => $loaded]]));
        $this->assertSame('Mine.', get_post($id)->post_content);

        // The other tab still has "Original." loaded.
        $response = $this->request('PUT', '/wc/v3/products/'.$id, ['description' => 'Theirs.', Concurrency::EXPECT_KEY => ['description' => $loaded]]);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::CONFLICT_ERROR, $this->data($response)['code']);
        clean_post_cache($id);
        $this->assertSame('Mine.', get_post($id)->post_content);
    }

    public function test_a_variation_name_matches_as_wc_v3_shows_it(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $variation = wc_get_product($v38);
        $this->assertInstanceOf(\WC_Product_Variation::class, $variation);
        $summary = wc_get_formatted_variation($variation, true, false, false);

        $this->assertSame([], Concurrency::conflicts($variation, ['name' => $summary]));
        $this->assertSame([], Concurrency::conflicts($variation, ['name' => $variation->get_name('edit')]));
        $this->assertArrayHasKey('name', Concurrency::conflicts($variation, ['name' => 'Size: 99']));
    }

    public function test_attribute_lists_match_in_the_stored_or_the_wc_v3_form_and_not_by_ids_alone(): void
    {
        $attributeId = wc_create_attribute(['name' => 'Colour', 'slug' => 'colour']);
        $this->assertIsInt($attributeId);
        register_taxonomy('pa_colour', ['product', 'product_variation']);
        $blue = wp_insert_term('Light blue', 'pa_colour', ['slug' => 'light-blue']);
        $red = wp_insert_term('Red', 'pa_colour', ['slug' => 'red']);
        $this->assertIsArray($blue);
        $this->assertIsArray($red);

        $parent = $this->variableProduct(['38', '39']);
        $colour = new \WC_Product_Attribute;
        $colour->set_id($attributeId);
        $colour->set_name('pa_colour');
        $colour->set_options([(int) $blue['term_id'], (int) $red['term_id']]);
        $colour->set_visible(false);
        $colour->set_variation(true);
        $colour->set_position(1);
        $parent->set_attributes([...array_values($parent->get_attributes()), $colour]);
        $parent->set_default_attributes(['pa_colour' => 'light-blue', 'size' => '38']);
        $parent->save();
        [$v38] = $parent->get_children();
        $variation = wc_get_product($v38);
        $variation->set_attributes(['size' => '38', 'pa_colour' => 'light-blue']);
        $variation->save();
        $parent = wc_get_product($parent->get_id());
        $variation = wc_get_product($v38);

        // As wc/v3 shows them (labels, term names, any order) and as the log stores them.
        $productV3 = [
            ['id' => $attributeId, 'name' => 'Colour', 'slug' => 'pa_colour', 'position' => 1, 'visible' => false, 'variation' => true, 'options' => ['Red', 'Light blue']],
            ['id' => 0, 'name' => 'size', 'slug' => 'size', 'position' => 0, 'visible' => true, 'variation' => true, 'options' => ['38', '39']],
        ];
        $variationV3 = [['id' => 0, 'name' => 'Size', 'option' => '38'], ['id' => $attributeId, 'name' => 'Colour', 'option' => 'Light blue']];
        $defaultsV3 = [['id' => $attributeId, 'name' => 'Colour', 'option' => 'Light blue'], ['id' => 0, 'name' => 'size', 'option' => '38']];

        $this->assertSame([], Concurrency::conflicts($parent, ['attributes' => wp_json_encode($productV3), 'default_attributes' => wp_json_encode($defaultsV3)]));
        $this->assertSame([], Concurrency::conflicts($parent, ['attributes' => Recorder::serialize(Recorder::read($parent, 'attributes'))]));
        $this->assertSame([], Concurrency::conflicts($variation, ['attributes' => wp_json_encode($variationV3)]));
        $this->assertSame([], Concurrency::conflicts($variation, ['attributes' => wp_json_encode([['name' => 'pa_colour', 'option' => 'light-blue'], ['name' => 'size', 'option' => '38']])]));

        // Same ids, other options, flags or pairs: a conflict.
        $changed = $productV3;
        $changed[0]['options'] = ['Red'];
        $this->assertArrayHasKey('attributes', Concurrency::conflicts($parent, ['attributes' => wp_json_encode($changed)]));
        $changed = $productV3;
        $changed[1]['visible'] = false;
        $this->assertArrayHasKey('attributes', Concurrency::conflicts($parent, ['attributes' => wp_json_encode($changed)]));
        $this->assertArrayHasKey('attributes', Concurrency::conflicts($parent, ['attributes' => wp_json_encode([$productV3[1]])]));
        $this->assertArrayHasKey('attributes', Concurrency::conflicts($variation, ['attributes' => wp_json_encode([['id' => 0, 'name' => 'Size', 'option' => '38'], ['id' => $attributeId, 'name' => 'Colour', 'option' => 'Red']])]));
        $this->assertArrayHasKey('default_attributes', Concurrency::conflicts($parent, ['default_attributes' => wp_json_encode([['id' => $attributeId, 'name' => 'Colour', 'option' => 'Red']])]));

        // Through wc/v3: a variation whose attributes changed since they were loaded is not written.
        $other = wc_get_product($v38);
        $other->set_attributes(['size' => '38', 'pa_colour' => 'red']);
        $other->save();
        $response = $this->request('PUT', '/wc/v3/products/'.$parent->get_id().'/variations/'.$v38, [
            'attributes' => [['id' => 0, 'name' => 'size', 'option' => '38'], ['id' => $attributeId, 'option' => 'Light blue']],
            Concurrency::EXPECT_KEY => ['attributes' => $variationV3],
        ]);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::CONFLICT_ERROR, $this->data($response)['code']);
        clean_post_cache($v38);
        $this->assertSame('red', wc_get_product($v38)->get_attributes('edit')['pa_colour'] ?? null);
    }

    public function test_failed_rows_of_a_row_action_are_logged_under_that_action(): void
    {
        $product = $this->simpleProduct();
        $batch = $this->batchId();

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $batch, 'source' => 'action', 'action' => 'trash', 'items' => [['id' => $product->get_id(), 'reason' => 'failed', 'message' => 'offline']]]));
        $this->assertStatus(400, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $batch, 'source' => 'action', 'action' => 'no_such_action', 'items' => [['id' => $product->get_id(), 'reason' => 'failed']]]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $batch, 'items' => [['id' => $product->get_id(), 'reason' => 'unchanged']]]));

        $rows = $this->rows($batch);
        $this->assertCount(2, $rows);
        $this->assertSame(['trash', Logger::STATUS_ERROR], [$rows[0]['action'], $rows[0]['status']]);
        $this->assertSame(['update', Logger::STATUS_SKIPPED], [$rows[1]['action'], $rows[1]['status']]);
    }

    public function test_a_revert_leaves_alone_an_edit_made_while_it_runs(): void
    {
        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '11'],
            ['id' => $b->get_id(), 'sale_price' => '11'],
        ]], [Logger::SOURCE_HEADER => 'bulk']));

        // After the revert's up-front check, before its write of $b: a quick
        // edit in another process sets $b's sale to 9.
        $hook = function ($object) use ($b) {
            static $done = false;

            if (! $done && $object instanceof \WC_Product && $object->get_id() === $b->get_id()) {
                $done = true;
                $this->writeBehindTheCache($b->get_id(), '_sale_price', '9');
            }

            return $object;
        };
        add_filter('woocommerce_rest_pre_insert_product_object', $hook, 1);

        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(200, $response);
        $revert = (string) $this->data($response)['batch_id'];
        $results = array_column($this->data($response)['results'], null, 'id');

        $this->assertTrue($results[$a->get_id()]['ok']);
        $this->assertFalse($results[$b->get_id()]['ok']);
        $this->assertSame('conflict', $results[$b->get_id()]['code']);
        $this->assertSame(['sale_price' => '9'], $results[$b->get_id()]['current']);
        $this->assertSame(['sale_price' => '11'], $results[$b->get_id()]['batch']);

        clean_post_cache($b->get_id());
        $this->assertSame('9', get_post_meta($b->get_id(), '_sale_price', true), 'the edit made meanwhile is kept');
        $this->assertSame('', get_post_meta($a->get_id(), '_sale_price', true));

        $skipped = array_values(array_filter($this->rows($revert), static fn (array $row): bool => (int) $row['object_id'] === $b->get_id()));
        $this->assertSame(Logger::STATUS_SKIPPED, $skipped[0]['status']);
        $this->assertSame('conflict', json_decode((string) $skipped[0]['context'], true)['reason']);
    }

    public function test_only_one_revert_of_a_batch_runs_at_a_time(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['sale_price' => '11']));

        $name = Concurrency::lockName('r', md5($this->batchId()));
        $this->other()->query("SELECT GET_LOCK('{$name}', 0)");

        $response = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::REVERT_RUNNING_ERROR, $this->data($response)['code']);
        $this->assertSame('11', get_post_meta($product->get_id(), '_sale_price', true));

        $this->other()->query("SELECT RELEASE_LOCK('{$name}')");
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame('', get_post_meta($product->get_id(), '_sale_price', true));
    }

    public function test_chunks_of_one_revert_share_the_claim_and_another_revert_is_refused(): void
    {
        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '11'],
            ['id' => $b->get_id(), 'sale_price' => '12'],
        ]]));

        $first = wp_generate_uuid4();
        $route = '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert';

        // The first chunk of a revert claims the batch...
        $this->assertStatus(200, $this->request('POST', $route, ['ids' => [$a->get_id()], 'revert_batch_id' => $first], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame($first, get_transient(Concurrency::revertClaim($this->batchId())));

        // ...a revert under another id is refused while the claim lasts...
        $response = $this->request('POST', $route, ['ids' => [$b->get_id()], 'revert_batch_id' => wp_generate_uuid4()], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::REVERT_RUNNING_ERROR, $this->data($response)['code']);
        $this->assertSame('12', get_post_meta($b->get_id(), '_sale_price', true));

        // ...and the next chunk of the same revert goes through.
        $this->assertStatus(200, $this->request('POST', $route, ['ids' => [$b->get_id()], 'revert_batch_id' => $first], [ListMode::BATCH_HEADER => wp_generate_uuid4()]));
        $this->assertSame('', get_post_meta($b->get_id(), '_sale_price', true));

        delete_transient(Concurrency::revertClaim($this->batchId()));
    }

    public function test_a_planned_batch_is_running_until_closed_and_interrupted_when_abandoned(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $planned = [BatchState::PLANNED_HEADER => '900', Logger::SOURCE_HEADER => 'bulk'];

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'sale_price' => '11']]], $planned));

        foreach (['/log/batch/'.$this->batchId(), '/log/batch/'.$this->batchId().'/check'] as $route) {
            $response = $this->request('GET', '/wc-products-list/v1'.$route);
            $this->assertStatus(409, $response);
            $this->assertSame(BatchState::RUNNING_ERROR, $this->data($response)['code']);
        }

        $revert = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert', [], [ListMode::BATCH_HEADER => wp_generate_uuid4()]);
        $this->assertStatus(409, $revert);
        $this->assertSame('11', get_post_meta($product->get_id(), '_sale_price', true));

        $list = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertSame(BatchState::STATE_RUNNING, $list['items'][0]['state']);
        $this->assertSame(900, $list['items'][0]['planned']);

        // The tab went away: no write for longer than the TTL.
        $marker = BatchState::get($this->batchId());
        $marker['updated'] = time() - BatchState::ttl() - 5;
        update_option(BatchState::option($this->batchId()), $marker, false);

        $list = $this->data($this->request('GET', '/wc-products-list/v1/log/batches'));
        $this->assertSame(BatchState::STATE_INTERRUPTED, $list['items'][0]['state']);
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));

        $close = $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/close', [], [ListMode::BATCH_HEADER => '']);
        $this->assertStatus(200, $close);
        $this->assertTrue($this->data($close)['closed']);
        $this->assertNull(BatchState::get($this->batchId()));
        $this->assertNull($this->data($this->request('GET', '/wc-products-list/v1/log/batches'))['items'][0]['state']);
    }

    public function test_a_single_request_marks_its_batch_only_while_it_runs(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $seen = null;

        add_action('woocommerce_rest_insert_product_object', function () use (&$seen): void {
            $seen = BatchState::running($this->batchId()) ? 'running' : 'idle';
            $this->assertNotNull(LogController::runningError($this->batchId()));
        }, 5);

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['sale_price' => '11']));
        $this->assertSame('running', $seen);
        $this->assertNull(BatchState::get($this->batchId()));
        $this->assertStatus(200, $this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
    }

    public function test_an_interrupted_variations_write_gets_its_parent_synced(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        // What a request killed after saving the variation leaves: the
        // variation is on sale, the parent's price was never synced.
        update_post_meta($v38, '_sale_price', '99');
        update_post_meta($v38, '_price', '99');
        update_option(BatchState::option($this->batchId()), [
            'user' => get_current_user_id(), 'planned' => 10, 'started' => time() - 600, 'updated' => time() - 600, 'parents' => [$parent->get_id()],
        ], false);

        $this->assertSame(BatchState::STATE_INTERRUPTED, BatchState::state($this->batchId()));
        $this->assertSame([], BatchState::get($this->batchId())['parents']);
        $this->assertContains('99', get_post_meta($parent->get_id(), '_price'));
    }

    public function test_requests_of_one_batch_keep_each_others_parents_and_close_repairs_a_dead_one(): void
    {
        $p1 = $this->variableProduct(['38']);
        $p2 = $this->variableProduct(['39']);
        [$a] = $p1->get_children();
        [$b] = $p2->get_children();
        $headers = [BatchState::PLANNED_HEADER => '10', ListMode::BATCH_HEADER => $this->batchId()];
        $make = static function (int $id) use ($headers): \WP_REST_Request {
            $request = new \WP_REST_Request('POST', '/wc-products-list/v1/variations/batch');

            foreach ($headers as $name => $value) {
                $request->set_header($name, $value);
            }

            $request->set_header(ListMode::HEADER, '1');
            $request->set_body_params(['update' => [['id' => $id, 'sale_price' => '1']]]);

            return $request;
        };

        // Two requests of the batch at once: the first one dies (no end()),
        // the second one ends normally.
        $dead = $make($a);
        $alive = $make($b);
        ListMode::force(true, $this->batchId());

        try {
            BatchState::begin($dead);
            BatchState::begin($alive);
            BatchState::end($alive);
        } finally {
            ListMode::reset();
        }

        $this->assertSame([$p1->get_id()], BatchState::get($this->batchId())['parents'], "the dead request's parent stays listed");

        // What the dead request left: the variation on sale, its parent not synced.
        update_post_meta($a, '_sale_price', '1');
        update_post_meta($a, '_price', '1');
        $this->assertNotContains('1', get_post_meta($p1->get_id(), '_price'));

        // The client closes the batch right away, within the TTL.
        $this->assertTrue(BatchState::close($this->batchId()));
        $this->assertNull(BatchState::get($this->batchId()));
        $this->assertContains('1', get_post_meta($p1->get_id(), '_price'), 'close repairs every parent still listed');
    }

    public function test_the_variations_batch_syncs_each_parent_before_the_request_ends(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        [$a] = $parent->get_children();
        $seen = null;

        // The second group's dispatch: the first parent is synced by then.
        $other = $this->variableProduct(['40']);
        [$c] = $other->get_children();
        add_filter('woocommerce_rest_pre_insert_product_variation_object', function ($object) use ($c, $parent, &$seen) {
            if ($object instanceof \WC_Product && $object->get_id() === $c) {
                wp_cache_delete($parent->get_id(), 'post_meta');
                $seen = get_post_meta($parent->get_id(), '_price');
            }

            return $object;
        }, 1);

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [
            ['id' => $a, 'sale_price' => '7'],
            ['id' => $c, 'sale_price' => '8'],
        ]], [Logger::SOURCE_HEADER => 'bulk']));

        $this->assertContains('7', (array) $seen);
    }

    public function test_a_save_of_an_item_another_user_has_open_in_the_editor_is_refused(): void
    {
        $me = get_current_user_id();
        $other = self::factory()->user->create(['role' => 'shop_manager']);
        $product = $this->simpleProduct(['regular_price' => '15']);
        $id = $product->get_id();
        update_post_meta($id, '_edit_lock', time().':'.$other);

        $response = $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '18']);
        $this->assertStatus(409, $response);
        $data = $this->data($response);
        $this->assertSame(Concurrency::EDITING_ERROR, $data['code']);
        $this->assertSame($other, $data['data']['user']);
        $this->assertSame('15', get_post_meta($id, '_regular_price', true));
        $rows = $this->rows();
        $this->assertSame(Logger::STATUS_SKIPPED, $rows[0]['status']);
        $this->assertSame('editing', json_decode((string) $rows[0]['context'], true)['reason']);
        $this->assertSame([], Concurrency::heldObjects());

        // A variation whose parent is open in the editor, in a batch: only that item.
        $parent = $this->variableProduct(['38']);
        [$v] = $parent->get_children();
        $free = $this->variableProduct(['39']);
        [$w] = $free->get_children();
        update_post_meta($parent->get_id(), '_edit_lock', time().':'.$other);
        $items = $this->data($this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [
            ['id' => $v, 'sale_price' => '5'],
            ['id' => $w, 'sale_price' => '5'],
        ]]))['update'];
        $this->assertSame(Concurrency::EDITING_ERROR, $items[0]['error']['code']);
        $this->assertArrayNotHasKey('error', $items[1]);
        $this->assertSame('', get_post_meta($v, '_sale_price', true));

        // A lock past core's window is no clash.
        update_post_meta($id, '_edit_lock', (time() - 200).':'.$other);
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '18']));

        // The user's own lock (their product editor in another tab) is: its Update would put the form back.
        update_post_meta($id, '_edit_lock', time().':'.$me);
        $response = $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '19']);
        $this->assertStatus(409, $response);
        $this->assertSame(Concurrency::EDITING_ERROR, $this->data($response)['code']);
        $this->assertStringContainsString('You have this product open', $this->data($response)['message']);
        $this->assertSame('18', get_post_meta($id, '_regular_price', true));
        delete_post_meta($id, '_edit_lock');
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '19']));
    }

    public function test_row_actions_are_refused_while_the_product_is_open_in_the_editor(): void
    {
        $other = self::factory()->user->create(['role' => 'shop_manager']);
        $product = $this->simpleProduct(['regular_price' => '15']);
        $id = $product->get_id();
        update_post_meta($id, '_edit_lock', time().':'.$other);

        foreach (['trash', 'delete'] as $action) {
            $data = $this->data($this->request('POST', '/wc-products-list/v1/actions/'.$action, ['ids' => [$id]]));
            $this->assertFalse($data['results'][0]['ok'], $action);
            $this->assertSame(Concurrency::EDITING_ERROR, $data['results'][0]['code'], $action);
            $row = $this->rows($data['batch_id'])[0];
            $this->assertSame(Logger::STATUS_SKIPPED, $row['status']);
            $this->assertSame('editing', json_decode((string) $row['context'], true)['reason']);
        }

        clean_post_cache($id);
        $this->assertSame('publish', get_post_status($id));
        $this->assertSame([], Concurrency::heldObjects());

        // Restore (the Undo of a Trash) too: an editor opened before the Trash keeps its lock fresh.
        delete_post_meta($id, '_edit_lock');
        $data = $this->data($this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$id]]));
        $this->assertTrue($data['results'][0]['ok']);
        update_post_meta($id, '_edit_lock', time().':'.$other);
        $data = $this->data($this->request('POST', '/wc-products-list/v1/actions/restore', ['ids' => [$id]]));
        $this->assertFalse($data['results'][0]['ok']);
        $this->assertSame(Concurrency::EDITING_ERROR, $data['results'][0]['code']);
        $row = $this->rows($data['batch_id'])[0];
        $this->assertSame(Logger::STATUS_SKIPPED, $row['status']);
        $this->assertSame('editing', json_decode((string) $row['context'], true)['reason']);
        clean_post_cache($id);
        $this->assertSame('trash', get_post_status($id));
        delete_post_meta($id, '_edit_lock');
        $data = $this->data($this->request('POST', '/wc-products-list/v1/actions/restore', ['ids' => [$id]]));
        $this->assertTrue($data['results'][0]['ok']);
        clean_post_cache($id);
        $this->assertNotSame('trash', get_post_status($id));
        update_post_meta($id, '_edit_lock', time().':'.$other);

        // A copy leaves the original alone.
        $data = $this->data($this->request('POST', '/wc-products-list/v1/actions/duplicate', ['ids' => [$id]]));
        $this->assertTrue($data['results'][0]['ok']);
        $copy = (int) $data['results'][0]['data']['new_id'];
        wp_delete_post($copy, true);
    }

    public function test_a_core_trash_or_delete_waits_for_a_save_of_the_row(): void
    {
        $product = $this->simpleProduct(['regular_price' => '15']);
        $id = $product->get_id();
        $name = Concurrency::lockName('o', (string) $id);
        add_filter(Concurrency::FILTER_LOCK_TIMEOUT, static fn (): int => 1);

        // A save in another process holds the row: core's trash waits for it (here until the timeout), then goes ahead.
        $this->assertSame('1', (string) $this->other()->query("SELECT GET_LOCK('{$name}', 0)")->fetch_row()[0]);
        $start = microtime(true);
        $this->assertNotFalse(wp_trash_post($id));
        $this->assertGreaterThanOrEqual(0.9, microtime(true) - $start);
        $this->other()->query("SELECT RELEASE_LOCK('{$name}')");

        // Free: it takes the lock for the change and lets it go after.
        $this->assertNotFalse(wp_untrash_post($id));
        $this->assertSame('1', (string) $this->other()->query("SELECT IS_FREE_LOCK('{$name}')")->fetch_row()[0]);
        $this->assertNotFalse(wp_delete_post($id, true));
        $this->assertSame('1', (string) $this->other()->query("SELECT IS_FREE_LOCK('{$name}')")->fetch_row()[0]);
    }

    public function test_a_revert_of_several_requests_marks_its_revert_batch_until_closed(): void
    {
        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $a->get_id(), 'sale_price' => '11'], ['id' => $b->get_id(), 'sale_price' => '12']]]));
        $this->assertNull(BatchState::get($this->batchId()));

        $route = '/wc-products-list/v1/log/batch/'.$this->batchId().'/revert';
        $revert = wp_generate_uuid4();
        $chunk = [ListMode::BATCH_HEADER => $revert, BatchState::PLANNED_HEADER => '2'];

        // The first chunk marks the revert batch, not the reverted one...
        $this->assertStatus(200, $this->request('POST', $route, ['ids' => [$a->get_id()], 'revert_batch_id' => $revert], $chunk));
        $this->assertSame(2, BatchState::get($revert)['planned']);
        $this->assertNull(BatchState::get($this->batchId()));
        $this->assertSame(BatchState::STATE_RUNNING, BatchState::stateOf(BatchState::get($revert)));

        // ...the revert batch cannot be reverted while it runs...
        $this->assertStatus(409, $this->request('GET', '/wc-products-list/v1/log/batch/'.$revert));

        // ...its own next chunk is not held back by its marker...
        $this->assertStatus(200, $this->request('POST', $route, ['ids' => [$b->get_id()], 'revert_batch_id' => $revert], $chunk));
        $this->assertSame('', get_post_meta($b->get_id(), '_sale_price', true));

        // ...and a revert cut short reads as interrupted.
        $marker = BatchState::get($revert);
        $marker['updated'] = time() - BatchState::ttl() - 5;
        update_option(BatchState::option($revert), $marker, false);
        $list = $this->data($this->request('GET', '/wc-products-list/v1/log/batches', [], [], ['batch' => $revert]));
        $this->assertSame(BatchState::STATE_INTERRUPTED, $list['items'][0]['state']);
        $this->assertSame(2, $list['items'][0]['planned']);

        $this->assertTrue($this->data($this->request('POST', '/wc-products-list/v1/log/batch/'.$revert.'/close', [], [ListMode::BATCH_HEADER => '']))['closed']);
        $this->assertNull(BatchState::get($revert));

        // A revert in one request (no planned header) leaves no marker.
        $single = wp_generate_uuid4();
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/batch/'.$revert.'/revert', ['revert_batch_id' => $single], [ListMode::BATCH_HEADER => $single]));
        $this->assertNull(BatchState::get($single));
        delete_transient(Concurrency::revertClaim($this->batchId()));
        delete_transient(Concurrency::revertClaim($revert));
    }

    public function test_another_user_cannot_mark_or_close_someone_elses_running_batch(): void
    {
        $product = $this->simpleProduct(['regular_price' => '20']);
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $product->get_id(), 'sale_price' => '11']]], [BatchState::PLANNED_HEADER => '5']));
        $owner = BatchState::get($this->batchId())['user'];

        $this->actAs('shop_manager');
        $this->assertStatus(403, $this->request('POST', '/wc-products-list/v1/log/batch/'.$this->batchId().'/close', [], [ListMode::BATCH_HEADER => '']));
        $this->assertSame($owner, BatchState::get($this->batchId())['user']);
    }

    public function test_log_rows_are_written_per_item_not_at_the_end_of_the_request(): void
    {
        global $wpdb;

        $a = $this->simpleProduct(['regular_price' => '20']);
        $b = $this->simpleProduct(['regular_price' => '20']);
        $seen = null;
        $table = Table::name();

        add_filter('woocommerce_rest_pre_insert_product_object', function ($object) use ($b, &$seen, $wpdb, $table) {
            if ($object instanceof \WC_Product && $object->get_id() === $b->get_id()) {
                $seen = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE batch_id = %s", $this->batchId())); // phpcs:ignore
            }

            return $object;
        }, 1);

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a->get_id(), 'sale_price' => '11'],
            ['id' => $b->get_id(), 'sale_price' => '11'],
        ]]));

        $this->assertSame(1, $seen, "the first item's row is in the table before the second item is saved");
    }

    public function test_the_revert_plan_from_sql_matches_the_rows(): void
    {
        $simple = $this->simpleProduct(['regular_price' => '20']);
        $first = $this->variableProduct(['38', '39']);
        $second = $this->variableProduct(['40']);
        [$v38, $v39] = $first->get_children();
        [$v40] = $second->get_children();

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [
            ['id' => $v40, 'sale_price' => '99'],
            ['id' => $v39, 'sale_price' => '99'],
            ['id' => $v38, 'sale_price' => '99'],
        ]]));
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [['id' => $simple->get_id(), 'sale_price' => '11', 'post_password' => 'x']]]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/actions/trash', ['ids' => [$second->get_id()]]));
        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/log/skipped', ['batch_id' => $this->batchId(), 'items' => [['id' => $simple->get_id(), 'reason' => 'unchanged']]]));

        $plan = $this->data($this->request('GET', '/wc-products-list/v1/log/batch/'.$this->batchId()));
        $expected = Revert::objects($this->rows());

        $this->assertSame(array_column($expected['objects'], 'id'), array_merge(...$plan['chunks']));
        $this->assertSame([$simple->get_id(), $v40, $v39, $v38], array_merge(...$plan['chunks']));
        $this->assertEqualsCanonicalizing($expected['skipped'], $plan['skipped']);
        $this->assertSame(['unchanged' => 1], $plan['left_out_reasons']);
        $this->assertSame(1, $plan['left_out']);
    }
}
