# Contracts

The authoritative interfaces between the PHP side, the JS app and extensions. Builders of the individual modules code against this document; when a module needs something that is not here, add it here first.

Conventions: PHP namespace `GeneroWP\ProductsList`, text domain `wp-woocommerce-products-list`, hook prefix `wc_products_list/`, script and style handle `wc-products-list`, admin page `edit.php?post_type=product&page=wc-products-list`, own REST namespace `wc-products-list/v1`. JS lives in `resources/` (TypeScript, `@wordpress/dataviews` 20 imported only through `resources/dataviews.ts`). Ids of fields are the wc/v3 keys. Times in REST are site-local ISO strings with `_gmt` twins, as wc/v3 does. Money is a decimal string (`"189"`, `"12.50"`).

## 1. Request headers (list mode)

| Header | Sent | Meaning |
| --- | --- | --- |
| `X-WC-Products-List: 1` | every request from the app | `ListMode::active()` is true: wc/v3 rows are enriched, extra params mapped, writes logged. Other wc/v3 consumers see nothing. |
| `X-WC-Products-List-Batch: <id>` | every write (POST/PUT/DELETE) | `ListMode::batchId()`; `[A-Za-z0-9_-]{1,64}`, the app sends a UUID v4. One id per user gesture (one bulk save, one action on N rows), shared across the requests it takes. Groups log rows; `revert` works per batch. |
| `X-WC-Products-List-Source: <source>` | every write | `ListMode::source()`; one of `ListMode::SOURCES` = `quick`, `bulk`, `action`, `extension`, `revert` (the app sends the first three; the plugin sets `action` and `revert` on its own nested requests). Default `quick`. Stored per log row. |

