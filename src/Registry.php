<?php

namespace GeneroWP\ProductsList;

/**
 * The declarative extension layer: PHP-side field, filter and action
 * definitions are collected through filters, normalised to one shape and
 * serialised into `window.wcProductsListSettings`, where the JS core turns
 * them into DataViews fields, filters and actions. An integration such as
 * gds-woo-i18n needs no JavaScript for this.
 *
 * The lists are collected once per request (`reset()` drops the memo, for
 * tests and for code that registers definitions late). Keep
 * `normaliseField()` and friends pure: the unit suite runs them without
 * WordPress.
 *
 * @phpstan-type FieldDef array{
 *     id: string, label: string, type: string, description: string,
 *     path: string, reference: ?string, writeKey: ?string, writePath: ?string,
 *     editable: bool, bulk: string|false, readonly: bool,
 *     applies: array{product: array<int, string>|true, variation: bool},
 *     options: array<int, array{value: string, label: string}>,
 *     group: ?string, tab: ?string, visible: bool, order: int,
 *     enableSorting: bool, sortParam: ?string, restFields: array<int, string>,
 *     filter: ?array{param: string, operators: array<int, string>}, width: ?int,
 *     source: string
 * }
 * @phpstan-type FilterDef array{
 *     id: string, label: string, type: string, param: ?string,
 *     options: array<int, array{value: string, label: string, params: array<string, mixed>}>,
 *     operators: array<int, string>, isPrimary: bool, multiple: bool, variations: bool,
 *     order: int, source: string
 * }
 * @phpstan-type ActionDef array{
 *     id: string, label: string, description: string, icon: ?string,
 *     scope: string, supportsBulk: bool, isPrimary: bool, destructive: bool,
 *     confirm: ?string, capability: ?string, group: ?string, order: int,
 *     args: array<int, array{id: string, label: string, type: string, required: bool, default: mixed, options: array<int, array{value: string, label: string}>}>,
 *     source: string
 * }
 */
final class Registry
{
    public const FILTER_FIELDS = 'wc_products_list/fields';

    public const FILTER_FILTERS = 'wc_products_list/filters';

    public const FILTER_ACTIONS = 'wc_products_list/actions';

    public const FIELD_TYPES = ['text', 'html', 'price', 'integer', 'number', 'boolean', 'select', 'date', 'datetime', 'media', 'array'];

    public const BULK_MODES = ['money', 'integer', 'default'];

    public const FILTER_TYPES = ['select', 'text', 'boolean', 'number', 'date'];

    public const ACTION_SCOPES = ['product', 'variation', 'both'];

    /** `array` renders as a checkbox group over `options` and posts a list. */
    public const ARG_TYPES = ['text', 'select', 'boolean', 'integer', 'number', 'array'];

    /** The DataViews filter operators. Unknown ones are dropped; none left means `is`. */
    public const OPERATORS = [
        'is', 'isNot', 'isAny', 'isNone', 'isAll', 'isNotAll',
        'lessThan', 'greaterThan', 'lessThanOrEqual', 'greaterThanOrEqual', 'between',
        'on', 'notOn', 'before', 'after', 'beforeInc', 'afterInc', 'inThePast', 'over',
        'contains', 'notContains', 'startsWith',
    ];

    /** A dot path into a row or a request body: `i18n.se.name.value`. */
    private const PATH = '/^[A-Za-z0-9_\-]+(\.[A-Za-z0-9_\-]+)*$/';

    /** @var array<int, FieldDef>|null */
    private static ?array $fields = null;

    /** @var array<int, FilterDef>|null */
    private static ?array $filters = null;

    /** @var array<int, ActionDef>|null */
    private static ?array $actions = null;

    /**
     * Forget the collected definitions so the filters run again.
     */
    public static function reset(): void
    {
        self::$fields = null;
        self::$filters = null;
        self::$actions = null;
    }

    /**
     * @return array<int, FieldDef>
     */
    public static function fields(): array
    {
        /**
         * Filters the declarative field definitions. Each entry is an array
         * keyed by the properties documented in docs/contracts.md; `id` is
         * required, everything else has a default.
         *
         * @param  array<int|string, array<string, mixed>>  $fields
         */
        return self::$fields ??= self::collect(apply_filters(self::FILTER_FIELDS, []), [self::class, 'normaliseField']);
    }

