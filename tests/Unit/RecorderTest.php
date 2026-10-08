<?php

namespace GeneroWP\ProductsList\Tests\Unit;

use GeneroWP\ProductsList\Log\Recorder;
use GeneroWP\ProductsList\Log\Revert;
use PHPUnit\Framework\TestCase;

/**
 * The pure parts of the change log: which fields a request touches, how
 * values are stored and compared, and how a batch is turned back into
 * the writes that undo it.
 */
class RecorderTest extends TestCase
{
    public function test_paths_are_the_top_level_keys_with_meta_and_extension_leaves(): void
    {
        $paths = Recorder::paths([
            'id' => 12,
            'product_id' => 3,
            'regular_price' => '189',
            'sale_price' => '',
            'categories' => [['id' => 1], ['id' => 2]],
            'dimensions' => ['length' => '1', 'width' => '2', 'height' => '3'],
            'meta_data' => [['key' => '_custom', 'value' => 'x'], ['key' => '', 'value' => 'ignored'], 'junk'],
            'i18n' => ['se' => ['name' => 'Saga', 'sale_price' => '99'], 'en' => ['name' => '']],
            'ext_flag' => true,
            'ext_list' => ['a', 'b'],
        ]);

        $this->assertSame([
            'regular_price',
            'sale_price',
            'categories',
            'dimensions',
            'meta_data._custom',
            'i18n.se.name',
            'i18n.se.sale_price',
            'i18n.en.name',
            'ext_flag',
            'ext_list',
        ], $paths);
    }

    public function test_serialize_keeps_scalars_and_encodes_arrays(): void
    {
        $this->assertNull(Recorder::serialize(null));
        $this->assertSame('true', Recorder::serialize(true));
        $this->assertSame('false', Recorder::serialize(false));
        $this->assertSame('12.5', Recorder::serialize('12.5'));
        $this->assertSame('7', Recorder::serialize(7));
        $this->assertSame('[{"id":1},{"id":2}]', Recorder::serialize([['id' => 1], ['id' => 2]]));
        $this->assertSame('{"length":"1","width":"","height":"ä/ö"}', Recorder::serialize(['length' => '1', 'width' => '', 'height' => 'ä/ö']));
        $this->assertSame('2026-10-08T10:00:00', Recorder::serialize(new \DateTimeImmutable('2026-10-08 10:00:00')));
    }

    public function test_diff_reports_changed_fields_only_and_treats_null_and_empty_alike(): void
    {
        $before = ['regular_price' => '189', 'sale_price' => '', 'date_on_sale_from' => null, 'name' => 'Saga', 'i18n.se.name' => ''];
        $after = ['regular_price' => '189', 'sale_price' => '149', 'date_on_sale_from' => '', 'name' => 'Saga', 'i18n.se.name' => 'Saga SE'];

        $this->assertSame([
            'sale_price' => ['old' => '', 'new' => '149'],
            'i18n.se.name' => ['old' => '', 'new' => 'Saga SE'],
        ], Recorder::diff($before, $after));

        $this->assertSame([], Recorder::diff(['a' => null], ['a' => '']));
        $this->assertSame(['a' => ['old' => null, 'new' => '0']], Recorder::diff([], ['a' => '0']));
    }

    public function test_rows_carry_the_shared_columns(): void
    {
        $rows = Recorder::rows(
            ['sale_price' => ['old' => '', 'new' => '149'], 'status' => ['old' => 'draft', 'new' => 'publish']],
            ['action' => 'update', 'object_type' => 'variation', 'object_id' => 5, 'parent_id' => 4]
        );

        $this->assertCount(2, $rows);
        $this->assertSame('sale_price', $rows[0]['field']);
        $this->assertSame('', $rows[0]['old_value']);
        $this->assertSame('149', $rows[0]['new_value']);
        $this->assertSame('ok', $rows[0]['status']);
        $this->assertSame(5, $rows[0]['object_id']);
        $this->assertSame(4, $rows[1]['parent_id']);
        $this->assertSame('variation', $rows[1]['object_type']);
    }

    public function test_revert_plan_groups_update_rows_and_skips_the_rest(): void
    {
        $plan = Revert::plan([
            ['id' => 3, 'object_type' => 'product', 'object_id' => 10, 'parent_id' => 0, 'action' => 'update', 'status' => 'ok', 'field' => 'sale_price', 'old_value' => '', 'new_value' => '149'],
            ['id' => 4, 'object_type' => 'product', 'object_id' => 10, 'parent_id' => 0, 'action' => 'update', 'status' => 'ok', 'field' => 'sale_price', 'old_value' => '149', 'new_value' => '139'],
            ['id' => 1, 'object_type' => 'variation', 'object_id' => 21, 'parent_id' => 20, 'action' => 'update', 'status' => 'ok', 'field' => 'regular_price', 'old_value' => '189', 'new_value' => '199'],
            ['id' => 2, 'object_type' => 'variation', 'object_id' => 22, 'parent_id' => 20, 'action' => 'update', 'status' => 'ok', 'field' => 'date_on_sale_from', 'old_value' => null, 'new_value' => '2026-11-01T00:00:00'],
            ['id' => 5, 'object_type' => 'product', 'object_id' => 30, 'parent_id' => 0, 'action' => 'trash', 'status' => 'ok', 'field' => 'status', 'old_value' => 'publish', 'new_value' => 'trash'],
            ['id' => 6, 'object_type' => 'product', 'object_id' => 31, 'parent_id' => 0, 'action' => 'update', 'status' => 'error', 'field' => '', 'old_value' => null, 'new_value' => null],
            ['id' => 7, 'object_type' => 'product', 'object_id' => 10, 'parent_id' => 0, 'action' => 'duplicate', 'status' => 'ok', 'field' => '', 'old_value' => null, 'new_value' => null],
        ]);

        // The earliest old value is the original, even when rows arrive out of order.
        $this->assertSame([10 => ['sale_price' => '']], $plan['products']);
        $this->assertSame([20 => [21 => ['regular_price' => '189'], 22 => ['date_on_sale_from' => null]]], $plan['variations']);
        // Product 10 also has a duplicate row but is reverted, so only 30 and 31 are skipped.
        $this->assertSame([
            ['id' => 30, 'object_type' => 'product', 'action' => 'trash'],
            ['id' => 31, 'object_type' => 'product', 'action' => 'update'],
        ], $plan['skipped']);
    }

