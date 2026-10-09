<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\History\Batches;
use GeneroWP\ProductsList\History\Compare;
use GeneroWP\ProductsList\History\History;
use GeneroWP\ProductsList\History\Purge;
use GeneroWP\ProductsList\History\Restore;
use GeneroWP\ProductsList\History\Revisions;
use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Log\Table;
use WC_Product;

/**
 * SPIKE (Phase 0) correctness matrix: native revisions as product history.
 *
 * Every edit path must leave exactly one revision that equals the saved
 * state, a baseline before the first change, the batch term on the new
 * revision, and an undo (and a redo, the undo of the undo) that goes
 * through WooCommerce so `_price`, the variable parent's price range and
 * `wc_product_meta_lookup` stay right.
 */
class RevisionsSpikeTest extends RestTestCase
{
    private static bool $registered = false;

    public function set_up(): void
    {
        parent::set_up();

        if (! self::$registered) {
            (new History)->register();
            self::$registered = true;
        }

        History::switchTo('both');
        Revisions::forget();
        Batches::reset();

        // What gds-woo-i18n does in Phase 1: its own register_post_meta
        // with `revisions_enabled` (the suite does not load the plugin).
        register_post_meta('product_variation', '_i18n_description_se', ['single' => true, 'type' => 'string', 'revisions_enabled' => true]);
    }

    public function tear_down(): void
    {
        unregister_post_meta('product_variation', '_i18n_description_se');
        remove_all_filters(History::FILTER_OPTIONS);
        Batches::reset();
        Revisions::forget();
        History::switchTo('log');
        $_POST = [];
        set_current_screen('front');

        parent::tear_down();
    }

