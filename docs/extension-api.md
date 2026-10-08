# Extension API

Other plugins add columns, filters, quick-edit tabs and actions to the Catalog screen. There are two layers, and they produce the same field shape:

1. **Declarative, from PHP.** Return array definitions from the `wc_products_list/fields`, `wc_products_list/filters` and `wc_products_list/actions` filters. They are serialised into `window.wcProductsListSettings` and the app turns them into DataViews fields and actions. No JavaScript needed; this is how gds-woo-i18n adds a column per language.
2. **JavaScript.** A script enqueued on `wc_products_list/enqueue` with the `wc-products-list` handle as a dependency uses `window.wcProductsList` and the `wp.hooks` filters below.

Use the declarative layer when the data is a value on the row that the server can read and write. Use JavaScript when you need a custom control, a computed column, or to change what the app does.

`examples/extension-demo.js` is a complete, working JavaScript example; its header says how to install it as a must-use plugin.

## Declarative definitions (PHP)

```php
add_filter('wc_products_list/fields', function (array $fields): array {
    $fields['i18n:se.name'] = [
        'label'     => 'Name (Svenska)',
        'type'      => 'text',
        'path'      => 'i18n.se.name.value',   // where the value is on the row
        'reference' => 'i18n.se.name.source',  // read-only companion, shown muted when the value is empty
        'writeKey'  => 'i18n',                 // top-level request key: its presence fires wc_products_list/save
        'writePath' => 'i18n.se.name',         // where the edited value goes in the request body
        'group'     => 'i18n:se',              // one quick-edit tab per group
        'visible'   => true,                   // in the default table
        'applies'   => ['product' => true, 'variation' => false],
        'restFields' => ['i18n'],              // `_fields` keys to request when the column is visible
    ];

    return $fields;
});
```

The row data under `path` comes from your `wc_products_list/row` filter; the edited value under `writePath` reaches your `wc_products_list/save` handler. `docs/contracts.md` §6 lists every key and its default. The ones the JavaScript side acts on:

| Key | Effect in the app |
| --- | --- |
| `type` | `text`, `html` (textarea), `price` (text control with the currency as suffix, locale parsing, validation), `integer`, `number`, `boolean`, `select` (with `options`), `date`, `datetime`, `media`, `array` |
| `path` / `reference` | `getValue` reads `path`; when it is empty the column shows `reference` muted (`.wc-products-list-field--reference`), and the quick-edit form can show it beside the control |
| `writePath` | `rest.write( value )` nests the value there: `i18n.se.name` → `{ "i18n": { "se": { "name": value } } }` |
| `editable` / `readonly` / `bulk` | `edit` is `false` when not editable; `bulk: money` and `integer` get the set/increase/decrease control in bulk edit (a sale-price field also gets "Regular price minus", amount or percent of the regular price), `false` hides the field from bulk edit |
| `applies.product` | `true` or a list of parent product types the field is shown and edited for |
| `applies.variation` | the field exists on variation rows too |
| `group` / `tab` | the quick-edit tab; `i18n:se` becomes a tab per language |
| `enableSorting` / `sortParam` | sortable column; `sortParam` is the wc/v3 `orderby` value your `wc_products_list/product_query_args` handles |
| `filter` | `{ param, operators }` offers the column as a filter; the chosen value is sent as `{ [param]: value }` (`isNot`/`isNone` send `exclude_{param}`). Optional `toParams` maps option values to the params to send instead: `['low' => ['max_stock_quantity' => 5]]` |
| `currency` / `precision` | for `price`: the ISO code and decimals. Without `currency`, a field in group `i18n:{lang}` uses `languages.currencies[lang]` from the bootstrap payload, else the site currency |
| `referenceLabel` | the `title` of the muted reference value ("Suomi") |

**Filters** (`wc_products_list/filters`) become filter-only fields: options, operators, no column, no edit. An option's `params` are merged into the list query verbatim; without `params`, `{ [param]: value }` is sent. `variations: true` sends the params on variation requests too.

```php
add_filter('wc_products_list/filters', function (array $filters): array {
    $filters['translation'] = [
        'label'     => 'Translation',
        'type'      => 'select',
        'isPrimary' => true,
        'options'   => [
            ['value' => 'missing:se', 'label' => 'Missing in Svenska', 'params' => ['gds_i18n[lang]' => 'se', 'gds_i18n[status]' => 'missing']],
        ],
    ];

    return $filters;
});
```

