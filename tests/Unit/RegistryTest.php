<?php

namespace GeneroWP\ProductsList\Tests\Unit;

use GeneroWP\ProductsList\Registry;
use PHPUnit\Framework\TestCase;

class RegistryTest extends TestCase
{
    public function test_field_defaults(): void
    {
        $field = Registry::normaliseField(['id' => 'i18n:se.name', 'label' => 'Name (Svenska)', 'path' => 'i18n.se.name.value', 'writePath' => 'i18n.se.name', 'reference' => 'name', 'group' => 'i18n:se']);

        $this->assertSame('text', $field['type']);
        $this->assertSame('i18n.se.name.value', $field['path']);
        $this->assertSame('i18n', $field['writeKey']);
        $this->assertSame('i18n:se', $field['tab']);
        $this->assertTrue($field['editable']);
        $this->assertSame('default', $field['bulk']);
        $this->assertSame(['product' => true, 'variation' => false], $field['applies']);
        $this->assertSame(['i18n'], $field['restFields']);
        $this->assertFalse($field['visible']);
        $this->assertSame(100, $field['order']);
    }

    public function test_price_fields_bulk_edit_as_money_and_readonly_fields_never(): void
    {
        $price = Registry::normaliseField(['id' => 'i18n:se.sale_price', 'type' => 'price', 'applies' => ['product' => ['simple', 'external'], 'variation' => true]]);
        $this->assertSame('money', $price['bulk']);
        $this->assertSame(['simple', 'external'], $price['applies']['product']);
        $this->assertTrue($price['applies']['variation']);

        $name = Registry::normaliseField(['id' => 'i18n:se.variation_name', 'readonly' => true, 'bulk' => 'money']);
        $this->assertFalse($name['editable']);
        $this->assertFalse($name['bulk']);
    }

    public function test_optional_extras_pass_through_and_non_scalars_are_dropped(): void
    {
        $field = Registry::normaliseField(['id' => 'i18n:se.sale_price', 'type' => 'price', 'referenceLabel' => 'No Svenska price; showing the Suomi price converted', 'currency' => 'sek', 'precision' => '2']);

        $this->assertSame('No Svenska price; showing the Suomi price converted', $field['referenceLabel']);
        $this->assertSame('SEK', $field['currency']);
        $this->assertSame(2, $field['precision']);

        $plain = Registry::normaliseField(['id' => 'i18n:se.name', 'referenceLabel' => ['not' => 'scalar'], 'currency' => '', 'precision' => 'two']);

        $this->assertArrayNotHasKey('referenceLabel', $plain);
        $this->assertArrayNotHasKey('currency', $plain);
        $this->assertArrayNotHasKey('precision', $plain);
    }

    public function test_invalid_ids_and_types_are_rejected_or_defaulted(): void
    {
        $this->assertNull(Registry::normaliseField([]));
        $this->assertNull(Registry::normaliseField(['id' => 'Not Valid']));
        $this->assertSame('text', Registry::normaliseField(['id' => 'x', 'type' => 'rocket'])['type']);
        $this->assertNull(Registry::normaliseFilter(['id' => 'nothing']));
    }

    public function test_filter_options_map_to_params(): void
    {
        $filter = Registry::normaliseFilter([
            'id' => 'translation',
            'label' => 'Translation',
            'options' => [
                ['value' => 'missing:se', 'label' => 'Missing in Svenska', 'params' => ['gds_i18n[lang]' => 'se', 'gds_i18n[status]' => 'missing']],
            ],
            'isPrimary' => true,
        ]);

        $this->assertSame('select', $filter['type']);
        $this->assertNull($filter['param']);
        $this->assertSame(['gds_i18n[lang]' => 'se', 'gds_i18n[status]' => 'missing'], $filter['options'][0]['params']);
        $this->assertTrue($filter['isPrimary']);

        $simple = Registry::normaliseFilter(['id' => 'brand', 'param' => 'brand', 'options' => ['12' => 'Saga']]);
        $this->assertSame([['value' => '12', 'label' => 'Saga', 'params' => ['brand' => '12']]], $simple['options']);
    }

    public function test_action_args_and_scope(): void
    {
        $action = Registry::normaliseAction([
            'id' => 'i18n_copy',
            'label' => 'Copy default language',
            'scope' => 'both',
            'args' => [
                'lang' => ['label' => 'Language', 'type' => 'select', 'required' => true, 'options' => ['se' => 'Svenska']],
                ['id' => 'overwrite', 'type' => 'boolean', 'default' => false],
            ],
        ]);

        $this->assertSame('both', $action['scope']);
        $this->assertTrue($action['supportsBulk']);
        $this->assertCount(2, $action['args']);
        $this->assertSame('lang', $action['args'][0]['id']);
        $this->assertSame([['value' => 'se', 'label' => 'Svenska']], $action['args'][0]['options']);
        $this->assertSame('overwrite', $action['args'][1]['id']);
        $this->assertFalse($action['args'][1]['default']);
        $this->assertSame('product', Registry::normaliseAction(['id' => 'x', 'scope' => 'galaxy'])['scope']);
    }

    public function test_array_args_keep_their_type_and_list_default(): void
    {
        $action = Registry::normaliseAction([
            'id' => 'i18n_copy',
            'args' => [
                ['id' => 'fields', 'type' => 'array', 'default' => ['name', 'slug'], 'options' => ['name' => 'Name', 'slug' => 'Slug']],
                ['id' => 'nope', 'type' => 'galaxy'],
            ],
        ]);

        $this->assertSame('array', $action['args'][0]['type']);
        $this->assertSame(['name', 'slug'], $action['args'][0]['default']);
        $this->assertSame([['value' => 'name', 'label' => 'Name'], ['value' => 'slug', 'label' => 'Slug']], $action['args'][0]['options']);
        $this->assertSame('text', $action['args'][1]['type']);
    }

    public function test_paths_and_operators_are_validated(): void
    {
        $field = Registry::normaliseField([
            'id' => 'i18n:se.name',
            'path' => 'i18n.se.name.value',
            'reference' => 'bad path!',
            'writePath' => 'i18n.se.name',
            'restFields' => ['i18n', 'name'],
            'filter' => ['param' => 'gds_i18n', 'operators' => ['is', 'rocket', 'isAny']],
        ]);

        $this->assertNull($field['reference']);
        $this->assertSame(['i18n', 'name'], $field['restFields']);
        $this->assertSame(['is', 'isAny'], $field['filter']['operators']);

        $broken = Registry::normaliseField(['id' => 'x', 'path' => 'not a path', 'writePath' => '..', 'writeKey' => 'ok']);
        $this->assertSame('x', $broken['path']);
        $this->assertSame(['x'], $broken['restFields']);
        $this->assertNull($broken['writePath']);
        $this->assertSame('ok', $broken['writeKey']);

        $filter = Registry::normaliseFilter(['id' => 'stock', 'param' => 'min_stock_quantity', 'type' => 'number', 'operators' => ['nope']]);
        $this->assertSame(['is'], $filter['operators']);
        $this->assertSame('number', $filter['type']);
    }

    public function test_explicit_write_key_wins_over_the_path(): void
    {
        $field = Registry::normaliseField(['id' => 'meta:cost', 'writePath' => 'meta_data.cost', 'writeKey' => 'meta_data']);
        $this->assertSame('meta_data', $field['writeKey']);

        $field = Registry::normaliseField(['id' => 'plain']);
        $this->assertNull($field['writeKey']);
        $this->assertNull($field['writePath']);
    }
}
