<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\History\Batches;
use GeneroWP\ProductsList\History\History;
use GeneroWP\ProductsList\History\Restore;
use GeneroWP\ProductsList\History\Revisions;
use GeneroWP\ProductsList\ListMode;
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

        // Defined here, not when the file loads: PHPUnit loads every test
        // file before the first test, and the rest of the suite runs
        // without revisions. History::toggle(false) takes it out again.
        if (! defined('WC_PRODUCTS_LIST_HISTORY')) {
            define('WC_PRODUCTS_LIST_HISTORY', 'revisions');
        }

        if (! self::$registered) {
            (new History)->register();
            self::$registered = true;
        } else {
            History::toggle(true);
        }

        History::resetOptions();
        Revisions::forget();
        Batches::reset();

        // Stand-in for gds-woo-i18n, which the suite does not load.
        add_filter(Revisions::FILTER_META_KEYS, [self::class, 'i18nKeys'], 10, 2);
    }

    public function tear_down(): void
    {
        remove_filter(Revisions::FILTER_META_KEYS, [self::class, 'i18nKeys'], 10);
        remove_all_filters(History::FILTER_OPTIONS);
        Batches::reset();
        Revisions::forget();
        History::toggle(false);
        $_POST = [];
        set_current_screen('front');

        parent::tear_down();
    }

    /**
     * @param  array<int, string>  $keys
     * @return array<int, string>
     */
    public static function i18nKeys(array $keys, string $postType): array
    {
        $fields = $postType === 'product_variation' ? ['description', 'regular_price'] : ['name', 'description'];

        foreach ($fields as $field) {
            $keys[] = '_i18n_'.$field.'_se';
        }

        return $keys;
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

    public function test_lean_writer_and_packed_storage_give_the_same_history(): void
    {
        add_filter(History::FILTER_OPTIONS, static fn (array $options): array => ['writer' => 'lean', 'storage' => 'packed'] + $options);
        History::resetOptions();

        $parent = $this->variableProduct(['38', '39']);
        [$v38] = $parent->get_children();
        $this->ready();
        $variation = wc_get_product($v38);
        $variation->set_sale_price('149');
        $variation->save();

        $this->assertRevisionIsState($v38, 2);
        $this->assertBaseline($v38, 'meta:_sale_price', null);
        $this->assertSame(['_wcpl_snapshot'], array_keys(get_metadata('post', $this->revisions($v38)[0])));

        $batch = (string) $this->batchOf($this->revisions($v38)[0]);
        $this->assertUndoRedo($batch, [$v38 => ['meta:_sale_price' => null]], [$v38 => ['meta:_sale_price' => '149']]);
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
}