    /** @return array<int, int> newest first */
    private function revisions(int $id): array
    {
        global $wpdb;

        return array_map('intval', $wpdb->get_col($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_parent = %d AND post_type = 'revision' ORDER BY ID DESC", $id)));
    }

    private function batchOf(int $revisionId): ?string
    {
        wp_cache_delete($revisionId, Batches::TAXONOMY.'_relationships');
        $terms = wp_get_object_terms($revisionId, Batches::TAXONOMY, ['fields' => 'slugs']);

        return is_array($terms) && $terms !== [] ? (string) $terms[0] : null;
    }

    private function settle(): void
    {
        \WC_Post_Data::do_deferred_product_sync();
        Batches::flush();
        Revisions::forget();
        wp_cache_flush_runtime();
    }

    /** Fixtures are made: what follows is a new batch, as a new request would be. */
    private function ready(): void
    {
        $this->settle();
        Batches::reset();
    }

    /**
     * The newest revision equals the saved state, the one before it does
     * not (no duplicate), and it carries a batch term.
     */
    private function assertRevisionIsState(int $id, int $expectedCount, ?string $batch = null): int
    {
        $this->settle();
        $revisions = $this->revisions($id);
        $this->assertCount($expectedCount, $revisions, 'revisions of '.$id);

        $latest = $revisions[0];
        $this->assertSame(Restore::current($id), Restore::state($latest, $id), 'the newest revision is the saved state');

        if (count($revisions) > 1) {
            $this->assertNotSame(Restore::state($revisions[1], $id), Restore::state($latest, $id), 'no duplicate revision');
        }

        $term = $this->batchOf($latest);
        $this->assertNotNull($term, 'the revision has a batch term');

        if ($batch !== null) {
            $this->assertSame($batch, $term);
        }

        return $latest;
    }

    private function assertBaseline(int $id, string $key, ?string $value): void
    {
        $revisions = $this->revisions($id);
        $baseline = end($revisions);
        $this->assertNull($this->batchOf((int) $baseline), 'the baseline belongs to no batch');
        $this->assertSame($value, Restore::value(Restore::state((int) $baseline, $id), $key), 'baseline holds the pre-save value of '.$key);
    }

    /**
     * `_price`, the lookup table and (for a variation) the parent's range
     * agree with the variation's own prices.
     */
    private function assertDerived(int $id): void
    {
        global $wpdb;

        wp_cache_flush_runtime();
        $product = wc_get_product($id);
        $this->assertInstanceOf(WC_Product::class, $product);

        $expected = $product->is_on_sale('edit') ? $product->get_sale_price('edit') : $product->get_regular_price('edit');
        $this->assertSame((string) $expected, (string) get_post_meta($id, '_price', true), '_price of '.$id);

        $lookup = $wpdb->get_row($wpdb->prepare("SELECT min_price, max_price FROM {$wpdb->wc_product_meta_lookup} WHERE product_id = %d", $id), ARRAY_A);
        $this->assertEquals((float) $expected, (float) $lookup['min_price'], 'lookup min_price of '.$id);
        $this->assertEquals((float) $expected, (float) $lookup['max_price'], 'lookup max_price of '.$id);

        $parentId = $product->get_parent_id();

        if ($parentId > 0) {
            $prices = [];

            foreach (wc_get_product($parentId)->get_children() as $child) {
                $variation = wc_get_product($child);
                $prices[] = (float) ($variation->is_on_sale('edit') ? $variation->get_sale_price('edit') : $variation->get_regular_price('edit'));
            }

            $parentPrices = array_map('floatval', get_post_meta($parentId, '_price'));
            sort($parentPrices);
            $this->assertSame(min($prices), $parentPrices[0], 'parent _price min');
            $this->assertSame(max($prices), end($parentPrices), 'parent _price max');

            $range = $wpdb->get_row($wpdb->prepare("SELECT min_price, max_price FROM {$wpdb->wc_product_meta_lookup} WHERE product_id = %d", $parentId), ARRAY_A);
            $this->assertEquals(min($prices), (float) $range['min_price'], 'parent lookup min');
            $this->assertEquals(max($prices), (float) $range['max_price'], 'parent lookup max');
        }
    }

    /**
     * Undo a batch, check the values, then undo the undo and check again.
     *
     * @param  array<int, array<string, ?string>>  $before  id => key => value before the batch
     * @param  array<int, array<string, ?string>>  $after  id => key => value the batch left
     */
    private function assertUndoRedo(string $batch, array $before, array $after): void
    {
        $undo = Restore::undoAll($batch);
        $this->assertSame(count($before), $undo['restored'], 'undo: '.wp_json_encode($undo));
        $this->assertSame(0, $undo['conflicts']);
        $this->settle();

        foreach ($before as $id => $values) {
            foreach ($values as $key => $value) {
                $this->assertSame($value, Restore::value(Restore::current($id), $key), 'undo restores '.$key.' of '.$id);
            }

            $this->assertRevisionIsState($id, count($this->revisions($id)), $undo['batch']);
            $this->assertDerived($id);
        }

        $meta = Batches::meta($undo['batch']);
        $this->assertSame('revert', $meta['source']);
        $this->assertSame($batch, $meta['reverts']);

        $redo = Restore::undoAll($undo['batch']);
        $this->assertSame(count($after), $redo['restored'], 'redo: '.wp_json_encode($redo));
        $this->settle();

        foreach ($after as $id => $values) {
            foreach ($values as $key => $value) {
                $this->assertSame($value, Restore::value(Restore::current($id), $key), 'redo restores '.$key.' of '.$id);
            }

            $this->assertDerived($id);
        }
    }

    public function test_price_only_crud_save_of_a_variation(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        [$v38] = $parent->get_children();
        $this->ready();
        $this->assertSame([], $this->revisions($v38), 'creating takes no revision');

        $variation = wc_get_product($v38);
        $variation->set_sale_price('149');
        $variation->save();

        $this->assertRevisionIsState($v38, 2);
        $this->assertBaseline($v38, 'meta:_sale_price', null);
        $this->assertDerived($v38);

        $batch = (string) $this->batchOf($this->revisions($v38)[0]);
        $this->assertContains('sale_price', Batches::meta($batch)['fields']);

        $this->assertUndoRedo($batch, [$v38 => ['meta:_sale_price' => null]], [$v38 => ['meta:_sale_price' => '149']]);
    }

    public function test_a_save_that_changes_nothing_takes_no_revision(): void
    {
        $product = $this->simpleProduct();
        $product = wc_get_product($product->get_id());
        $product->set_regular_price('189');
        $product->save();
        $this->settle();

        $this->assertSame([], $this->revisions($product->get_id()));
    }

    public function test_name_and_price_take_one_revision_not_a_stale_one(): void
    {
        $product = $this->simpleProduct(['sku' => 'NP1']);
        $id = $product->get_id();
        $product = wc_get_product($id);
        $product->set_name('Renamed boot');
        $product->set_regular_price('199');
        $product->save();

        // Baseline + one: core's revision during wp_update_post (with the old price) is suppressed.
        $this->assertRevisionIsState($id, 2);
        $this->assertBaseline($id, 'post:post_title', 'Saga wide toe boot');
        $this->assertBaseline($id, 'meta:_regular_price', '189');
        $this->assertSame('199', Restore::value(Restore::state($this->revisions($id)[0], $id), 'meta:_regular_price'));
        $this->assertDerived($id);

        $batch = (string) $this->batchOf($this->revisions($id)[0]);
        $this->assertUndoRedo(
            $batch,
            [$id => ['post:post_title' => 'Saga wide toe boot', 'meta:_regular_price' => '189']],
            [$id => ['post:post_title' => 'Renamed boot', 'meta:_regular_price' => '199']]
        );
    }

    public function test_terms_only_change_takes_a_revision(): void
    {
        $boots = self::factory()->term->create(['taxonomy' => 'product_cat', 'name' => 'Boots']);
        $sale = self::factory()->term->create(['taxonomy' => 'product_cat', 'name' => 'Sale']);
        $product = $this->simpleProduct(['category_ids' => [$boots]]);
        $id = $product->get_id();

        $product = wc_get_product($id);
        $product->set_category_ids([$boots, $sale]);
        $product->set_featured(true);
        $product->save();

        $this->assertRevisionIsState($id, 2);
        $this->assertNull($this->batchOf((int) min($this->revisions($id))), 'the baseline belongs to no batch');
        $baseline = Restore::state((int) min($this->revisions($id)), $id);
        $this->assertSame([$boots], $baseline['terms']['product_cat']);
        $this->assertArrayNotHasKey('product_visibility', $baseline['terms']);

        $batch = (string) $this->batchOf($this->revisions($id)[0]);
        $after = Restore::current($id);
        $this->assertUndoRedo($batch, [$id => ['terms:product_cat' => [$boots], 'terms:product_visibility' => null]], [$id => ['terms:product_cat' => $after['terms']['product_cat'], 'terms:product_visibility' => $after['terms']['product_visibility']]]);
        $this->assertTrue(wc_get_product($id)->get_featured());
    }

    public function test_translation_only_change_takes_a_revision(): void
    {
        // Variation text is opt-in (docs/revisions.md, finding on storage).
        add_filter(History::FILTER_OPTIONS, static fn (array $options): array => ['variation_text' => true] + $options);
        History::resetOptions();

        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $this->ready();

        $variation = wc_get_product($v38);
        $variation->update_meta_data('_i18n_description_se', 'Bred tå');
        $variation->save();

        $this->assertRevisionIsState($v38, 2);
        $this->assertBaseline($v38, 'meta:_i18n_description_se', null);
        $batch = (string) $this->batchOf($this->revisions($v38)[0]);
        $this->assertContains('meta:_i18n_description_se', Batches::meta($batch)['fields']);

        $this->assertUndoRedo($batch, [$v38 => ['meta:_i18n_description_se' => null]], [$v38 => ['meta:_i18n_description_se' => 'Bred tå']]);
    }

    public function test_variation_text_is_not_revisioned_by_default(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $this->ready();

        $variation = wc_get_product($v38);
        $variation->set_regular_price('150');
        $variation->save();
        $this->settle();
        $count = count($this->revisions($v38));

        $variation = wc_get_product($v38);
        $variation->update_meta_data('_i18n_description_se', 'Bred tå');
        $variation->set_description('Wide toe');
        $variation->save();
        $this->settle();

        $this->assertCount($count, $this->revisions($v38), 'a text-only change of a variation takes no revision');
        $meta = get_metadata('post', $this->revisions($v38)[0]);
        $this->assertArrayNotHasKey('_variation_description', $meta);
        $this->assertArrayNotHasKey('_i18n_description_se', $meta);
        $this->assertArrayHasKey('_regular_price', $meta);
    }

    public function test_an_order_stock_change_takes_no_revision_and_no_batch(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $variation = wc_get_product($v38);
        $variation->set_manage_stock(true);
        $variation->set_stock_quantity(10);
        $variation->save();
        $this->ready();
        $before = count($this->revisions($v38));
        $terms = (int) wp_count_terms(['taxonomy' => Batches::TAXONOMY, 'hide_empty' => false]);

        // What checkout does per order line, on the storefront.
        wc_update_product_stock(wc_get_product($v38), 1, 'decrease');
        wc_update_product_stock(wc_get_product($v38), 1, 'decrease');
        $this->settle();

        $this->assertSame(8, wc_get_product($v38)->get_stock_quantity());
        $this->assertCount($before, $this->revisions($v38));
        $this->assertSame($terms, (int) wp_count_terms(['taxonomy' => Batches::TAXONOMY, 'hide_empty' => false]));

        // The app editing the stock is a change like any other. The sold
        // units first get a catch-up revision of their own (no batch), so
        // the save's predecessor is the state right before it.
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id().'/variations/'.$v38, ['stock_quantity' => 20]));
        $this->settle();
        $revisions = $this->revisions($v38);
        $this->assertCount($before + 2, $revisions);
        $this->assertNull($this->batchOf($revisions[1]), 'the catch-up revision belongs to no batch');
        $this->assertSame('8', Restore::value(Restore::state($revisions[1], $v38), 'meta:_stock'));
        $this->assertSame($this->batchId(), $this->batchOf($revisions[0]));
    }