    /**
     * @return FieldDef|null
     */
    public static function field(string $id): ?array
    {
        foreach (self::fields() as $field) {
            if ($field['id'] === $id) {
                return $field;
            }
        }

        return null;
    }

    /**
     * @return array<int, FilterDef>
     */
    public static function filters(): array
    {
        /**
         * Filters the declarative filter definitions.
         *
         * @param  array<int|string, array<string, mixed>>  $filters
         */
        return self::$filters ??= self::collect(apply_filters(self::FILTER_FILTERS, []), [self::class, 'normaliseFilter']);
    }

    /**
     * Declarative action definitions: what the app renders. The PHP handlers
     * for them are registered with the Actions module.
     *
     * @return array<int, ActionDef>
     */
    public static function actions(): array
    {
        /**
         * Filters the declarative action definitions.
         *
         * @param  array<int|string, array<string, mixed>>  $actions
         */
        return self::$actions ??= self::collect(apply_filters(self::FILTER_ACTIONS, []), [self::class, 'normaliseAction']);
    }

    /**
     * The top-level request keys that extension fields write under. The Saves
     * hook only fires `wc_products_list/save` when one of these is present.
     *
     * @return array<int, string>
     */
    public static function writeKeys(): array
    {
        $keys = [];

        foreach (self::fields() as $field) {
            if ($field['writeKey'] !== null) {
                $keys[$field['writeKey']] = true;
            }
        }

        return array_keys($keys);
    }

    /**
     * The fields that write under a request key, e.g. every `i18n` field.
     * The save hook uses it to know which paths of the body to snapshot.
     *
     * @return array<int, FieldDef>
     */
    public static function fieldsByWriteKey(string $writeKey): array
    {
        return array_values(array_filter(
            self::fields(),
            static fn (array $field): bool => $field['writeKey'] === $writeKey && $field['editable']
        ));
    }

    /**
     * @param  array<string, mixed>  $def
     * @return FieldDef|null
     */
    public static function normaliseField(array $def): ?array
    {
        $id = self::id($def['id'] ?? null);

        if ($id === null) {
            return null;
        }

        $type = (string) ($def['type'] ?? 'text');
        $type = in_array($type, self::FIELD_TYPES, true) ? $type : 'text';

        $bulk = $def['bulk'] ?? null;

        if ($bulk === null) {
            $bulk = match ($type) {
                'price' => 'money',
                'integer' => 'integer',
                default => 'default',
            };
        } elseif ($bulk !== false && ! in_array($bulk, self::BULK_MODES, true)) {
            $bulk = 'default';
        }

        $editable = (bool) ($def['editable'] ?? true);
        $readonly = (bool) ($def['readonly'] ?? ! $editable);

        $applies = is_array($def['applies'] ?? null) ? $def['applies'] : [];
        $product = $applies['product'] ?? true;
        $product = $product === true ? true : array_values(array_filter(array_map('strval', (array) $product)));

        $filter = null;

        if (is_array($def['filter'] ?? null) && isset($def['filter']['param']) && is_scalar($def['filter']['param'])) {
            $filter = [
                'param' => (string) $def['filter']['param'],
                'operators' => self::operators($def['filter']['operators'] ?? null),
            ];
        }

        $path = self::path($def['path'] ?? null) ?? $id;
        $reference = self::path($def['reference'] ?? null);
        $writePath = self::path($def['writePath'] ?? null);
        $writeKey = isset($def['writeKey']) && is_scalar($def['writeKey']) ? self::path((string) $def['writeKey']) : null;

        if ($writeKey === null && $writePath !== null) {
            $writeKey = explode('.', $writePath, 2)[0];
        }

        $restFields = self::strings($def['restFields'] ?? []);

        if ($restFields === []) {
            $restFields = [explode('.', $path, 2)[0]];
        }

        return [
            'id' => $id,
            'label' => (string) ($def['label'] ?? $id),
            'type' => $type,
            'description' => (string) ($def['description'] ?? ''),
            'path' => $path,
            'reference' => $reference,
            'writeKey' => $writeKey,
            'writePath' => $writePath,
            'editable' => $editable && ! $readonly,
            'bulk' => $editable && ! $readonly ? $bulk : false,
            'readonly' => $readonly,
            'applies' => [
                'product' => $product,
                'variation' => (bool) ($applies['variation'] ?? false),
            ],
            'options' => self::options($def['options'] ?? []),
            'group' => isset($def['group']) ? (string) $def['group'] : null,
            'tab' => isset($def['tab']) ? (string) $def['tab'] : (isset($def['group']) ? (string) $def['group'] : null),
            'visible' => (bool) ($def['visible'] ?? false),
            'order' => (int) ($def['order'] ?? 100),
            'enableSorting' => (bool) ($def['enableSorting'] ?? false),
            'sortParam' => isset($def['sortParam']) ? (string) $def['sortParam'] : null,
            'restFields' => $restFields,
            'filter' => $filter,
            'width' => isset($def['width']) ? (int) $def['width'] : null,
            'source' => (string) ($def['source'] ?? 'extension'),
            // Optional extras the app reads when present (DeclarativeFieldExtras):
            // what the reference companion is, a price column's currency, its precision.
            ...(isset($def['referenceLabel']) && is_scalar($def['referenceLabel']) ? ['referenceLabel' => (string) $def['referenceLabel']] : []),
            ...(isset($def['currency']) && is_scalar($def['currency']) && (string) $def['currency'] !== '' ? ['currency' => strtoupper((string) $def['currency'])] : []),
            ...(isset($def['precision']) && is_numeric($def['precision']) ? ['precision' => max(0, (int) $def['precision'])] : []),
        ];
    }