**Actions** (`wc_products_list/actions`) show up in the row menu and the bulk toolbar and run `POST /wc-products-list/v1/actions/{id}` with the selected ids. Without `args` and `confirm` the action runs on click. With either, a modal collects the args (`text`, `select`, `boolean`, `integer`, `number`, `array`; `required` blocks the button) and shows the confirm text. The form starts from each arg's `default`; a required `select` without one starts on its first option, so the button is enabled with the value the user sees. An `array` arg is a checkbox group over its `options` and is sent as a list of the ticked values (`'default' => ['name']` or `'name,slug'` pre-ticks them); use it for "which fields" choices instead of a comma-separated text input. `scope` limits the action to products, variations or both; `destructive` styles the button; the handler itself is a `GeneroWP\ProductsList\Actions\Action` registered through `wc_products_list/action_handlers`.

**Actions hosted in the editor.** A declarative action with a non-null `group` and a `select` arg with id `lang` (gds-woo-i18n's `i18n_copy` and `i18n_clear`) runs inline in the quick/bulk editor instead: on each `<group>:<lang>` tab a "Copy or clear <Language> for the selected items" panel shows the action with `lang` fixed to that tab's language and the other args as inline controls; a `destructive` action asks through an in-page confirm, and the tab's values reload after a run. While an editor is available the action is not listed in the row menu or the bulk toolbar.

## JavaScript API

`window.wcProductsList` exists when your script runs (enqueue it on `wc_products_list/enqueue` with the handle you receive as a dependency). If you cannot guarantee the order, register in a `wcProductsList.ready` handler; both work, before and after the app mounts.

```js
( window.wcProductsList ? Promise.resolve( window.wcProductsList )
    : new Promise( ( resolve ) => wp.hooks.addAction( 'wcProductsList.ready', 'my-plugin/wc-products-list', resolve ) )
).then( ( api ) => { /* … */ } );
```

| Member | What it does |
| --- | --- |
| `version`, `settings` | the plugin version and the bootstrap payload (currency, caps, product types, limits, links, languages…) |
| `registerField( field )` | adds a column. A DataViews `Field` plus `rest { fields, read?, write?, param?, sortParam?, applies }`, `productTypes`, `edit`, `reference?`, `source?`. Missing extras get defaults: `rest.fields` from the id, applies to products only, not editable. Re-registering an id replaces it in place |
| `registerAction( action )` | adds a DataViews action (`callback` or `RenderModal`), optionally with `scope` and `capability`. The built-in `quick-edit` action is a `callback` that opens the inline editor; an extension cannot replace it with a `RenderModal` of its own (register a differently named action instead) |
| `registerQuickEditTab( { id, label, fields?, order? } )` | adds a tab to quick/bulk edit; fields join it through `edit.tab`. The editor is inline in the table (a quick edit takes the edited row's place, the bulk editor sits above the first row); tabs and fields work the same as they did in the modal |
| `addQueryParams( ( params, { tab, view, fields } ) => params )` | changes the wc/v3 list request |
| `refresh( { counts? } )` | refetches the current page (and counts) |
| `patchItems( [ { id, …partial } ] )` | merges partial rows into every cached list without a request (for optimistic updates) |
| `batchUpdate( { products?, variations? }, { source? } )` | saves through the bulk-edit path: variations first (per parent), then parents, under one batch id, logged; resolves `{ updated, errors, batchId }` |
| `notices.success / error / info( message, options? )` | snackbar (default) or panel notices; snackbars hide after 6 s, or 10 s with `options.actions` (e.g. an Undo), the timer paused while the pointer or focus is on them; error snackbars stay until dismissed; a newer success snackbar with an action replaces an older one (only the latest Undo is offered; earlier batches stay revertable in History); `explicitDismiss: true` keeps any snackbar until dismissed |
| `getItems()` | the rows currently on screen, parents and expanded variations in display order (placeholder rows excluded; empty before the Catalog mounts and on the History screen) |
| `hooks` | `wp.hooks` plus the names: `hooks.filters.query`, `hooks.actions.loaded`, `hooks.hookNamespace( 'my-plugin' )` |

Every `register*` call bumps a registry version; the screen re-derives its fields and actions when it changes, so registering after mount works without a reload.

### A field from JavaScript

```js
api.registerField( {
    id: 'demo_note',
    label: 'Internal note',
    type: 'text',
    Edit: { control: 'textarea', rows: 3 },
    getValue: ( { item } ) => ( item.meta_data || [] ).find( ( m ) => m.key === '_note' )?.value ?? '',
    setValue: ( { value } ) => ( { meta_data: [ { key: '_note', value } ] } ),
    rest: {
        fields: [ 'meta_data' ],
        write: ( value ) => ( { meta_data: [ { key: '_note', value } ] } ),
        applies: { product: true, variation: true },
    },
    productTypes: 'all',
    edit: { group: 'notes', tab: 'notes', bulk: 'default' },
} );
```

A registered field is offered under **Add filter** only when the list query can act on it: give it `rest.param` (sent as `{ [param]: value }`), `rest.toParams( value, operator )`, or `elements` whose entries carry `params`; otherwise `filterBy` defaults to `false` (an explicit `filterBy` is kept either way).

`getValue` is what the column and the form read. `setValue` is what DataForm applies to the form data while editing (it must produce the same shape the row has). `rest.write` is what goes into the wc/v3 request body on save. For a plain wc/v3 key (`sku`, `regular_price`) none of the three is needed.

A **filter-only** field has `filterOnly: true`, `elements`, `filterBy`, `getValue: () => undefined`, `render: () => null` and `rest.toParams( value, operator )` (or `rest.param`); see the demo. Give it `enableHiding: false` as well, so neither column picker (DataViews' Properties, the toolbar's Columns) lists it as a column.

A column's default width is its `columnStyle` (`{ width | minWidth | maxWidth, align }`, DataViews' `view.layout.styles` entry); declarative fields get one from their `width` or, failing that, their type (a `*.name` text column is as wide as the name column, other text 180 px, prices 120 px right-aligned). `columnGroup` names the section of the toolbar's Columns picker (`i18n:se` is listed under the language's name; declarative fields take it from `group`).