    public function test_undo_of_a_batch_keeps_the_stock_sold_since_the_latest_revision(): void
    {
        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();
        $variation = wc_get_product($v38);
        $variation->set_manage_stock(true);
        $variation->set_stock_quantity(58);
        $variation->save();
        $this->ready();

        // Two storefront sales: no revision.
        wc_update_product_stock(wc_get_product($v38), 1, 'decrease');
        wc_update_product_stock(wc_get_product($v38), 1, 'decrease');
        $this->settle();

        // Then the app changes only the price.
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$parent->get_id().'/variations/'.$v38, ['regular_price' => '6.5']));
        $this->settle();
        $batch = $this->batchId();

        $undo = Restore::undoAll($batch);
        $this->assertSame(1, $undo['restored'], wp_json_encode($undo));
        $this->assertSame(0, $undo['conflicts']);
        $this->settle();

        $this->assertSame('189', get_post_meta($v38, '_regular_price', true));
        $this->assertSame(56, wc_get_product($v38)->get_stock_quantity(), 'the sold units are not put back');
        $this->assertDerived($v38);
    }

    public function test_undo_leaves_alone_a_change_made_while_history_was_in_log_mode(): void
    {
        $id = $this->simpleProduct(['sku' => 'LM1', 'weight' => '0.5'])->get_id();
        $product = wc_get_product($id);
        $product->set_sale_price('150');
        $product->save();
        $this->ready();

        History::switchTo('log');
        $product = wc_get_product($id);
        $product->set_weight('0.77');
        $product->save();
        wp_cache_flush_runtime();
        History::switchTo('both');
        Revisions::forget();
        Batches::reset();

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '170']));
        $this->settle();

        $undo = Restore::undoAll($this->batchId());
        $this->assertSame(1, $undo['restored'], wp_json_encode($undo));
        $this->settle();

        $this->assertSame('189', get_post_meta($id, '_regular_price', true));
        $this->assertSame('0.77', get_post_meta($id, '_weight', true), 'the log-mode edit stays');
    }

    public function test_stock_changes_of_orders_outside_the_app_take_no_revision(): void
    {
        $product = $this->simpleProduct(['sku' => 'OR1', 'manage_stock' => true, 'stock_quantity' => 10]);
        $id = $product->get_id();
        $product = wc_get_product($id);
        $product->set_sale_price('150');
        $product->save();
        $this->ready();
        $before = count($this->revisions($id));

        // An order created and paid through wc/v3 (a POS, an ERP): a REST
        // write without the app's header.
        $response = $this->request('POST', '/wc/v3/orders', [
            'set_paid' => true,
            'status' => 'processing',
            'line_items' => [['product_id' => $id, 'quantity' => 2]],
        ], [ListMode::HEADER => '', ListMode::BATCH_HEADER => '']);
        $this->assertStatus(201, $response);
        $this->settle();
        $this->assertSame(8, wc_get_product($id)->get_stock_quantity());

        // A restock from an admin order screen.
        set_current_screen('edit-shop_order');
        wc_update_product_stock(wc_get_product($id), 1, 'increase');
        $this->settle();

        $this->assertSame(9, wc_get_product($id)->get_stock_quantity());
        $this->assertCount($before, $this->revisions($id), 'no revision per order line');

        // A stock edit on WooCommerce's product form is explicit: a revision
        // (after the catch-up of the order's changes).
        $edit = static function (int $postId): void {
            $product = wc_get_product($postId);
            $product->set_stock_quantity(3);
            $product->save();
        };
        add_action('woocommerce_process_product_meta', $edit);
        do_action('woocommerce_process_product_meta', $id);
        remove_action('woocommerce_process_product_meta', $edit);
        $this->settle();

        $revisions = $this->revisions($id);
        $this->assertCount($before + 2, $revisions);
        $this->assertSame('3', Restore::value(Restore::state($revisions[0], $id), 'meta:_stock'));
        $this->assertNotNull($this->batchOf($revisions[0]));
    }

    public function test_the_revision_of_a_rest_save_holds_the_brands_written_after_the_save(): void
    {
        $brand = (int) wp_insert_term('Froddo', 'product_brand')['term_id'];
        $product = $this->simpleProduct(['sku' => 'RB1']);
        $this->ready();

        // With a prop change: a brands-only change of an object that has no
        // revision yet takes none (no baseline can be taken after the fact).
        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$product->get_id(), ['name' => 'Branded', 'brands' => [['id' => $brand]]]));
        $this->settle();

        $latest = $this->revisions($product->get_id())[0];
        $this->assertSame([$brand], Revisions::revisionSnapshot($latest, $product->get_id())['terms']['product_brand'] ?? []);
        $this->assertSame($this->batchId(), $this->batchOf($latest));
    }

    public function test_undo_reports_revisions_pruned_by_retention(): void
    {
        add_filter(History::FILTER_OPTIONS, static fn (array $options): array => ['keep_product' => 2] + $options);
        History::resetOptions();
        $id = $this->simpleProduct(['sku' => 'PR1'])->get_id();
        $this->ready();

        Batches::begin($batch = wp_generate_uuid4(), 'bulk');
        $product = wc_get_product($id);
        $product->set_sale_price('100');
        $product->save();
        Batches::end();
        $this->settle();
        $this->assertSame(0, Restore::undo($batch, ['dry' => true])['pruned']);

        foreach (['101', '102', '103'] as $price) {
            $product = wc_get_product($id);
            $product->set_sale_price($price);
            $product->save();
            $this->settle();
        }

        $result = Restore::undo($batch, ['dry' => true]);
        $this->assertSame(0, $result['total']);
        $this->assertSame(1, $result['pruned']);

        // The batch's term is empty now; an hour later the daily prune drops it.
        $term = Batches::term($batch);
        $this->assertSame(0, Batches::pruneEmpty());
        update_term_meta($term['term_id'], 'time', time() - 2 * HOUR_IN_SECONDS);
        $this->assertSame(1, Batches::pruneEmpty());
        $this->assertNull(get_term($term['term_id'], Batches::TAXONOMY));
    }

    public function test_the_batch_term_is_counted_once_per_flush_not_per_revision(): void
    {
        $ids = [];

        foreach (['BC1', 'BC2', 'BC3'] as $sku) {
            $ids[] = $this->simpleProduct(['sku' => $sku])->get_id();
        }

        $this->ready();
        Batches::begin($batch = wp_generate_uuid4(), 'bulk');
        $counts = 0;
        $watch = static function (string $query) use (&$counts): string {
            if (preg_match('/SELECT COUNT\(\*\) FROM \S*term_relationships/i', $query) === 1) {
                $counts++;
            }

            return $query;
        };
        add_filter('query', $watch);

        foreach ($ids as $id) {
            $product = wc_get_product($id);
            $product->set_sale_price('100');
            $product->save();
        }

        remove_filter('query', $watch);
        $this->assertSame(0, $counts, 'no recount of the batch term per revision');
        Batches::end();
        $this->settle();

        $term = Batches::term($batch);
        $this->assertSame(3, (int) get_term($term['term_id'], Batches::TAXONOMY)->count);
    }

    public function test_purge_deletes_revisions_and_batch_terms(): void
    {
        $id = $this->simpleProduct(['sku' => 'PU1'])->get_id();
        $this->ready();
        Batches::begin(wp_generate_uuid4(), 'bulk');
        $product = wc_get_product($id);
        $product->set_sale_price('100');
        $product->save();
        Batches::end();
        $this->settle();
        $this->assertCount(2, $this->revisions($id));

        $kept = Purge::run(true);
        $this->assertSame(1, $kept['revisions']);
        $this->assertCount(1, $this->revisions($id), 'the baseline is kept');

        $all = Purge::run();
        $this->assertSame(1, $all['revisions']);
        $this->assertSame([], $this->revisions($id));
        $this->assertSame(0, (int) wp_count_terms(['taxonomy' => Batches::TAXONOMY, 'hide_empty' => false]));
    }

    public function test_classic_admin_save(): void
    {
        require_once ABSPATH.'wp-admin/includes/post.php';
        require_once ABSPATH.'wp-admin/includes/admin.php';
        require_once WC_ABSPATH.'includes/admin/meta-boxes/class-wc-meta-box-product-data.php';

        $product = $this->simpleProduct(['sku' => 'CL1']);
        $id = $product->get_id();
        $this->ready();
        set_current_screen('product');

        // What WC_Admin_Meta_Boxes does on save_post, without the nonce dance.
        $save = static function (int $postId, \WP_Post $post): void {
            if ($post->post_type === 'product') {
                \WC_Meta_Box_Product_Data::save($postId, $post);
            }
        };
        add_action('save_post', $save, 1, 2);

        $_POST = [
            'post_ID' => $id,
            'post_type' => 'product',
            'post_title' => 'Classic boot',
            'content' => '',
            'excerpt' => '',
            'post_status' => 'publish',
            'action' => 'editpost',
            'product-type' => 'simple',
            '_sku' => 'CL1',
            '_regular_price' => '175',
            '_sale_price' => '',
            '_tax_status' => 'taxable',
            '_tax_class' => '',
            '_visibility' => 'visible',
            '_stock_status' => 'instock',
            '_backorders' => 'no',
            'comment_status' => 'open',
        ];

        try {
            edit_post();
        } finally {
            remove_action('save_post', $save, 1);
        }

        $this->assertSame('Classic boot', get_post($id)->post_title);
        $this->assertSame('175', get_post_meta($id, '_regular_price', true));

        $latest = $this->assertRevisionIsState($id, 2);
        $this->assertBaseline($id, 'post:post_title', 'Saga wide toe boot');
        $this->assertBaseline($id, 'meta:_regular_price', '189');
        $this->assertSame('admin', Batches::meta((string) $this->batchOf($latest))['source']);
        $this->assertDerived($id);

        $batch = (string) $this->batchOf($latest);
        $this->assertUndoRedo($batch, [$id => ['post:post_title' => 'Saga wide toe boot', 'meta:_regular_price' => '189']], [$id => ['post:post_title' => 'Classic boot', 'meta:_regular_price' => '175']]);
    }

    public function test_wc_v3_single_without_the_app_header(): void
    {
        $product = $this->simpleProduct(['sku' => 'W1']);
        $id = $product->get_id();

        $this->assertStatus(200, $this->request('PUT', '/wc/v3/products/'.$id, ['regular_price' => '120', 'name' => 'REST boot'], [ListMode::HEADER => '', ListMode::BATCH_HEADER => '']));

        $latest = $this->assertRevisionIsState($id, 2);
        $batch = (string) $this->batchOf($latest);
        $this->assertSame('rest', Batches::meta($batch)['source']);
        $this->assertDerived($id);

        $this->assertUndoRedo($batch, [$id => ['meta:_regular_price' => '189', 'post:post_title' => 'Saga wide toe boot']], [$id => ['meta:_regular_price' => '120', 'post:post_title' => 'REST boot']]);
    }

    public function test_wc_v3_batch_with_the_app_header_is_one_batch(): void
    {
        $a = $this->simpleProduct(['sku' => 'B1'])->get_id();
        $b = $this->simpleProduct(['sku' => 'B2'])->get_id();

        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $a, 'sale_price' => '150'],
            ['id' => $b, 'sale_price' => '151'],
        ]], ['X-WC-Products-List-Source' => 'bulk']));

        $this->assertRevisionIsState($a, 2, $this->batchId());
        $this->assertRevisionIsState($b, 2, $this->batchId());
        $this->assertSame('bulk', Batches::meta($this->batchId())['source']);
        $this->assertSame(2, count(Batches::revisions($this->batchId())));
        $this->assertDerived($a);

        $this->assertUndoRedo($this->batchId(), [$a => ['meta:_sale_price' => null], $b => ['meta:_sale_price' => null]], [$a => ['meta:_sale_price' => '150'], $b => ['meta:_sale_price' => '151']]);
    }

    public function test_our_variations_batch_across_parents(): void
    {
        $p1 = $this->variableProduct(['38', '39']);
        $p2 = $this->variableProduct(['40', '41']);
        [$a, $b] = $p1->get_children();
        [$c, $d] = $p2->get_children();
        $this->ready();
        $parentRevisions = $this->revisions($p1->get_id());

        $response = $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [
            ['id' => $a, 'sale_price' => '99', 'date_on_sale_to' => '2030-01-31'],
            ['id' => $b, 'regular_price' => '200'],
            ['id' => $c, 'sale_price' => '98'],
            ['id' => $d, 'sale_price' => '97', 'stock_quantity' => 5, 'manage_stock' => true],
        ]], ['X-WC-Products-List-Source' => 'bulk']);
        $this->assertStatus(200, $response);

        foreach ([$a, $b, $c, $d] as $id) {
            $this->assertRevisionIsState($id, 2, $this->batchId());
            $this->assertDerived($id);
        }

        $this->assertSame(4, count(Batches::revisions($this->batchId())));
        $this->assertSame($parentRevisions, $this->revisions($p1->get_id()), 'the parent sync changes no revisioned state');

        $this->assertUndoRedo(
            $this->batchId(),
            [$a => ['meta:_sale_price' => null, 'meta:_sale_price_dates_to' => null], $b => ['meta:_regular_price' => '189'], $c => ['meta:_sale_price' => null], $d => ['meta:_sale_price' => null, 'meta:_manage_stock' => 'no']],
            [$a => ['meta:_sale_price' => '99'], $b => ['meta:_regular_price' => '200'], $c => ['meta:_sale_price' => '98'], $d => ['meta:_sale_price' => '97', 'meta:_stock' => '5']]
        );
    }

    public function test_csv_import(): void
    {
        include_once WC_ABSPATH.'includes/import/class-wc-product-csv-importer.php';

        $product = $this->simpleProduct(['sku' => 'CSV1']);
        $id = $product->get_id();

        $file = get_temp_dir().'wcpl-import-'.wp_generate_password(8, false).'.csv';
        file_put_contents($file, "ID,Regular price,Name\n{$id},77,Imported boot\n");

        $importer = new \WC_Product_CSV_Importer($file, [
            'update_existing' => true,
            'mapping' => ['ID' => 'id', 'Regular price' => 'regular_price', 'Name' => 'name'],
            'parse' => true,
            'prevent_timeouts' => false,
        ]);
        $result = $importer->import();
        unlink($file);

        $this->assertCount(1, $result['updated'], wp_json_encode($result));

        $latest = $this->assertRevisionIsState($id, 2);
        $batch = (string) $this->batchOf($latest);
        $this->assertSame('import', Batches::meta($batch)['source']);
        $this->assertDerived($id);

        $this->assertUndoRedo($batch, [$id => ['meta:_regular_price' => '189', 'post:post_title' => 'Saga wide toe boot']], [$id => ['meta:_regular_price' => '77', 'post:post_title' => 'Imported boot']]);
    }

    public function test_plain_crud_save_as_wp_cli_does(): void
    {
        $parent = $this->variableProduct(['38', '39']);
        [$v38, $v39] = $parent->get_children();
        $this->ready();

        foreach ([$v38, $v39] as $id) {
            $variation = wc_get_product($id);
            $variation->set_sale_price('120');
            $variation->save();
        }

        $first = $this->assertRevisionIsState($v38, 2);
        $this->assertRevisionIsState($v39, 2);
        $batch = (string) $this->batchOf($first);
        $this->assertSame($batch, $this->batchOf($this->revisions($v39)[0]), 'one batch per process outside REST');
        $this->assertSame('php', Batches::meta($batch)['source']);
        $this->assertDerived($v38);

        $this->assertUndoRedo($batch, [$v38 => ['meta:_sale_price' => null], $v39 => ['meta:_sale_price' => null]], [$v38 => ['meta:_sale_price' => '120'], $v39 => ['meta:_sale_price' => '120']]);
    }

    public function test_undo_leaves_later_changes_alone(): void
    {
        $id = $this->simpleProduct(['sku' => 'C1'])->get_id();
        $product = wc_get_product($id);
        $product->set_sale_price('150');
        $product->save();
        $this->settle();
        $batch = (string) $this->batchOf($this->revisions($id)[0]);

        Batches::reset();
        $product = wc_get_product($id);
        $product->set_sale_price('140');
        $product->save();
        $this->settle();

        $undo = Restore::undoAll($batch);
        $this->assertSame(1, $undo['conflicts']);
        $this->assertSame('140', get_post_meta($id, '_sale_price', true));
    }

    public function test_core_restore_button_goes_through_crud(): void
    {
        $id = $this->simpleProduct(['sku' => 'R1'])->get_id();
        $product = wc_get_product($id);
        $product->set_name('Changed');
        $product->set_sale_price('150');
        $product->save();
        $this->settle();

        $baseline = (int) min($this->revisions($id));
        wp_restore_post_revision($baseline);
        $this->settle();

        $this->assertSame('Saga wide toe boot', get_post($id)->post_title);
        $this->assertSame('', get_post_meta($id, '_sale_price', true));
        $this->assertDerived($id);
        // Baseline, the change, the restore: core's half-restored revision is gone.
        $this->assertRevisionIsState($id, 3);
    }

    public function test_retention_prunes_variations_to_the_limit(): void
    {
        add_filter(History::FILTER_OPTIONS, static fn (array $options): array => ['keep_variation' => 3] + $options);
        History::resetOptions();

        $parent = $this->variableProduct(['38']);
        [$v38] = $parent->get_children();

        foreach (['101', '102', '103', '104', '105'] as $price) {
            $variation = wc_get_product($v38);
            $variation->set_regular_price($price);
            $variation->save();
        }

        $this->assertRevisionIsState($v38, 3);
    }

    private function logRows(string $batch): int
    {
        global $wpdb;

        $table = Table::name();

        return (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$table} WHERE batch_id = %s AND status = 'ok'", $batch)); // phpcs:ignore
    }

    private function bulkSale(): array
    {
        $parent = $this->variableProduct(['38', '39']);
        $simple = $this->simpleProduct(['sku' => 'M1'])->get_id();
        [$a, $b] = $parent->get_children();
        $this->ready();

        $this->assertStatus(200, $this->request('POST', '/wc-products-list/v1/variations/batch', ['update' => [
            ['id' => $a, 'sale_price' => '99', 'i18n' => ['se' => ['description' => 'x']]],
            ['id' => $b, 'sale_price' => '98', 'date_on_sale_to' => '2030-01-31'],
        ]], ['X-WC-Products-List-Source' => 'bulk']));
        $this->assertStatus(200, $this->request('POST', '/wc/v3/products/batch', ['update' => [
            ['id' => $simple, 'regular_price' => '120', 'name' => 'Both boot'],
        ]], ['X-WC-Products-List-Source' => 'bulk']));
        $this->settle();

        return [$a, $b, $simple];
    }

    public function test_default_log_mode_records_no_revisions(): void
    {
        History::switchTo('log');
        [$a, , $simple] = $this->bulkSale();

        $this->assertSame([], $this->revisions($a));
        $this->assertSame([], $this->revisions($simple));
        $this->assertGreaterThan(0, $this->logRows($this->batchId()));
        $this->assertNull(Batches::term($this->batchId()));
        $this->assertFalse(post_type_supports('product_variation', 'revisions'));
    }

    public function test_both_mode_records_the_log_and_revisions_under_one_batch(): void
    {
        [$a, $b, $simple] = $this->bulkSale();

        $this->assertSame(5, $this->logRows($this->batchId()));
        $this->assertSame(3, count(Batches::revisions($this->batchId())));

        $compare = Compare::run($this->batchId());
        $this->assertSame(3, $compare['summary']['objects']);
        $this->assertSame(3, $compare['summary']['match'], wp_json_encode($compare['objects']));
        $this->assertSame(3, $compare['revisions']['undo_dry_run']['restored']);
        $this->assertSame(0, $compare['log']['undo_would_skip_changed']);

        // The log's own revert still works in `both` mode, and takes revisions too.
        Restore::undoAll($this->batchId());
        $this->settle();
        $this->assertSame('', get_post_meta($a, '_sale_price', true));
        $this->assertSame('189', get_post_meta($simple, '_regular_price', true));
        $this->assertDerived($b);
    }

    public function test_revisions_mode_keeps_the_log_quiet(): void
    {
        History::switchTo('revisions');
        [$a] = $this->bulkSale();

        $this->assertSame(0, $this->logRows($this->batchId()));
        $this->assertSame(3, count(Batches::revisions($this->batchId())));
        $this->assertRevisionIsState($a, 2, $this->batchId());
    }
}