    /**
     * @param  array<string, mixed>  $def
     * @return FilterDef|null
     */
    public static function normaliseFilter(array $def): ?array
    {
        $id = self::id($def['id'] ?? null);

        if ($id === null) {
            return null;
        }

        $type = (string) ($def['type'] ?? 'select');
        $type = in_array($type, self::FILTER_TYPES, true) ? $type : 'select';
        $param = isset($def['param']) ? (string) $def['param'] : null;

        $options = [];

        foreach ((array) ($def['options'] ?? []) as $value => $option) {
            if (is_array($option)) {
                $optionValue = (string) ($option['value'] ?? $value);
                $options[] = [
                    'value' => $optionValue,
                    'label' => (string) ($option['label'] ?? $optionValue),
                    'params' => is_array($option['params'] ?? null)
                        ? $option['params']
                        : ($param !== null ? [$param => $optionValue] : []),
                ];
            } else {
                $options[] = [
                    'value' => (string) $value,
                    'label' => (string) $option,
                    'params' => $param !== null ? [$param => (string) $value] : [],
                ];
            }
        }

        if ($param === null && $options === []) {
            return null;
        }

        return [
            'id' => $id,
            'label' => (string) ($def['label'] ?? $id),
            'type' => $type,
            'param' => $param,
            'options' => $options,
            'operators' => self::operators($def['operators'] ?? null),
            'isPrimary' => (bool) ($def['isPrimary'] ?? false),
            'multiple' => (bool) ($def['multiple'] ?? false),
            'variations' => (bool) ($def['variations'] ?? false),
            'order' => (int) ($def['order'] ?? 100),
            'source' => (string) ($def['source'] ?? 'extension'),
        ];
    }