### Actions from JavaScript

```js
api.registerAction( {
    id: 'demo_clear_sale',
    label: 'Clear sale price',
    supportsBulk: true,
    isEligible: ( item ) => ! item._placeholder && !! item.sale_price,
    callback: ( items, { onActionPerformed } ) => {
        api.batchUpdate( { products: items.map( ( item ) => ( { id: item.id, sale_price: '' } ) ) }, { source: 'extension' } )
            .then( ( result ) => { api.notices.success( `${ result.updated.length } updated` ); onActionPerformed?.( result.updated ); } );
    },
} );
```

Rows carry `_kind` (`product` | `variation`), `_level`, `_parentId`, `_hasChildren`, `_childCount` and, on placeholder rows (loading, error, "N more"), `_placeholder`. Put variation updates under `variations[ parentId ]` in `batchUpdate`.

## wp.hooks

Names are exported from `resources/extensions/hooks.ts` and available as `api.hooks.filters` / `api.hooks.actions`. All filters are applied with `applyFilters( name, value, ...args )`.

| Filter | Value | Extra args |
| --- | --- | --- |
| `wcProductsList.fields` | `ProductField[]` | `settings` |
| `wcProductsList.actions` | `ProductAction[]` | `settings` |
| `wcProductsList.query` | wc/v3 list params | `{ tab, view, fields }` |
| `wcProductsList.variationsQuery` | variation list params | `{ parentId, page }` |
| `wcProductsList.item` | a row, after fetch, before cache | — |
| `wcProductsList.savePayload` | the request body for one item | `item, edits` |
| `wcProductsList.defaultView` | the DataViews `View` | `settings` |
| `wcProductsList.statusTabs` | `{ id, label, count }[]` | `counts` |
| `wcProductsList.quickEdit.tabs` | `QuickEditTab[]` | `items` |
| `wcProductsList.quickEdit.layout` | the DataForm `Form` of a tab (the General tab is a `row` layout of up to three `regular` columns, each holding labelled `regular` groups; other tabs one or two columns) | `tab, items` |
| `wcProductsList.bulkNumericFields` | field ids with the set/increase/decrease (and, for sale prices, regular-price-minus) control | — |

| Action | Payload |
| --- | --- |
| `wcProductsList.ready` | `api` |
| `wcProductsList.loaded` | `items, { tab, view, total }` — once per completed list request; optimistic patches (a save, a trash) do not fire it |
| `wcProductsList.saved` | `{ updated, errors, batchId }, { source }` |
| `wcProductsList.deleted` | `ids, { action: 'trash' | 'delete', batchId }` |
| `wcProductsList.actionPerformed` | `{ action, ids, batchId, items }` — a declarative (PHP) action finished; `ids` are the rows it processed without error. The Catalog drops them from the selection. |

Register with a namespace of your own, for example `api.hooks.hookNamespace( 'my-plugin' )` → `my-plugin/wc-products-list`.

## Speed rules for extensions

- Ask only for what you render: `rest.fields` keeps `_fields` small, and the list page budget is one second for 100 rows.
- Patch, do not refetch: after your own writes call `patchItems` with the rows the server returned (or `batchUpdate`, which does it for you) and `refresh` only when the row set changed.
- `addQueryParams` callbacks and `wcProductsList.item` run on every request and row; keep them cheap and pure.
- A `render` or `Edit` that imports its own component library doubles the bundle; the dataviews edit configs (`{ control: 'textarea' }`, `{ control: 'text', suffix }`) cover most cases.