    public function test_revert_body_rebuilds_the_request_shape(): void
    {
        $body = Revert::body(10, [
            'sale_price' => '',
            'date_on_sale_from' => null,
            'manage_stock' => 'true',
            'categories' => '[{"id":1},{"id":2}]',
            'dimensions' => '{"length":"1","width":"2","height":"3"}',
            'meta_data._custom' => 'x',
            'meta_data._other' => '["a","b"]',
            'i18n.se.name' => 'Saga',
            'i18n.se.sale_price' => null,
            'i18n.en.name' => 'Boot',
        ]);

        $this->assertSame(10, $body['id']);
        $this->assertSame('', $body['sale_price']);
        $this->assertSame('', $body['date_on_sale_from']);
        $this->assertTrue($body['manage_stock']);
        $this->assertSame([['id' => 1], ['id' => 2]], $body['categories']);
        $this->assertSame(['length' => '1', 'width' => '2', 'height' => '3'], $body['dimensions']);
        $this->assertSame([['key' => '_custom', 'value' => 'x'], ['key' => '_other', 'value' => ['a', 'b']]], $body['meta_data']);
        $this->assertSame(['se' => ['name' => 'Saga', 'sale_price' => ''], 'en' => ['name' => 'Boot']], $body['i18n']);
    }

    public function test_passwords_are_logged_as_a_marker_not_a_value(): void
    {
        $this->assertNull(Recorder::mask(null));
        $this->assertSame('', Recorder::mask(''));

        $masked = Recorder::mask('open sesame');
        $this->assertStringStartsWith(Recorder::MASK_PREFIX, $masked);
        $this->assertSame(11, strlen($masked));
        $this->assertStringNotContainsString('sesame', $masked);
        // Same input, same marker; another input, another marker: a change still yields a row.
        $this->assertSame($masked, Recorder::mask('open sesame'));
        $this->assertNotSame($masked, Recorder::mask('open sesam'));

        $this->assertTrue(Recorder::isMasked('post_password'));
        $this->assertFalse(Recorder::isMasked('name'));
        $this->assertContains('post_password', Recorder::MASKED_KEYS);
    }

    public function test_revert_plan_skips_masked_fields(): void
    {
        $plan = Revert::plan([
            ['id' => 1, 'object_type' => 'product', 'object_id' => 10, 'parent_id' => 0, 'action' => 'update', 'status' => 'ok', 'field' => 'post_password', 'old_value' => '', 'new_value' => '***abcdef12'],
            ['id' => 2, 'object_type' => 'product', 'object_id' => 11, 'parent_id' => 0, 'action' => 'update', 'status' => 'ok', 'field' => 'post_password', 'old_value' => '***abcdef12', 'new_value' => ''],
            ['id' => 3, 'object_type' => 'product', 'object_id' => 11, 'parent_id' => 0, 'action' => 'update', 'status' => 'ok', 'field' => 'name', 'old_value' => 'A', 'new_value' => 'B'],
        ]);

        // Nothing is ever posted back for the password; 11 is still reverted for its name.
        $this->assertSame([11 => ['name' => 'A']], $plan['products']);
        $this->assertSame([['id' => 10, 'object_type' => 'product', 'action' => 'masked']], $plan['skipped']);
    }

    public function test_revert_body_deletes_meta_that_did_not_exist_before(): void
    {
        $body = Revert::body(10, [
            'meta_data._added' => null,
            'meta_data._emptied' => '',
            'meta_data._changed' => 'before',
        ]);

        $this->assertSame([
            ['key' => '_added', 'value' => null],
            ['key' => '_emptied', 'value' => ''],
            ['key' => '_changed', 'value' => 'before'],
        ], $body['meta_data']);

        // Top-level fields still clear with '' (how wc/v3 clears a price or a date).
        $this->assertSame('', Revert::body(10, ['sale_price' => null])['sale_price']);
    }

    public function test_revert_decode_leaves_non_json_strings_alone(): void
    {
        $this->assertSame('[not json', Revert::decode('[not json'));
        $this->assertSame('189', Revert::decode('189'));
        $this->assertSame('', Revert::decode(null));
        $this->assertFalse(Revert::decode('false'));
        $this->assertSame([], Revert::decode('[]'));
    }
}