PHP: `ListMode::active(): bool`, `ListMode::batchId(): ?string`, `ListMode::source(): string`, `ListMode::method(): ?string` (the dispatched request's HTTP method; batch sub-requests are not dispatched, so it stays `POST` through a batch), `ListMode::force(?bool $active, ?string $batchId = null)` (tests/CLI; `force(null)` resets). Captured on `rest_request_before_callbacks` (priority 1), so it is per request, including batch sub-requests. Filter `wc_products_list/active` (bool) can override.

JS: `api/client.ts` installs an `apiFetch` middleware that adds both headers; the batch id comes from the caller (`batchId` option) or is generated per call.

## 2. PHP hooks

### Filters

| Hook | Signature | Where |
| --- | --- | --- |
| `wc_products_list/modules` | `(class-string<Module>[] $modules): class-string<Module>[]` | `Plugin::boot` |
| `wc_products_list/capability` | `(string $cap = 'edit_products'): string` | `Plugin::capability()`, menu + REST permission of own routes. The wc/v3 batch routes additionally need `edit_others_products` (see §3.1 Writes) |
| `wc_products_list/allow_hard_delete` | `(bool $allow = false): bool` | `Bootstrap` → `features.hardDelete`: offer "Delete permanently" on rows outside the Trash |
| `wc_products_list/active` | `(bool $active): bool` | `ListMode::active()` |
| `wc_products_list/bootstrap` | `(array $settings): array` | `Bootstrap::settings()`, see §5 |
| `wc_products_list/fields` | `(array $defs): array` | `Registry::fields()`, see §6 |
| `wc_products_list/filters` | `(array $defs): array` | `Registry::filters()` |
| `wc_products_list/actions` | `(array $defs): array` | `Registry::actions()` (declarative, what the UI shows); the handler objects are registered with `wc_products_list/action_handlers` |
| `wc_products_list/action_handlers` | `(array<string, Action> $handlers): array<string, Action>` | `Modules\Actions`; key = action id |
| `wc_products_list/product_query_args` | `(array $args, WP_REST_Request $request): array` | `Rest\ListQuery`, after the plugin's own mapping, only in list mode. `$args` are `WP_Query` args. |
| `wc_products_list/variation_query_args` | `(array $args, WP_REST_Request $request): array` | same for `products/{id}/variations` |
| `wc_products_list/row` | `(array $row, WC_Product $product, WP_REST_Request $request): array` | `Rest\Rows`, after `wc_products_list` key is set, only in list mode; `$product` is a `WC_Product_Variation` for variation rows. Respect `_fields`: `rest_is_field_included('i18n', $fields)`. |
| `wc_products_list/counts` | `(array<string,int> $counts): array` | `Rest\CountsController` |
| `wc_products_list/drop_gallery` | `(bool $drop = true): bool` | `Rest\Rows`: on list-mode **read** requests a product's gallery is not serialised (`images` holds the featured image only), which is most of the cost of a 100-row page; return false to keep the gallery. Writes never see a trimmed gallery. |
| `wc_products_list/write_keys` | `(string[] $keys = []): string[]` | `Rest\Saves::writeKeys()`: extra top-level body keys that make `wc_products_list/save` fire, besides the declarative fields' `writeKey`s (§6). For integrations that take keys without declaring fields. |
| `wc_products_list/log_value` | `(mixed $value, string $path, WC_Product $product, string[] $segments): mixed` | `Log\Recorder`: the logged value of a nested write path (`i18n.se.name`). The default reader resolves `i18n.{lang}.{field}` to meta `_i18n_{field}_{lang}` and `meta_data.{key}` to that meta; return the value for other shapes. |
| `wc_products_list/log_retention_days` | `(int $days = 180): int` | `Log\Prune` |
| `wc_products_list/revert_chunk` | `(int $objects = 100): int` | `Log\Revert::chunk()`: objects one revert request writes at most; `GET /log/batch/{id}` cuts the batch into chunks of this size. |
| `wc_products_list/log_context` | `array $context, WP_REST_Request $request` | the `context` stored with every log row of a save (`keys`, `route`, `ip`, `ua`); unset `ip`/`ua` to keep no personal data beyond the user id |
| `wc_products_list/variation_term_taxonomies` | `(string[] $taxonomies): string[]` | `Rest\Rows::variationTaxonomies()`: taxonomies whose variation term relationships are primed per page in list mode (default: the product taxonomies not attached to `product_variation`, plus Polylang's `language`/`post_translations` when they exist). |

### Actions

| Hook | Signature | Where |
| --- | --- | --- |
| `wc_products_list/activate` | `()` | `Plugin::activate()` (activation hook, and `tests/bootstrap.php`), after modules are registered. `Log\Table` installs here and on `init` when the stored version differs. |
| `wc_products_list/deactivate` | `()` | `Plugin::deactivate()` (deactivation hook). `Log\Prune` unschedules its cron here; the table and its rows stay. |
| `wc_products_list/enqueue` | `(string $handle = 'wc-products-list')` | `Modules\AdminPage::enqueue`, after the app script and style are enqueued. Extension scripts enqueue here with `$handle` as a dependency. |
| `wc_products_list/save` | `(WC_Product $product, WP_REST_Request $request, bool $creating)` | `Rest\Saves`, on `woocommerce_rest_pre_insert_product_object` / `_variation_object` **only** when the request carries a registered write key (§6, `Registry::writeKeys()`) and list mode is on. Apply the extension's own keys to `$product` (`update_meta_data` etc.); do not save, WooCommerce saves right after. Throw `WC_REST_Exception` or return normally. |
| `wc_products_list/logged` | `(array $rows, string $batchId)` | `Log\Logger`, after rows are written |

### Module skeleton

```php
namespace GeneroWP\ProductsList\Modules;

class Rest implements \GeneroWP\ProductsList\Module
{
    public function register(): void { /* add_action / add_filter; register REST on rest_api_init */ }
}
```

`Plugin::MODULES = [Rest, AdminPage, Log, Actions]`; `Plugin::getInstance()->module(Rest::class)` returns the instance. Constants: `Plugin::HANDLE`, `Plugin::PAGE`, `Plugin::REST_NAMESPACE`, `Plugin::TEXT_DOMAIN`, `Plugin::url()`, `Plugin::path()`, `Plugin::capability()`. `AdminPage::SCREEN = 'product_page_wc-products-list'`, `AdminPage::ROOT_ID = 'wc-products-list-root'`, `AdminPage::isScreen()`.

## 3. REST

All own routes: namespace `wc-products-list/v1`, permission `current_user_can(Plugin::capability())` plus per-item checks where noted, `X-WC-Products-List` not required (but sent). Errors are standard `WP_Error` → `{code, message, data: {status}}`.

### 3.1 wc/v3 products (list)

`GET /wc/v3/products` with the usual params plus, in list mode (`Rest\ListQuery`):

| Param | Maps to |
| --- | --- |
| `tab` | `all` → `include_status=publish,draft,pending,private,future` (not trash); `publish|future|draft|pending|private|trash` → that status |
| `brand` | `product_brand` term ids (csv) |
| `exclude_category`, `exclude_tag` | `tax_query` NOT IN |
| `min_stock_quantity`, `max_stock_quantity` | `wc_product_meta_lookup.stock_quantity` |
| `has_variations` | `1` → variable products with ≥1 variation; `0` → the rest |
| `sale_scheduled` | `1` → a sale price with a start date in the future, on the product or on one of its variations (two EXISTS on postmeta); `0` → the rest. On the variations route: the variation's own sale (meta_query). The `on_sale` filter's "Sale scheduled" option. |
| `orderby=sku|stock_quantity|menu_order` | lookup-table join; core already does `id,title,date,modified,price,popularity,rating,include,slug` |

| `search_name_or_sku` | in list mode the plugin's own search, not WooCommerce's: tokens split on whitespace, each must match the product's name or SKU **or the SKU of one of its variations**. Rows are always products (WooCommerce's search lists matching variations as rows of their own). |

The app always sends `_fields` (union of visible fields' `rest.fields` + `id,type,status,parent_id,wc_products_list`), `image_size=thumbnail`, `per_page ≤ 100`, `search_name_or_sku` instead of `search`. Response headers `X-WP-Total`, `X-WP-TotalPages` are read. On list-mode reads `images` carries the featured image only (`wc_products_list/drop_gallery`).

Row (`Rest\Rows`, list mode only) adds:

```json
"wc_products_list": {
  "variation_count": 12,        // variable parents; 0 otherwise
  "edit_link": "https://…/post.php?post=1&action=edit",
  "can_edit": true,
  "can_delete": true,
  "parent_id": 0                // variation rows: the parent id
}
```

plus extension keys from `wc_products_list/row` (gds-woo-i18n: `"i18n": {"se": {"name": {"value": "", "source": "Saga", "effective": "Saga"}}}`).

`GET /wc/v3/products/{id}/variations?per_page=100&page=N&_fields=…` likewise enriched (`Rest\Rows` on `woocommerce_rest_prepare_product_variation_object`), ordered `menu_order, id` by default; `wc_products_list/variation_query_args` applies.

Writes: `POST /wc/v3/products/{id}`, `POST /wc/v3/products/batch {update:[{id,…}]}` (≤100), `POST /wc/v3/products/{parent}/variations/batch {update:[…]}`. Extension keys in the body (`"i18n": {"se": {"name": "Saga"}}`) are handled by `wc_products_list/save`. Each changed field is logged (§4).

On list-mode batch writes, `?fields=` (comma-separated wc/v3 fields; nested paths keep their top-level key; `id` always kept) trims each returned item row (`Rows::trimBatchItem`, priority 1000, so extension keys are included in the trim); error entries are untouched. Single writes use core `_fields`. `_fields` must not be used on the batch routes: core would trim `{update: [...]}` itself and the app would get `{}`. The app sends the registered fields' keys (`rowFields()`), so a 100-row save returns tens of KB instead of a megabyte.

Capabilities: the screen and the plugin's own routes need `edit_products` (`wc_products_list/capability`); `POST products/{id}` needs `edit_post` on that product; `products/batch` and `variations/batch` need `edit_others_products` (WooCommerce answers `woocommerce_rest_cannot_batch` otherwise). `caps.editOthers` in the payload reflects it: without it the app saves one row through `POST products/{id}` / `variations/{id}` (api/client.ts) and disables bulk saves with a notice.

### 3.2 Counts

`GET /wc-products-list/v1/counts` → `{"all": 855, "publish": 800, "future": 0, "draft": 50, "pending": 0, "private": 5, "trash": 3}` (`wp_count_posts('product')`; `all` excludes trash). Filter `wc_products_list/counts`.

### 3.3 Terms

`GET /wc-products-list/v1/terms/{taxonomy}?search=&include=1,2&page=1&per_page=50` for `product_cat|product_tag|product_brand|product_shipping_class|pa_*` →

```json
{"items": [{"id": 12, "name": "Boots", "slug": "boots", "parent": 0, "count": 40}], "total": 1, "totalPages": 1}
```

`include` returns exactly those ids (for resolving selected values); `search` is `name__like`; items ordered by name. 404 for other taxonomies.

### 3.4 Actions

`POST /wc-products-list/v1/actions/{action}` body `{"ids": [1,2,3], "args": {}}` (≤ `limits.actionBatchSize` = 100 ids) →

```json
{
  "batch_id": "…",
  "results": [
    {"id": 1, "ok": true,  "data": {"new_id": 901}},
    {"id": 2, "ok": false, "code": "forbidden", "message": "…"}
  ],
  "items": [ /* refreshed wc/v3 rows of the ids that still exist, list-mode shape, trimmed to ?fields=id,status,… (not `_fields`: core would trim this whole response to those keys) */ ]
}
```

Built-in: `trash` (wp_trash_post), `restore` (wp_untrash_post → status it had), `delete` (force; `args.force` not needed), `duplicate` (`WC_Admin_Duplicate_Product`; `data.new_id`), `publish`, `draft`, `feature {featured: bool}`. Extension actions are `Actions\Action` instances:

```php
interface Action
{
    public function id(): string;
    /** @return array<string,mixed>|WP_Error  data for the result row */
    public function run(WC_Product $product, array $args, WP_REST_Request $request): array|WP_Error;
    public function can(WC_Product $product): bool;              // per-id capability
    public function appliesTo(): string;                        // 'product' | 'variation' | 'both'
    public function sanitizeArgs(array $args): array|WP_Error;  // once per request
}
```

registered through `wc_products_list/action_handlers`. The built-ins are registered as handlers only (priority 5), not as declarative `wc_products_list/actions` entries: the app has its own UI for them and calls `POST /actions/{id}` by id. Every id gets one log row (`source=action`, `action=<id>`), or one row per field when `run()` returns `changes => [field => [old, new]]`; a `context` array in the return value is stored in the row's context next to `args` (the rest of the return value is the result's `data`). `duplicate` logs one row with `field=duplicate`, `new_value=<new id>` and context `{new_id, new_title}`. Per-id result codes: `not_found`, `not_applicable` (outside `appliesTo()`), `forbidden` (`can()` false), `exception`, or the handler's `WP_Error` code. Request-level errors: 400 `wc_products_list_no_ids` / `_too_many_ids` / `_invalid_ids`, 404 `wc_products_list_unknown_action`, 400 with the handler's code from `sanitizeArgs()`. The `items` refresh is one nested list request per (parent, status) group.

### 3.4b Variations batch

`POST /wc-products-list/v1/variations/batch?fields=` `{update: [{id, ...wc/v3 variation fields}]}` (≤ 100 items, `woocommerce_rest_batch_items_limit`; permission `edit_others_products` like every wc/v3 batch) → `{update: [...]}` in request order, each item a row trimmed to `fields` (`id` kept) or `{id, error: {code, message, data}}`. The items are grouped by their actual parent and dispatched to `POST /wc/v3/products/{parent}/variations/batch` from inside the request with this request's list-mode, batch and source headers, so validation, save hooks, logging and the `fields` trim are exactly those of a direct call; a `parent_id`/`product_id` in an item is ignored. An id that is not a variation gets `woocommerce_rest_product_variation_invalid_id` (404). One request for a scheduled sale across a page of variable products instead of one per parent.

### 3.5 Log

`GET /wc-products-list/v1/log?object_id=&batch=&user=&field=&source=&action=&since=&until=&page=&per_page=` → `{"items": [LogRow], "total": n, "totalPages": n}` ordered newest first.

```ts
interface LogRow {
  id: number; batch_id: string; created_at: string /* ISO, site tz */; created_at_gmt: string;
  user: { id: number; name: string };
  source: 'quick' | 'bulk' | 'action' | 'extension' | 'revert';
  action: 'update' | 'create' | 'trash' | 'restore' | 'delete' | 'duplicate' | string;
  object_type: 'product' | 'variation'; object_id: number; parent_id: number;
  object_name: string; edit_link: string | null;
  field: string; old_value: string | null; new_value: string | null;
  status: 'ok' | 'error'; message: string;
  related: { id: number; name: string; edit_link: string | null } | null; // the copy a `duplicate` row created, when it still exists
}
```

`GET /wc-products-list/v1/log/users` → `[{id, name}]`: every user with log rows, sorted by name (the History screen's User filter).

`GET /wc-products-list/v1/log/batches?page=&per_page=` → `{"items": [{batch_id, created_at, user, source, rows: n, objects: n, fields: string[], revertable: bool}], total, totalPages}`.

`GET /wc-products-list/v1/log/batch/{batch_id}` → `{batch_id, rows, objects, chunk, chunks: number[][], skipped: [{id, object_type, action}], revertable}`: what a revert would write, the object ids in write order (products, then variations grouped by parent) cut into chunks of `chunk` (`Revert::chunk()`, 100).

`POST /wc-products-list/v1/log/batch/{batch_id}/revert?fields=` `{ids?, revert_batch_id?, force?}` → same shape as an action response (`results` per object, `items` trimmed to `fields`), written as a new batch with `source=revert`. Without `ids` the whole batch is reverted when it has at most `chunk` objects, otherwise 400 `wc_products_list_revert_too_large` with `data.chunks`; with `ids` (one chunk, ≤ `chunk`) only those objects, logged under `revert_batch_id` so every chunk of one revert is one batch (generated when absent; `batch_id` in the response). Only `update` rows revert; trash/delete/duplicate rows are reported as skipped (`code: 'skipped'`). A field whose current value is not what the batch left (changed again since, by anyone) makes its object a `conflict` result (`fields: string[]`, nothing written for that object) unless `force` is true.

Table `{prefix}wc_products_list_log`: `id BIGINT PK, batch_id VARCHAR(64), created_at DATETIME, user_id BIGINT, source VARCHAR(20), action VARCHAR(40), object_type VARCHAR(20), object_id BIGINT, parent_id BIGINT, field VARCHAR(100), old_value LONGTEXT NULL, new_value LONGTEXT NULL, status VARCHAR(10), message TEXT, context JSON/LONGTEXT`; indexes `batch_id`, `(object_id, created_at)`, `user_id`, `created_at`. Values are JSON-encoded when not scalar.

## 4. Logging rules (Rest\Saves + Log\Recorder)

In list mode, `woocommerce_rest_pre_insert_product_object` / `_variation_object` snapshot the current value of every key present in the request body (top-level wc/v3 keys, each `meta_data[].key`, each extension write path such as `i18n.se.name`) from a fresh load of the product; `woocommerce_rest_insert_*` diffs against the saved product and writes one row per changed field (no row for no-ops; `null` and `''` compare equal), `action=update` (`create` for a new object), `source` from header `X-WC-Products-List-Source` (§1, default `quick`), `batch_id` from the batch header (generated when missing). Values are stored as strings in wc/v3 **input** shape (`true`/`false`, dates `Y-m-d\TH:i:s` site time, term lists `[{"id":n}]`), so a revert posts them back verbatim. Batch endpoints fire the same hooks per item; in list mode each batch sub-request also gets the batch request's `fields` as its own `_fields` (`Rest\Saves::forwardFields()`), so WooCommerce builds only the row fields the app asked for (no price range or gallery for a status change) and integrations can respect it. Validation errors that throw before `pre_insert` (duplicate SKU) are logged as `status=error` rows with the field list from the request body. Errors also go to `wc_get_logger()` source `wc-products-list`. One multi-row INSERT per request, at `rest_request_after_callbacks` (priority 1000) or shutdown.

## 5. Bootstrap payload (`window.wcProductsListSettings`)

Typed in `resources/types/settings.ts` (`Settings`). Produced by `src/Bootstrap.php`, filtered by `wc_products_list/bootstrap`. Keys: `version, locale, currency {code, symbol, position, decimals, decimalSeparator, thousandSeparator}, units {weight, dimension}, dateFormat, timeFormat, timezone, user {id, name}, caps {edit, editOthers, publish, delete, deleteOthers, manageWoocommerce, manageTerms}, statuses[], productTypes[], stockStatuses[], catalogVisibility[], backorders[], taxStatuses[], taxClasses[], shippingClasses[{id,value,label}], taxonomies[{name,label,restKey,hierarchical,attribute}], features {cogs, brands, reviews}, limits {perPageMax 100, maxChildrenPerParent 1000, batchSize 50, actionBatchSize 100}, links {admin, rest, page, history, legacyList, newProduct, editProduct (sprintf %d), assets}, fields: DeclarativeField[], filters: DeclarativeFilter[], actions: DeclarativeAction[], languages: null | {default, others[], labels{}, currencies?{}}`. Option lists are `{value, label}[]`.

## 6. Declarative definitions (PHP → JSON)

Returned by `Registry::fields()/filters()/actions()`; input via the filters in §2 as `array<int|string, array>` (a string key is used as `id` when the entry has none). Invalid entries (bad id) are dropped, duplicate ids keep the last, lists are sorted by `order`. Id pattern `^[a-z0-9][a-z0-9_:.\-]{0,99}$`.

**Field** (`DeclarativeField` in `resources/types/extension.ts`):

| Key | Default | Meaning |
| --- | --- | --- |
| `id` | required | unique; extension ids are prefixed (`i18n:se.name`) |
| `label` | id | column header / form label |
| `type` | `text` | `text, html, price, integer, number, boolean, select, date, datetime, media, array` |
| `description` | `''` | |
| `path` | id | dot path into the row for the value (`i18n.se.name.value`) |
| `reference` | null | dot path to a read-only companion value shown beside the control (`i18n.se.name.source`); for a sale-price field it is also the regular price the sale < regular check falls back to when the field's own regular price is empty |
| `writeKey` | first segment of `writePath` | top-level request key; its presence fires `wc_products_list/save` |
| `writePath` | null (= `path`) | dot path in the request body the value is written to (`i18n.se.name`) |
| `editable` | true | quick/bulk editable |
| `readonly` | `!editable` | never editable; forces `editable=false`, `bulk=false` |
| `bulk` | by type: price→`money`, integer→`integer`, else `default` | `money` and `integer` get the set/increase/decrease control; `false` hides it from bulk edit |
| `applies.product` | `true` | parent product types the field exists on, or array of types |
| `applies.variation` | `false` | exists on variations |
| `options` | `[]` | `value => label` or `[{value,label}]`, for `select` |
| `group` | null | quick-edit group; `i18n:se` becomes a tab per language |
| `tab` | group | |
| `visible` | false | in the default table view |
| `order` | 100 | |
| `enableSorting` / `sortParam` | false / null | `sortParam` is the wc/v3 `orderby` value |
| `restFields` | first segment of `path` | `_fields` keys to request when visible |
| `filter` | null | `{param, operators[]}` to offer the field as a filter |
| `width` | null | column width in px |
| `source` | `extension` | |
| `referenceLabel` | absent | what the `reference` companion is ("Not translated to Svenska; showing the Suomi value"); the muted cell's `title` |
| `currency` | absent | `price` fields: ISO code of the column's currency when not the shop's (upper-cased); the form reference and bulk preview format in it |
| `precision` | absent | `price` fields: decimals of that currency |

**Filter** (`DeclarativeFilter`): `id, label, type (select|text|boolean|number|date), param (string|null), options [{value, label, params {…}}], operators ['is'], isPrimary, multiple, variations (also sent on variation requests), order, source`. An option's `params` are merged into the query verbatim (`{"gds_i18n[lang]": "se", "gds_i18n[status]": "missing"}`); without `params`, `{[param]: value}`.

**Action** (`DeclarativeAction`): `id, label, description, icon (dashicon/wp icon name|null), scope (product|variation|both), supportsBulk true, isPrimary, destructive, confirm (string|null), capability (Caps key|null), group, order, args [{id, label, type (text|select|boolean|integer|number|array), required, default, options}], source`. The UI collects `args` in a modal when any exist, then `POST /actions/{id}`. The form starts from each arg's `default`; a required `select` without one starts on its first option (what is shown is what is sent). `array` is a checkbox group over `options`, sent as a list of option values (`default` may be a list or a comma-separated string); `required` means at least one.

## 7. JS module boundaries

Every signature below is exported by the named file. Types come from `resources/types/`. `ProductListItem`, `RawProduct`, `RawVariation`, `ProductField`, `ProductAction`, `Settings`, `QueryParams`, `BatchResult` are defined there and not redefined elsewhere.

### `resources/api/client.ts`

```ts
export interface ListResult<Item> { items: Item[]; total: number; totalPages: number }
export interface RequestOptions { signal?: AbortSignal; batchId?: string; source?: 'quick' | 'bulk' | 'extension' }

export function listProducts(query: QueryParams, options?: RequestOptions): Promise<ListResult<ProductListItem>>
export function getVariations(parentId: number, page?: number, options?: RequestOptions & { perPage?: number; fields?: string[] }): Promise<ListResult<ProductListItem>>
export function getProduct(id: number, fields?: string[]): Promise<ProductListItem>
export function updateProduct(id: number, data: Record<string, unknown>, options?: RequestOptions): Promise<ProductListItem>
export function batchProducts(update: ProductUpdate[], options?: RequestOptions): Promise<BatchResponse<RawProduct>>      // chunks of limits.batchSize, sequential
export function batchVariations(parentId: number, update: VariationUpdate[], options?: RequestOptions): Promise<BatchResponse<RawVariation>>
export function batchVariationsAcross(update: Array<VariationUpdate & { parent_id: number }>, options?: BatchOptions): Promise<BatchResponse<RawVariation>>   // POST /wc-products-list/v1/variations/batch in chunks of limits.actionBatchSize; parent_id is only for the single-write fallback (no edit_others_products)
export function runAction(action: string, ids: number[], args?: Record<string, unknown>, options?: RequestOptions): Promise<ActionResponse>  // chunks of limits.actionBatchSize
export function getCounts(options?: RequestOptions): Promise<Record<string, number>>
export function getTerms(taxonomy: string, params?: { search?: string; include?: number[]; page?: number; perPage?: number }, options?: RequestOptions): Promise<ListResult<Term>>
export function getLog(params: LogQuery, options?: RequestOptions): Promise<ListResult<LogRow>>
export function getLogBatches(params?: { page?: number; perPage?: number }): Promise<ListResult<LogBatch>>
export function getRevertPlan(batchId: string, options?: RequestOptions): Promise<RevertPlan>   // GET /log/batch/{id}: { batch_id, rows, objects, chunk, chunks: number[][], skipped: [{id, object_type, action}], revertable }
export function revertBatch(batchId: string, options?: RequestOptions & { fields?: string[]; ids?: number[]; revertBatchId?: string; force?: boolean }): Promise<ActionResponse>   // one chunk with ids (+ revert_batch_id shared by all chunks); conflicts come back as results { ok: false, code: 'conflict', fields }
export function newBatchId(): string
export class ApiError extends Error { code: string; status: number; data?: unknown }
```

Rows returned from the client are already normalised (`hierarchy/normalize.ts`: `_kind/_level/_parentId/_hasChildren/_childCount` set, `wcProductsList.item` filter applied).

`resources/api/query.ts`: `buildProductListQuery(view: View, tab: string, fields: ProductField[], settings: Settings): QueryParams` (pure; applies `addQueryParams` callbacks then `wcProductsList.query`). `buildVariationsQuery(parentId, page, fields, settings): QueryParams` (applies `wcProductsList.variationsQuery`).

### `resources/store/query-cache.ts`

```ts
export interface QueryCache {
  get<T>(key: string): CacheEntry<T> | undefined
  fetch<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, options?: { keepPreviousData?: boolean }): Promise<T>  // in-flight dedupe, aborts a superseded fetch of the same key
  patch<T>(key: string, updater: (data: T) => T): void   // applied now, and again on top of the response of a fetch that was in flight (an optimistic patch outlives a concurrent refetch)
  invalidate(prefix: string): void          // drops entries, refetches subscribed ones
  subscribe(key: string, listener: () => void): () => void
}
export function createQueryCache(): QueryCache
export function useQuery<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, options?: { keepPreviousData?: boolean; enabled?: boolean }): { data: T | undefined; error: Error | undefined; isLoading: boolean; isFetching: boolean; updatedAt: number; refetch: () => Promise<T> }   // updatedAt moves on a response, never on a patch
export const cache: QueryCache   // the app singleton
```

Keys: `products:<json of query>`, `variations:<parentId>:<page>`, `counts`, `terms:<taxonomy>:<json>`, `log:<json>`.

### `resources/store/products.ts`

```ts
export function useProductList(view: View, tab: string, fields: ProductField[]): { items: ProductListItem[]; total: number; totalPages: number; isLoading: boolean; isFetching: boolean; error?: Error; refetch(): Promise<void> }
export function useCounts(): { counts: Record<string, number>; refetch(): Promise<void> }
export function patchItems(items: Array<Partial<ProductListItem> & { id: number }>): void   // into every cached list + variations page, and the hierarchy's children store (patchVariationRows)
export function removeItems(ids: number[]): void                                           // likewise (removeVariationRows)
export function invalidateProducts(options?: { counts?: boolean; variations?: boolean }): void  // variations: also invalidateVariations() of the hierarchy
export function refreshParentsOf(rows: ProductListItem[]): Promise<number[]>                 // GET products?include=…&_fields=PARENT_DERIVED_FIELDS for the cached parents of saved variations, then patchItems; runs on wcProductsList.saved
export function cachedProductIds(): Set<number>
```

`resources/store/rows.ts`: `setCurrentRows(rows)` (the Catalog screen, on every render of its rows) / `getCurrentRows()` (placeholders excluded) back `window.wcProductsList.getItems()`.

### `resources/list/selection.ts`, `selection-bar.tsx`, `whole-selection.ts`

The selection spans pages, searches, filters and sorts; a status tab change clears it. `useSelection(pageRows, resetKey)` returns `{ selection (ids, page rows first in page order), rows (fresh page objects where present, stored ones otherwise), offPageCount, onPageSelectionChange(ids) (DataViews' page-scoped change: replaces the page's part, keeps the rest), set(ids) (whole replace; ids without a row are dropped), clear(), selectAllMatching(query, total) (every product of the current list request in pages of `limits.perPageMax` with `_fields` = `SELECT_ALL_FIELDS`; capped at `MAX_SELECT_ALL` = 5,000 with an error above it; progress + cancel), selectAllProgress, selectAllError }`. A bulk save that went through (`wcProductsList.saved` with `source: 'bulk'` and no `errors`) clears it, whichever rows it wrote; otherwise the saved rows (`updated`) and the rows a save found gone (`errors` with a gone code, `edit/errors.ts isGoneCode`) leave it and the failed rows stay for a retry; deleted rows (`wcProductsList.deleted`) leave it. The `trash` action is a `RenderModal`: one unpublished row goes at once (the modal renders nothing and closes), a published product or several rows are confirmed first (names listed), then the rows leave the page before the request with an Undo (restore) in a sticky notice. The screen passes `onPageSelectionChange` to DataViews and `set` to the actions context. `withWholeSelection(actions, getWhole)` wraps every `supportsBulk` action's `callback`, `RenderModal`, `label` and `modalHeader`: when DataViews passes exactly the page's selected rows, the rows selected on other pages are appended (`extendToWholeSelection`), so the footer's "Bulk edit" and the status/feature/trash actions act on the whole selection. `SelectionBar` (toolbar) shows "N selected (M on other pages)", "Select all N products", "Bulk edit" (opens the `quick-edit` action's `RenderModal` over `rows` in a core `Modal` with the `dataviews-action-modal` overlay class) and "Clear selection".

### `resources/fields/registry.ts`

```ts
export function createProductFields(settings: Settings): ProductField[]   // core fields + declarative (extensions/declarative.ts) + registerField() + wcProductsList.fields
export function getField(fields: ProductField[], id: string): ProductField | undefined
export function fieldsForItems(fields: ProductField[], items: ProductListItem[], mode: 'quick' | 'bulk'): ProductField[]   // the intersection rules of the plan
export const CORE_FIELD_IDS: readonly string[]
```

`resources/fields/currency.ts`: `formatPrice(value: string | number | null, settings: Settings): string`, `parsePrice(input: string, settings: Settings): string | null`, `roundPrice(value: number, settings: Settings): string`.

### `resources/hierarchy/`

```ts
// normalize.ts
export function normalizeProduct(raw: RawProduct): ProductRow
export function normalizeVariation(raw: RawVariation, parentId: number): VariationRow
// flatten.ts
export interface ChildrenState { status: 'idle' | 'loading' | 'loaded' | 'error'; items: VariationRow[]; total: number; error?: string }
export function flattenHierarchy(parents: ProductRow[], expanded: Set<number>, children: Map<number, ChildrenState>, maxChildren: number): ProductListItem[]
// use-hierarchy.ts
export const EXPAND_ALL_WARN_ROWS = 600     // expandAll asks above this
export const EXPAND_ALL_MAX_ROWS = 1500     // a page never grows past this: expandAll stops in page order (notice), restored/revisited expansions are trimmed
export function parentsWithinRows(parents, baseRows, children, maxChildren, maxRows): { fit: ProductRow[]; rows: number }
export function boundExpanded(expanded: number[], parents, children, maxChildren, maxRows): number[]   // keeps ids of other pages; on-page ids in page order while they fit
export function useHierarchy(parents: ProductRow[], fields: ProductField[], options?: { fetchVariations; maxChildren; confirmExpandAll; onExpandAllLimit; storage }): {
  rows: ProductListItem[]; expandedItemIds: number[]; onChangeExpandedItemIds(ids: number[]): void;
  expand(id: number): Promise<void>; collapse(id: number): void; expandAll(options?: { force? }): Promise<boolean>; collapseAll(): void;
  getItemParentId(item: ProductListItem): number | null; getItemHasChildren(item: ProductListItem): boolean;
  childrenOf(parentId: number): ChildrenState | undefined; variationIdsOf(parentIds: number[]): Promise<number[]>
}
// hierarchical-dataviews.tsx — DataViews plus the #83316 prop names
export function HierarchicalDataViews(props: DataViewsProps<ProductListItem> & { getItemParentId; getItemHasChildren; expandedItemIds; onChangeExpandedItemIds }): JSX.Element
// context.tsx
export function useHierarchyContext(): ReturnType<typeof useHierarchy>
```

`expandedItemIds` persist in `sessionStorage` key `wcProductsList.expanded`. When a page's set of parent ids changes (load, paging, filter), the expanded ids on it are bounded in page order: to `EXPAND_ALL_WARN_ROWS` rows when they were just restored from storage, to `EXPAND_ALL_MAX_ROWS` otherwise; ids of other pages are kept. A save that re-creates the same parents does not re-bound.

### `resources/edit/`

```ts
export function mergeItems(items: ProductListItem[], fields: ProductField[]): { data: Record<string, unknown>; mixed: Record<string, { isMixed: boolean; isEmpty: boolean; placeholder: string }> }          // merge.ts
export function visibleEditFields(fields: ProductField[], items: ProductListItem[], options: { mode: 'quick' | 'bulk'; applyToVariations: boolean }): ProductField[]   // visibility.ts
export type NumericOp = { operation: 'dont_change' | 'set' | 'increase' | 'decrease' | 'regular_minus'; value: string; percent?: boolean }   // regular_minus: only for sale-price-leaf fields; percent = percent of the regular price
export function applyNumericOp(current: string | number | null, op: NumericOp, kind: 'money' | 'integer', settings: Settings, context?: { regular?: number | null }): string | null   // bulk-numeric.ts; integer minor units, half-up rounding
export function computeNumericOp(current, op, kind, settings, context?): number | null
export function validateBulkNumericEdits(items: ProductListItem[], edits: Record<string, unknown>, fields: ProductField[], settings: Settings): Array<{ id: number; field: string; message: string }>   // via editsForItem(): sellable edits are never checked against a variable parent
export function projectWarnings(items, edits, fields, settings): Array<{ id: number; field: string; message: string }>   // rows a decrease would clamp at 0
export function editsForItem(item, edits, fields): Record<string, unknown>
export function effectiveRegularPrice(item, regularId, valueOf, byId, settings): number | undefined   // the projected/current regular price, else the field's `reference`
export function isSalePriceField(fieldOrId: ProductField | string): boolean
export function toUnits(value: number, decimals: number): number; export function fromUnits(units: number, decimals: number): string
export const MIXED_VALUE: unique symbol; export function hasOptionList(field: ProductField): boolean   // merge.ts: mixed option-list fields carry the sentinel; effectiveEdits drops it
export function buildPayload(item: ProductListItem, edits: Record<string, unknown>, fields: ProductField[], settings: Settings): Record<string, unknown>   // payload.ts; applies wcProductsList.savePayload
export interface SaveOptions extends RowEditOptions { applyToVariations: boolean; source: 'quick' | 'bulk'; fields?: string[]; onProgress?(done: number, total: number): void; prefetchedVariations?: ReadonlyMap<number, ProductListItem[]> }   // RowEditOptions = { enableManageStock?: boolean; skipExistingSales?: boolean } (row-rules.ts)
export interface SaveResult extends BatchResult { unchanged: number; stockSkipped: number; saleSkipped: number; replacedSales: number }
export function saveEdits(items: ProductListItem[], edits: Record<string, unknown>, fields: ProductField[], options: SaveOptions): Promise<SaveResult>   // save.ts; variations first (cross-parent `variations/batch` in chunks of limits.actionBatchSize), then parents (`products/batch`, chunks of limits.batchSize), one batchId; `fields` defaults to saveFields(fields, edits) and trims the returned rows (?fields=, forwarded as each sub-request's _fields)
export function saveFields(fields: ProductField[], edits: Record<string, unknown>, visibleIds?: string[]): string[]   // the base row keys + the visible columns' rest fields (store/rows.ts getVisibleFieldIds, set by the screen) + the edited fields' rest fields; every registered field when no view is on screen
export function planSave(items, edits, fields, settings, options: RowEditOptions & { applyToVariations: boolean; variationsByParent?: ReadonlyMap<number, ProductListItem[]> }): SavePlan   // save-runner.ts; pure: { writes: Prepared[], products, variations, unchanged, stockSkipped: ProductListItem[], saleSkipped: ProductListItem[], replacedSales }
export function planTargets(targets: SaveTarget[], fields, settings, options?: RowEditOptions): SavePlan
export function runSave(deps: SaveDeps, items, edits, fields, settings, options: SaveOptions): Promise<SaveResult>
export interface SaveDeps { batchProducts(update, { batchId, source, fields? }); batchVariations(parentId, update, { batchId, source, fields? }); batchVariationsAcross?(update: Array<{ id; parent_id } & Record<string, unknown>>, { batchId, source, fields? }); fetchVariations; patchItems; newBatchId(); batchSize; variationsBatchSize?; normalizeRow?(raw, parentId?) }   // save-runner.ts; with batchVariationsAcross the variations of every parent go in chunks of variationsBatchSize (grouped by parent), else one batchVariations per parent
export function resolveSaveTargetsWith(items, edits, fields, { applyToVariations, variationsByParent? }): SaveTarget[]   // apply-to-variations.ts; the synchronous resolveSaveTargets with the variations in hand
export function hydrateSelection(items, fields: string[], deps?, chunk?): Promise<{ items: ProductListItem[]; missing: number[] }>   // hydrate.ts; `missing` = ids the server no longer returns; editFetchFields() now includes on_sale and manage_stock
export function resolveRowEdits(item, edits, options?: RowEditOptions): Record<string, unknown>   // row-rules.ts; drops stock fields on rows that do not manage stock (unless enableManageStock adds manage_stock: true), sale fields on rows that already have a sale when skipExistingSales
export function stockGatedRows(items, edits): ProductListItem[]; export function rowsWithExistingSale(items, edits): ProductListItem[]; export function saleIsActive(item, now?): boolean
export function withArrayOps(fields: ProductField[]): ProductField[]; export function applyArrayOp(current: unknown[], op: 'add' | 'remove' | 'replace', picked: unknown[]): unknown[]   // bulk-array.ts; bulk mode adds a virtual `<id>__op` select before every bulk-editable list field; the op never reaches the payload
export function createDateTimeControl(settings): ComponentType<DataFormControlProps>   // datetime-control.tsx; datetime-local in site wall-clock time, emits Y-m-d\TH:i:s
export function useEditState(items: ProductListItem[], fields: ProductField[], resetKey: string): { data; edits; setField(id, value); reset(); isDirty; hasInput }   // use-edit-state.ts; edits are dropped when resetKey (the selection) changes
```

### `resources/history/`

```ts
export function runRevert(batchId: string, plan: Pick<RevertPlan, 'chunk' | 'chunks'>, options?: { ids?: number[]; force?: boolean; revertBatchId?: string; onProgress?(done, total) }, post?: typeof revertBatch): Promise<RevertOutcome>   // revert.ts; one POST per chunk (plan.chunks, or `ids` cut to plan.chunk) under one revert batch id; RevertOutcome = { revertBatchId, ok, conflicts: ActionResult[], failed: ActionResult[], skipped }
export function revertWholeBatch(batchId: string, options?): Promise<RevertOutcome & { plan: RevertPlan }>   // getRevertPlan then runRevert; what the edit modal's Undo uses (conflicts are reported, never forced)
export function scopeFromPlan(plan): BatchScope; export function describeBatchScope(scope): string   // batch-scope.ts; the Revert confirm's scope line from GET /log/batch/{id}; `skipped` entries named
```

The History "Revert batch" modal loads the plan, posts the chunks behind a progress bar, and when any object comes back `conflict` keeps the modal open with "N put back. M items were changed again after this batch (fields) and were left as they are." and a destructive "Revert M anyway" that re-posts those ids with `force: true` under the same revert batch id. The Change column of a `duplicate` row links to the copy (`LogRow.related`), or says the copy no longer exists.

### `resources/extensions/`

```ts
// api.ts
export function createExtensionApi(deps: { settings: Settings; refresh; patchItems; batchUpdate; notices }): ExtensionApi   // assigned to window.wcProductsList, then doAction('wcProductsList.ready', api)
export function getRegisteredFields(): ProductField[]
export function getRegisteredActions(): ProductAction[]
export function getQueryParamCallbacks(): Array<(params: QueryParams, context: QueryContext) => QueryParams>
export function getQuickEditTabs(): QuickEditTab[]
// declarative.ts
export function fieldFromDeclarative(def: DeclarativeField, settings: Settings): ProductField
export function filterFromDeclarative(def: DeclarativeFilter): ProductField   // a filter-only field (no column) with rest.param / option params
export function actionFromDeclarative(def: DeclarativeAction, run: (ids: number[], args: Record<string, unknown>) => Promise<ActionResponse>): ProductAction
// hooks.ts
export const FILTERS: { fields, actions, query, variationsQuery, item, savePayload, defaultView, statusTabs, quickEditTabs, quickEditLayout, bulkNumericFields }
export const ACTIONS: { ready, loaded, saved, deleted }
```

### Boot order (`resources/index.tsx`)

1. `createExtensionApi()` assigns `window.wcProductsList` and fires `doAction('wcProductsList.ready', api)` itself, once; `index.tsx` does neither again.
2. `domReady` → mount `<App />` into `#wc-products-list-root`.
3. `App` builds fields (`createProductFields`) once per settings and registry version (`useRegistryVersion()`: a `registerField` after mount re-derives them), renders `list/products-screen.tsx` or, lazily (`build/history.js`), `history/history-screen.tsx` by `?screen=`. The edit modal is `build/edit.js`, loaded on first Quick/Bulk edit.

Extension scripts (`wc_products_list/enqueue`, dep `wc-products-list`) run after the app script's module code and before `domReady`, so `window.wcProductsList` exists when they execute; registering in a `wcProductsList.ready` handler is equivalent.

## 8. wp.hooks

Names in `resources/extensions/hooks.ts`. All filters are applied with `applyFilters(name, value, ...args)`.

| Name | Value | Extra args |
| --- | --- | --- |
| `wcProductsList.fields` | `ProductField[]` | `settings` |
| `wcProductsList.actions` | `ProductAction[]` | `settings` |
| `wcProductsList.query` | `QueryParams` | `{ tab, view, fields }` |
| `wcProductsList.variationsQuery` | `QueryParams` | `{ parentId, page }` |
| `wcProductsList.item` | `ProductListItem` | — |
| `wcProductsList.savePayload` | `Record<string, unknown>` | `item, edits` |
| `wcProductsList.defaultView` | `View` | `settings` |
| `wcProductsList.statusTabs` | `StatusTab[]` (`{id, label, count}`) | `counts` |
| `wcProductsList.quickEdit.tabs` | `QuickEditTab[]` | `items` |
| `wcProductsList.quickEdit.layout` | DataForm `Form` | `tab, items` |
| `wcProductsList.bulkNumericFields` | `string[]` | — |

| Action | Payload |
| --- | --- |
| `wcProductsList.ready` | `api: ExtensionApi` |
| `wcProductsList.loaded` | `items, { tab, view, total }` — once per completed list request (`updatedAt` of the cache entry), never for an optimistic patch |
| `wcProductsList.saved` | `result: BatchResult, { source }` |
| `wcProductsList.deleted` | `ids, { action: 'trash' | 'delete', batchId }` |

## 9. Speed budgets (completion criteria)

List page (100 rows, `_fields` trimmed) < 1 s server time; expanding 100 variations < 1 s; 100-row bulk save < 5 s with progress; every mutation optimistic (`patchItems` before the request, rolled back on error); no page reloads; `build/index.js` ≤ 2 MB minified (currently 1.92 MB, 380 KB gzipped; lazy-load `edit/` before raising). Measured with `SCRIPT_DEBUG` off and Query Monitor inactive (README, "Measuring").

Rendering rules that keep the budgets: table rows are memoised by `patches/@wordpress__dataviews@20.0.0.patch` (docs/dataviews-patch.md): a row re-renders only when its item, the fields, the view, the actions or its own selected state change, so a checkbox toggle re-renders one row and a 100-row save re-renders 100 rows, not the page; everything handed to DataViews must therefore be referentially stable across renders (`getItemId`, `isItemClickable`, `actions`, `fields`, the item objects themselves: patch rows into new objects, never mutate). Cell renders are memoised too (`field()` in `fields/helpers.ts` wraps `render` in `memo`; `fieldFromDeclarative` too); the children store publishes load progress through one coalesced emit per `EMIT_WINDOW` (40 ms); while `expandAll` runs it publishes nothing at all (one render when the ids are expanded, one when the last load finishes), since a 100-parent page is one ~1,500-row table and every render of the growing table is O(rows) even with memoised rows; the counter next to "Expand all" reads `useExpandAllProgress()` (`{done, total}` from a store of its own) so progress never re-renders the table; user gestures emit at once; variation loads are abortable (see §11) and run `MAX_CONCURRENT_REQUESTS` (6) at a time.

## 10. Testing contracts

PHP integration tests extend `Tests\Integration\TestCase` (`actAs(role)`, `simpleProduct(props)`, `variableProduct(sizes, props)`) or `RestTestCase` (`request(method, route, params, headers)` adds the list-mode header and, on writes, a per-test batch id; `data(response)`, `assertStatus(code, response)`, `batchId()`). Run: `composer test` (unit), ddev/wp-env command in README (integration). JS: vitest, `tests/js/**/*.test.ts(x)`, jsdom, `sampleSettings()` in `tests/js/settings.test.ts` (move to `tests/js/fixtures.ts` when a second test needs it).

## 11. Hierarchy

`resources/hierarchy/` (see `docs/hierarchy-upstream.md` for the upstream mapping). The screen wires it like this:

```tsx
const hierarchy = useHierarchy( parents, visibleFields );   // parents: level-0 rows from useProductList

<HierarchyProvider value={ hierarchy }>                       // full API for toolbar/actions/bulk edit
  <HierarchicalDataViews
    data={ hierarchy.rows }                                   // parents + expanded variations + placeholders
    getItemParentId={ hierarchy.getItemParentId }
    getItemHasChildren={ hierarchy.getItemHasChildren }
    expandedItemIds={ hierarchy.expandedItemIds }
    onChangeExpandedItemIds={ hierarchy.onChangeExpandedItemIds }
    childrenState={ hierarchy.childrenState }
    onRetryChildren={ hierarchy.retry }
    getItemId={ getItemId }
    { ...dataViewsProps }                                     // view, fields, actions, selection, paginationInfo…
  />
</HierarchyProvider>
```

`HierarchicalDataViews` sets `getItemLevel` (from `_level`), defaults `isItemClickable` to `() => false` (a chevron button inside DataViews' title link would be invalid HTML; the name field renders its own link), and strips placeholder ids (`"12:loading"`) from `selection` / `onChangeSelection`. Actions must still declare `isEligible: ( item ) => ! item._placeholder` so placeholder rows get no checkbox.

**Name field.** Its `render` returns exactly

```tsx
<NameCell item={ item }>{ /* the link or text */ }</NameCell>
```

`NameCell` (from `resources/hierarchy`) draws the indentation (`--wc-pl-level`), the chevron with the variation count for level-0 parents (a spacer otherwise), the `id="wc-pl-row-<id>"` the parent's `aria-controls` points at, and the loading / error (+ Retry) / "N more" placeholder content. Do not add a second count badge or padding around it. The chevron reads the `HierarchyViewContext` that `HierarchicalDataViews` provides; outside it (tests, previews) `NameCell` renders without a chevron.

**Hook API** (`Hierarchy`, returned by `useHierarchy(parents, fields, options?)`): `rows`, `expandedItemIds`, `onChangeExpandedItemIds`, `isExpanded(id)`, `toggle(id)`, `expand(id)` (resolves when loaded), `collapse(id)`, `retry(id)`, `expandAll({ force? })` → `Promise<boolean>` (false when the user declined the > `EXPAND_ALL_WARN_ROWS` (600) rows confirm or nothing fits under `EXPAND_ALL_MAX_ROWS` (1,500)), `collapseAll()`, `getItemParentId`, `getItemHasChildren`, `getItemLevel`, `childrenOf(id)`, `childrenState`, `variationIdsOf(parentIds)` (loaded children or `_fields=id` fetch, `MAX_CONCURRENT_REQUESTS` in flight, cached per parent), `selectVariations(parentId, currentSelection, where?)` → new selection ids (expands first: DataViews drops selected ids that are not in `data`; `where(variation)` keeps only the matching ones, e.g. the out-of-stock). Options: `fetchVariations` (defaults to `api/client` `getVariations`), `maxChildren` (`limits.maxChildrenPerParent`), `confirmExpandAll`, `onExpandAllLimit`, `storage`. Module helpers: `abortLoad(parentId)`, `abortLoads()`, `loadingParentIds()`.

`useHierarchyContext()` returns that object (throws outside `HierarchyProvider`); `useOptionalHierarchyContext()` returns null instead.

**Variation loading.** `getVariations(parentId, page, { perPage: 100, fields })` where `fields` = `VARIATION_BASE_FIELDS` (`id,name,status,parent_id,attributes,image,sku,wc_products_list`) ∪ the visible fields' `rest.fields`. Page 1 first (gives the total) and published as soon as it arrives (status `loading`, the loading row below it), the rest in parallel through one limiter (4 in flight for the whole hierarchy), up to `ceil(min(total, maxChildren) / 100)` pages. Rows are normalised again with the parent row (`normalizeVariation(raw, parentRow)` copies `categories/tags/brands` read-only and sets `_parentName` for assistive tech).

**Cancellation.** Every load has an `AbortController` whose signal reaches `fetchVariations`. Collapsing the parent (`collapse`, `collapseAll`, `onChangeExpandedItemIds` without it), the parent leaving `parents` (next page, tab, filter) and unmounting abort it; a queued page whose signal is aborted is dropped by the limiter without taking a slot (`createLimiter(n)(task, { isCancelled })`). An aborted parent goes back to `idle` (unless a newer load owns it), so the next expand refetches; it never shows the error row. Loaded children of parents that are neither expanded nor on the page are evicted beyond `MAX_CACHED_PARENTS` (60).

**Children store.** Loaded variations live in a module-level store, not in the query cache, so `store/products.ts` must call, in addition to its cache patches:

```ts
import { patchVariationRows, removeVariationRows, invalidateVariations } from '../hierarchy';
patchItems( items )        → patchVariationRows( items )
removeItems( ids )         → removeVariationRows( ids )      // a parent id drops its whole subtree
invalidateProducts( { variations: true } ) → invalidateVariations()
```

Independently of that wiring, the hierarchy listens to `wcProductsList.saved` (`result.updated` → patch) and `wcProductsList.deleted` (`ids` → remove), so confirmed writes always reach the variation rows; the explicit calls are what make optimistic patches show.

**Placeholder rows**: `id = -parentId`, `_kind: 'variation'`, `_level: 1`, `_parentId`, `_placeholder: 'loading' | 'error' | 'more'`, `_placeholderMessage`; `getItemId` → `"<parentId>:<kind>"`.

**Persistence**: `sessionStorage['wcProductsList.expanded']` = JSON array of parent ids; ids not on the current page are kept so paging back restores them, bounded per page as described in §7 (`EXPAND_ALL_MAX_ROWS`; `EXPAND_ALL_WARN_ROWS` right after a reload). `expandAll` expands in page order only as many parents as keep the page under `EXPAND_ALL_MAX_ROWS` and calls `onExpandAllLimit({ expanded, skipped, rows })` (default: an info notice) when it skipped some; it resolves false when the user declined the warning or nothing fit.