    /**
     * @param  array<string, mixed>  $def
     * @return ActionDef|null
     */
    public static function normaliseAction(array $def): ?array
    {
        $id = self::id($def['id'] ?? null);

        if ($id === null) {
            return null;
        }

        $scope = (string) ($def['scope'] ?? 'product');
        $scope = in_array($scope, self::ACTION_SCOPES, true) ? $scope : 'product';

        $args = [];

        foreach ((array) ($def['args'] ?? []) as $key => $arg) {
            if (! is_array($arg)) {
                continue;
            }

            $argId = self::id($arg['id'] ?? (is_string($key) ? $key : null));

            if ($argId === null) {
                continue;
            }

            $argType = (string) ($arg['type'] ?? 'text');

            $args[] = [
                'id' => $argId,
                'label' => (string) ($arg['label'] ?? $argId),
                'type' => in_array($argType, self::ARG_TYPES, true) ? $argType : 'text',
                'required' => (bool) ($arg['required'] ?? false),
                'default' => $arg['default'] ?? null,
                'options' => self::options($arg['options'] ?? []),
            ];
        }

        return [
            'id' => $id,
            'label' => (string) ($def['label'] ?? $id),
            'description' => (string) ($def['description'] ?? ''),
            'icon' => isset($def['icon']) ? (string) $def['icon'] : null,
            'scope' => $scope,
            'supportsBulk' => (bool) ($def['supportsBulk'] ?? true),
            'isPrimary' => (bool) ($def['isPrimary'] ?? false),
            'destructive' => (bool) ($def['destructive'] ?? false),
            'confirm' => isset($def['confirm']) ? (string) $def['confirm'] : null,
            'capability' => isset($def['capability']) ? (string) $def['capability'] : null,
            'group' => isset($def['group']) ? (string) $def['group'] : null,
            'order' => (int) ($def['order'] ?? 100),
            'args' => $args,
            'source' => (string) ($def['source'] ?? 'extension'),
        ];
    }

    /**
     * Normalise every definition, drop the invalid ones, keep the last of
     * duplicate ids (a later filter may override an earlier one) and sort.
     *
     * @template T of array{id: string, order: int}
     *
     * @param  array<int|string, mixed>  $defs
     * @param  callable(array<string, mixed>): (T|null)  $normalise
     * @return array<int, T>
     */
    private static function collect(array $defs, callable $normalise): array
    {
        $byId = [];

        foreach ($defs as $key => $def) {
            if (! is_array($def)) {
                continue;
            }

            if (! isset($def['id']) && is_string($key)) {
                $def['id'] = $key;
            }

            $normalised = $normalise($def);

            if ($normalised !== null) {
                $byId[$normalised['id']] = $normalised;
            }
        }

        $list = array_values($byId);

        usort($list, static fn (array $a, array $b): int => $a['order'] <=> $b['order']);

        return $list;
    }

    /**
     * Ids are REST-ish keys: lowercase letters, digits, `_`, `-`, `:` and `.`
     * (`i18n:se.name` is a valid extension id).
     */
    private static function id(mixed $id): ?string
    {
        if (! is_string($id) && ! is_int($id)) {
            return null;
        }

        $id = (string) $id;

        return preg_match('/^[a-z0-9][a-z0-9_:.\-]{0,99}$/', $id) === 1 ? $id : null;
    }

    /**
     * A dot path, or null when the value is not one.
     */
    private static function path(mixed $value): ?string
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        return preg_match(self::PATH, $value) === 1 ? $value : null;
    }

    /**
     * The known operators among the given ones, in the given order; `is`
     * when none is left.
     *
     * @return array<int, string>
     */
    private static function operators(mixed $values): array
    {
        $operators = array_values(array_intersect(self::strings($values ?? ['is']), self::OPERATORS));

        return $operators === [] ? ['is'] : $operators;
    }

    /**
     * @return array<int, string>
     */
    private static function strings(mixed $values): array
    {
        return array_values(array_filter(array_map(
            static fn (mixed $value): string => is_scalar($value) ? (string) $value : '',
            (array) $values
        ), static fn (string $value): bool => $value !== ''));
    }

    /**
     * Options come either as `value => label` or as a list of
     * `['value' => ..., 'label' => ...]`.
     *
     * @return array<int, array{value: string, label: string, applies?: array<string, mixed>}>
     */
    private static function options(mixed $options): array
    {
        $list = [];

        foreach ((array) $options as $value => $option) {
            if (is_array($option)) {
                if (! isset($option['value'])) {
                    continue;
                }

                $item = ['value' => (string) $option['value'], 'label' => (string) ($option['label'] ?? $option['value'])];

                // Which objects the option exists on, e.g. a language field
                // that variations do not have: the JS hides it for them.
                if (isset($option['applies']) && is_array($option['applies'])) {
                    $item['applies'] = $option['applies'];
                }

                $list[] = $item;
            } elseif (is_scalar($option)) {
                $list[] = ['value' => (string) $value, 'label' => (string) $option];
            }
        }

        return $list;
    }
}
