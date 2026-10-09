# Contracts

The authoritative interfaces between the PHP side, the JS app and extensions. Builders of the individual modules code against this document; when a module needs something that is not here, add it here first.

Conventions: PHP namespace `GeneroWP\ProductsList`, text domain `wp-woocommerce-products-list`, hook prefix `wc_products_list/`, script and style handle `wc-products-list`, admin page `edit.php?post_type=product&page=wc-products-list`, own REST namespace `wc-products-list/v1`. JS lives in `resources/` (TypeScript, `@wordpress/dataviews` 20 imported only through `resources/dataviews.ts`). Ids of fields are the wc/v3 keys. Times in REST are site-local ISO strings with `_gmt` twins, as wc/v3 does. Money is a decimal string (`"189"`, `"12.50"`).

## 1. Request headers (list mode)

| Header | Sent | Meaning |
| --- | --- | --- |
| `X-WC-Products-List: 1` | every request from the app | `ListMode::active()` is true: wc/v3 rows are enriched, extra params mapped, writes logged. Other wc/v3 consumers see nothing. |
| `X-WC-Products-List-Batch: <id>` | every write (POST/PUT/DELETE) | `ListMode::batchId()`; a UUID v4 (`ListMode::isBatchId()`); any other value is ignored and the request gets a generated id. One id per user gesture (one bulk save, one action on N rows), shared across the requests it takes. Groups log rows; `revert` works per batch. |
| `X-WC-Products-List-Batch-Planned: <n>` | every request of a save that takes several requests (a bulk save) | `Log\BatchState`: the items the job plans to write. Registers the batch as running between its requests until `POST /log/batch/{id}/close` (§3.6); without it a batch is running only while its one request runs. |
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
| `wc_products_list/drop_gallery` | `(bool $drop = true): bool` | `Rest\Rows`: on list-mode requests a product's gallery is not serialised (`images` holds the featured image only), which is most of the cost of a 100-row page or a 50-item batch answer; list-mode writes answer trimmed too unless the request body (or a batch item) sets `images`. Persistence and the log's old/new values (`Rows::withGallery()`) always see the stored gallery. On writes the gallery is dropped only while a saved product is turned into its response row: between `woocommerce_rest_insert_product(_variation)_object` and `woocommerce_rest_prepare_product(_variation)_object` (both at `PHP_INT_MAX`, keyed by product id; `Rows::startSerialising()` / `stopSerialising()`), so save listeners (`woocommerce_update_product`, insert hooks, extension actions) always see the full gallery. Return false to keep the gallery. |
| `wc_products_list/write_keys` | `(string[] $keys = []): string[]` | `Rest\Saves::writeKeys()`: extra top-level body keys that make `wc_products_list/save` fire, besides the declarative fields' `writeKey`s (§6). For integrations that take keys without declaring fields. |
| `wc_products_list/log_value` | `(mixed $value, string $path, WC_Product $product, string[] $segments): mixed` | `Log\Recorder`: the logged value of a nested write path (`i18n.se.name`). The default reader resolves `i18n.{lang}.{field}` to meta `_i18n_{field}_{lang}` and `meta_data.{key}` to that meta; return the value for other shapes. |
| `wc_products_list/log_retention_days` | `(int $days = 180): int` | `Log\Prune` |
| `wc_products_list/revert_chunk` | `(int $objects = 100): int` | `Log\Revert::chunk()`: objects one revert request writes at most; `GET /log/batch/{id}` cuts the batch into chunks of this size. |
| `wc_products_list/log_context` | `array $context, WP_REST_Request $request` | the `context` stored with every log row of a save (`keys`, `route`, `ip`, `ua`); unset `ip`/`ua` to keep no personal data beyond the user id |
| `wc_products_list/log_capability` | `(string $cap = 'edit_others_products'): string` | `Plugin::logCapability()`: gates `GET /log`, `/log/users`, `/log/batches`, `/log/batch/{id}` and `POST /log/batch/{id}/revert` (not `POST /log/skipped`, which needs `Plugin::capability()`). Settings `caps.viewLog`; without it `links.history` is `''` and the app hides History, its row action and every Undo that is a log revert. |
| `wc_products_list/action_batch_size` | `(int $size, string $actionId): int` | `Bootstrap::actionBatchSize()`: ids one `POST /actions/{id}` takes (defaults `duplicate` 5, `trash` 20, `delete` 20, else 100; capped at 100). Settings `limits.actionBatchSizes`. |
| `wc_products_list/revert_nullable_fields` | `(string[] $fields = ['low_stock_amount', 'stock_quantity']): string[]` | `Revert::nullableFields()`: integer\|null fields a revert writes back as `null` (not `''`, which wc/v3 casts to 0) when the logged old value was empty. |
| `wc_products_list/log_batch_summary` | `(?string $summary, ?string $action, array $args, array $batch): ?string` | `LogController::batchSummary()`: History's one-line name of a batch (`summary` on `GET /log/batches`), from its first action row's logged args. Built-ins name trash, restore, delete, duplicate, publish, draft and feature; null for a field-edit batch. gds-woo-i18n names its four tools ("Copy translations (Suomi → Svenska): Name"). |
| `wc_products_list/lock_timeout` | `(int $seconds = 10): int` | `Rest\Concurrency::lockTimeout()`: how long a list-mode save waits for another save of the same product or variation before it is refused with `wc_products_list_locked` (§3.6). |
| `wc_products_list/batch_running_ttl` | `(int $seconds = 120): int` | `Log\BatchState::ttl()`: how long after its last write a batch still counts as running (§3.6). |
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
| `variation_stock_status` | `instock|outofstock|onbackorder` → variable products with ≥1 published variation in that stock status (EXISTS on `posts` × `wc_product_meta_lookup` by `post_parent`). The Catalog's "Variation stock" filter (`fields/stock-status.ts` `createVariationStockFilter`): "Any variation: Out of stock" is the restock list. |
| `attribute` + `attribute_term` | wc/v3's own (no plugin mapping): products carrying any of the `pa_*` term ids. The Catalog's "Attribute: Colour" / "Attribute: Size" filters (`fields/attributes.tsx`, one filter-only field `attribute:<taxonomy>` per `settings.taxonomies` entry with `attribute: true`, operator `isAny`). wc/v3 takes one attribute per request: with two attribute filters the products follow the last one, the expanded variations both. |
| `orderby=sku|stock_quantity|menu_order` | lookup-table join; core already does `id,title,date,modified,price,popularity,rating,include,slug` |

| `search_name_or_sku` | in list mode the plugin's own search, not WooCommerce's: tokens split on whitespace, each must match the product's name or SKU **or the SKU of one of its variations**. Rows are always products (WooCommerce's search lists matching variations as rows of their own). |

The app always sends `_fields` (union of visible fields' `rest.fields` + `id,type,status,parent_id,featured,wc_products_list` on products — `featured` because the feature/unfeature actions decide on it whatever columns are shown — and `id,type,status,parent_id,wc_products_list` on variations), `image_size=thumbnail`, `per_page ≤ 100`, `search_name_or_sku` instead of `search`. Response headers `X-WP-Total`, `X-WP-TotalPages` are read. On list-mode reads `images` carries the featured image only (`wc_products_list/drop_gallery`).

Row (`Rest\Rows`, list mode only) adds:

```json
"wc_products_list": {
  "variation_count": 12,        // variable parents; 0 otherwise
  "edit_link": "https://…/post.php?post=1&action=edit",
  "can_edit": true,
  "can_delete": true,
  "parent_id": 0,               // variation rows: the parent id
  "variation_stock": {          // variable parents only (null/absent otherwise): from wc_product_meta_lookup of the published variations
    "out_of_stock": 4,
    "total": 16
  },
  "sale_summary": {             // variable parents only: the variations' sales
    "on_sale": 0,               // variations whose sale is in force now (lookup `onsale`)
    "scheduled": 12,            // variations with a sale price and `_sale_price_dates_from` in the future
    "from": "2026-10-12T00:00:00",   // earliest start among them, site-local ISO (null when none)
    "to": "2026-10-18T23:59:00"      // latest end (null when none / open-ended)
  }
}
```

`variation_stock` and `sale_summary` are optional (the app renders them when present: "4 of 16 variations out of stock" under the parent's stock status, a "Scheduled · 12 variations 12.10.2026 – 18.10.2026" / "On sale · 3 variations" line under "From X" in the price column) and must be computed in one query per page (the lookup table joined on `post_parent` for the page's variable products), never per row. They are part of `wc_products_list`, so `PARENT_DERIVED_FIELDS` (store/products.ts) refreshes them on the parents of saved variations.

plus extension keys from `wc_products_list/row` (gds-woo-i18n: `"i18n": {"se": {"name": {"value": "", "source": "Saga", "effective": "Saga"}}}`).

`GET /wc/v3/products/{id}/variations?per_page=100&page=N&_fields=…` likewise enriched (`Rest\Rows` on `woocommerce_rest_prepare_product_variation_object`), ordered `menu_order, id` by default; `wc_products_list/variation_query_args` applies.

**Cross-parent variation reads.** `GET /wc-products-list/v1/variations?parent=1,2,3&per_page=100&page=N&_fields=…` (`Rest\VariationsReadController`; ≤ 100 parent ids) returns every variation of those parents in one paged list, grouped parent by parent in the order given, each parent's in `menu_order, id`; `X-WP-Total` / `X-WP-TotalPages` count them all. `include=1,2,3` (≤ 100 variation ids, whatever their parents) instead of `parent`; exactly one of the two (400 otherwise). Rows are those of the per-parent route (dispatched in list mode, so permissions, `Rest\Rows` enrichment, the integrations' row filters and `_fields` match) and always carry `parent_id`. The client (`api/client.ts getVariationsAcross(parentIds, page, { perPage, fields, signal })`) answers null when the server has no such route (404 / `rest_no_route`, remembered for the page load), and the hierarchy then reads per parent. Expand all, Expand next, a restored expansion, "Select all variations" and `variationIdsOf` over several parents use it: an expanded 100-row page is one request per 100 variations (6 for ~600 rows), not one per parent (51).

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

`POST /wc-products-list/v1/actions/{action}` body `{"ids": [1,2,3], "args": {}}` (≤ `limits.actionBatchSizes[action]` ids: duplicate 5, trash 20, delete 20, others `limits.actionBatchSize` = 100; filter `wc_products_list/action_batch_size`) →

```json
{
  "batch_id": "…",
  "results": [
    {"id": 1, "ok": true,  "changed": 1, "data": {"new_id": 901}},
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

registered through `wc_products_list/action_handlers`. An id the action changes nothing on (an i18n Copy where every value is already there) logs a status `skipped` row with `context.reason = 'unchanged'` ("Skipped: it already had this value."), not an `ok` row. After the loop the parent of every variation an action touched is synced once (`ActionsController::syncParents()`: transients, `WC_Product_Variable::sync`, transients), so trashing or restoring a variation updates the parent's price range. The built-ins are registered as handlers only (priority 5), not as declarative `wc_products_list/actions` entries: the app has its own UI for them and calls `POST /actions/{id}` by id. Every id gets one log row (`source=action`, `action=<id>`), or one row per field when `run()` returns `changes => [field => [old, new]]`; a `context` array in the return value is stored in the row's context next to `args` (the rest of the return value is the result's `data`). An ok result carries `changed`: how many fields the handler reported (0 for a no-op); the app's notice counts on it ("2 updated, 1 already had these values") and offers Undo (the log's revert of `batch_id`) when any did. A `field` of a change is a wc/v3 write path (`sale_price`, `meta_data._key`, `i18n.se.name`), so the revert can write the old value back through the batch endpoints. `duplicate` logs one row with `field=duplicate`, `new_value=<new id>` and context `{new_id, new_title}`. Per-id result codes: `not_found`, `not_applicable` (outside `appliesTo()`), `forbidden` (`can()` false), `exception`, or the handler's `WP_Error` code. `delete` answers `{ok: false, code: 'wc_products_list_not_trashed'}` for a product that is not in the Trash unless `wc_products_list/allow_hard_delete` is true; a variation (WooCommerce has no Trash for variations) is deleted whatever its status, and the app offers it on variation rows as "Delete variations permanently" (confirm, no Undo). Request-level errors: 400 `wc_products_list_no_ids` / `_too_many_ids` (with `data.max`, the action's limit; `runAction()` chunks by `limits.actionBatchSizes` and re-chunks to `data.max` when it gets this) / `_invalid_ids`, 404 `wc_products_list_unknown_action`, 400 with the handler's code from `sanitizeArgs()`. The `items` refresh is one nested list request per (parent, status) group.

The app's status menu actions (Publish, Draft, Enable/Disable variations, Feature/Unfeature) are optimistic writes through `products/batch` and `variations/batch` with `X-WC-Products-List-Source: action` (`actions/status.ts optimisticBatch`); their snackbar offers Undo (the log revert of that batch).

### 3.4b Variations batch

Each item may carry its `parent_id`; it never addresses the write (the server groups by the variation's actual parent), but names the parent in the error log row of a variation deleted meanwhile (`woocommerce_rest_product_variation_invalid_id`), together with the attempted fields.

`POST /wc-products-list/v1/variations/batch?fields=` `{update: [{id, ...wc/v3 variation fields}]}` (≤ 100 items, `woocommerce_rest_batch_items_limit`; permission `edit_others_products` like every wc/v3 batch) → `{update: [...]}` in request order, each item a row trimmed to `fields` (`id` kept) or `{id, error: {code, message, data}}`. The items are grouped by their actual parent and dispatched to `POST /wc/v3/products/{parent}/variations/batch` from inside the request with this request's list-mode, batch and source headers, so validation, save hooks, logging and the `fields` trim are exactly those of a direct call; a `parent_id`/`product_id` in an item is ignored. An id that is not a variation gets `woocommerce_rest_product_variation_invalid_id` (404). One request for a scheduled sale across a page of variable products instead of one per parent.

### 3.5 Log

All log routes need `wc_products_list/log_capability` (default `edit_others_products`) except `POST /log/skipped`.

`GET /wc-products-list/v1/log?object_id=&batch=&user=&field=&source=&action=&since=&until=&search=&page=&per_page=` (`search` matches values, messages and the product, variation or parent name) → `{"items": [LogRow], "total": n, "totalPages": n}` ordered newest first.

```ts
interface LogRow {
  id: number; batch_id: string; created_at: string /* ISO, site tz */; created_at_gmt: string;
  user: { id: number; name: string };
  source: 'quick' | 'bulk' | 'action' | 'extension' | 'revert';
  action: 'update' | 'create' | 'trash' | 'restore' | 'delete' | 'duplicate' | string;
  object_type: 'product' | 'variation'; object_id: number; parent_id: number;
  object_name: string; edit_link: string | null;
  field: string; old_value: string | null; new_value: string | null;
  status: 'ok' | 'error' | 'skipped'; message: string; // skipped: the item was left out of the batch, the message says why (context.reason)
  related: { id: number; name: string; edit_link: string | null } | null; // the copy a `duplicate` row created, when it still exists
  reverts: string | null;        // the batch this row's revert put back (rows written by a revert), else null
  reverted_by: RevertedBy | null; // the latest revert of this row's batch
}
interface RevertedBy { batch_id: string; created_at: string; created_at_gmt: string; user: { id: number; name: string } }
```

`batch` (here and on `GET /log/batches`) is a full batch id, or the start of one: a value of 4 to 35 id characters becomes `batch_id LIKE 'prefix%'` (LIKE wildcards are taken literally); anything else is an exact match (`LogController::batchCondition()`).

`GET /wc-products-list/v1/log/users` → `[{id, name}]`: every user with log rows, sorted by name (the History screen's User filter).

`GET /wc-products-list/v1/log/batches?page=&per_page=&batch=&user=&source=&since=&until=&search=` → `{"items": [{batch_id, created_at, created_at_gmt, user, source, rows: n, objects: n, fields: string[], actions: string[], summary: string | null, update_fields: string[], action_summary: string | null, products: n, variations: n, parents: n, errors: n, skipped: n, skipped_reasons: string[], users: n, revertable: bool, reverts: string | null, reverted_by: RevertedBy | null}], total, totalPages}`; `search` returns whole batches that touched a product whose name matches; `summary` is the batch's readable name (`wc_products_list/log_batch_summary`), which History shows instead of composing it from `actions`/`fields`; `skipped_reasons` are the distinct `context.reason`s of the skipped rows ("1 change, 5 skipped (already had the value)"); `skipped` counts the distinct items the batch left out (status `skipped` rows), and `rows`, `objects`, `products`, `variations`, `parents`, `fields` and `actions` leave those rows out (History's Result column: "12 changes, 3 skipped"); `users` is the number of distinct users with rows in the batch, and a batch shared by more than one user is not revertable. `products` counts distinct products (not variations), `variations` distinct variations and `parents` their distinct parents, so the app can say "-20 % sale on 348 variations of 5 products". `reverts` names the batch a revert batch put back; `reverted_by` is the latest revert of this batch. `source` prefers a source other than `action`, so a bulk edit that also staged a language tool reads `bulk`. `update_fields` are the fields of the batch's own update/create rows (not those an action wrote) and `action_summary` the action's name; for a mixed batch `summary` joins both ('Date on sale to, Sale price + Mark as featured', at most 4 field labels then '+N more', `LogController::mixedSummary`). The History screen lands on this list (Batches) and opens a batch's per-field rows with "Show changes".

`GET /wc-products-list/v1/log/batch/{batch_id}` → `{batch_id, rows, objects, chunk, chunks: number[][], skipped: [{id, object_type, action}], failed: n, left_out: n, left_out_reasons: {reason: items}, users, revertable, reverted_by: RevertedBy | null}` (the revert confirm names `skipped` by action label and `left_out` by reason: "5 items were left out because they already had this value") (`rows` leaves status `skipped` rows out; `left_out` counts the distinct items the batch left unwritten, nothing to put back) (`skipped` entries of rows that failed when they were made have `action: 'failed'`; `failed` counts them; a revert result for such a row says "This change failed when it was made; there is nothing to revert.") (`revertable` false when `users > 1`): what a revert would write, the object ids in write order (products, then variations grouped by parent) cut into chunks of `chunk` (`Revert::chunk()`, 100).

`POST /wc-products-list/v1/log/batch/{batch_id}/revert?fields=` `{ids?, revert_batch_id?, force?, relative?}` → same shape as an action response (`results` per object, `items` trimmed to `fields`), written as a new batch with `source=revert`. Without `ids` the whole batch is reverted when it has at most `chunk` objects, otherwise 400 `wc_products_list_revert_too_large` with `data.chunks`; with `ids` (one chunk, ≤ `chunk`) only those objects, logged under `revert_batch_id` (a UUID v4, 400 `rest_invalid_param` otherwise) so every chunk of one revert is one batch (generated when absent; `batch_id` in the response). A batch with rows of more than one user answers 409 `wc_products_list_batch_shared`, and so does a `revert_batch_id` that already holds another user's rows. Integer\|null fields (`Revert::nullableFields()`) whose old value was empty are written back as `null`, so a revert never leaves `0` where there was no value. Ok rows with a field revert, whatever their action — an `update` or an extension action that reported `changes` (`i18n_copy`) — except those of the built-in `trash`, `restore`, `delete`, `duplicate` and `create` actions (`Revert::NOT_REVERTABLE`; trash has restore, delete is final), which are reported as skipped (`code: 'skipped'`), as are rows without a field (a no-op). A field whose current value is not what the batch left (changed again since, by anyone) makes its object a `conflict` result (nothing written for that object) unless `force` is true. A conflict result carries `{id, ok: false, code: 'conflict', object_type, parent_id, name, fields: string[], labels: string[] /* field labels, same order */, current: {field: value now}, batch: {field: value the batch left}, expected: {field: value a revert would restore}, relative: bool, message}`; the revert also writes one status `skipped` row per conflicting field in the revert batch (`old_value` = current, `new_value` = the value the revert would have put back, context `{reason: 'conflict', batch_value}`), which a later plan ignores. `relative: true` takes the batch's change off the current value for the fields in `Revert::relativeFields()` (filter `wc_products_list/revert_relative_fields`, default `['stock_quantity']`), so a sale made since is kept (+10 restock, 1 sold, relative revert → current − 10); `relative` on a conflict result says every conflicting field supports it, and History offers "Subtract the change instead". A conflict result also carries `already_reverted: string[]`: fields an earlier `ok` revert of the same batch already wrote (`Revert::revertedFields()`, one query on the indexed `reverts` column). Such fields are never adjusted relatively, so a second revert cannot take a change off twice; `relative` is false when any conflicting field is in `already_reverted`, the message says it "was already put back by an earlier revert of this batch", and the skipped row's context carries `already_reverted: true` (reason stays `conflict`).

`POST /wc-products-list/v1/log/batch/{batch_id}/close` (plugin capability) → `{batch_id, closed: bool}`: the app's save of the batch is over; see §3.6. Only the batch's writer may close it while it runs (403 `wc_products_list_batch_shared` otherwise); a user with the log capability may close (dismiss) someone else's interrupted batch.

`GET /log/batches` items also carry `state: 'running' | 'interrupted' | null` and `planned: number | null` (§3.6). `GET /log/batch/{id}` carries `state` too.

`GET /log/batch/{id}`, `GET /log/batch/{id}/check` and `POST /log/batch/{id}/revert` answer 409 `wc_products_list_batch_running` while the batch is still being written (§3.6). `POST …/revert` answers 409 `wc_products_list_revert_running` while another revert of the same batch runs (`Concurrency::claimRevert()`: a transient `wcpl_revert_{md5(batch)}` holding the revert's `revert_batch_id`, read and written under a short MySQL named lock; the chunks of one revert, posted side by side under one `revert_batch_id`, share it, and it lapses `REVERT_CLAIM_TTL` = 30 s after the revert's last chunk; a revert posted without `revert_batch_id` drops it when its request ends). Each write of a revert carries the values the revert's check saw as `_wcpl_expect` (§3.6), so a field changed between the check and the write is reported as a `conflict` result (message "… was changed while this revert was running …", `already_reverted: []`) and logged as a `skipped` row with reason `conflict`, never overwritten. `GET /log/batch/{id}` builds the plan in SQL (`LogController::revertableCondition()`, `writeOrder()`): one row per written object plus the full rows of the others, so a 24k-row batch is not loaded into PHP.

`GET /wc-products-list/v1/log/batch/{batch_id}/check?ids[]=` (log capability; `ids` optional, at most `chunk`, 400 `wc_products_list_invalid_ids` otherwise; 404 `wc_products_list_batch_not_found`) is a dry run of the revert's conflict check: nothing is written or logged (`Revert::check()`). → `{batch_id, checked, objects, complete, changed, already_reverted /* count */, items: [{id, object_type, parent_id, name, fields, labels, current, batch, expected, relative, already_reverted: string[]}]}`. Without `ids` only the first chunk is checked (`complete: false` when the batch has more), so the app checks chunk by chunk (`checkRevertPlan()`).

`POST /wc-products-list/v1/log/skipped` `{batch_id: UUID v4, source?, items: [{id, reason, fields?: string[], message?}]}` (≤ 100 items; `reason` one of `trashed | deleted | conflict | locked | no_stock_management | has_sale | no_sale_price | below_zero | not_applicable | unchanged | failed | other`, each with a translated default message; `message` is kept up to 500 chars) → `{batch_id, logged: number[], rows: n}`: records the items a save left out on the client as status `skipped` rows of its batch: one row per item, `field` set only when `fields` has exactly one entry (else `''`), `context` `{reason, fields: [...]}`; the `/log` `field` filter also matches skipped rows by `context.fields` (exact and `*` wildcard). `GET /log` rows carry them as `skipped_fields: string[]` (empty for every other row), and History shows their labels in the Field column. Needs the plugin capability; only products and variations the user can edit are logged; 409 `wc_products_list_batch_shared` when the batch already holds another user's rows. The editor posts it fire-and-forget after every save that left items out (moved to the Trash or deleted meanwhile, no stock management, an existing sale kept, a sale price that would not be lower), chunked by 100 (`logSkipped()` in api/client.ts; `SaveResult.skippedItems` / `SavePlan.skippedItems`). Reason `failed` is different: the editor posts it for items whose write failed (the wc/v3 or fetch error as `message`), and it is stored as status `error`, not `skipped`, so History and the batch list count the item as failed; such a row holds no field values, so a revert plans it as `failed` and never writes it. Per-item 409s of the save itself (`wc_products_list_conflict`, `_locked`, `_trashed`) are already logged by the server (§3.6) and are not posted again.

Table `{prefix}wc_products_list_log` (schema version 2, upgraded by dbDelta): `id BIGINT PK, batch_id VARCHAR(64), created_at DATETIME, user_id BIGINT, source VARCHAR(20), action VARCHAR(40), object_type VARCHAR(20), object_id BIGINT, parent_id BIGINT, field VARCHAR(100), old_value LONGTEXT NULL, new_value LONGTEXT NULL, status VARCHAR(10), message TEXT, context JSON/LONGTEXT, reverts VARCHAR(64)`; indexes `batch_id`, `(object_id, created_at)`, `user_id`, `created_at`, `reverts`. `Revert::apply()` calls `Logger::setReverts(<original batch>)`, so every row a revert writes (including the nested wc/v3 requests) names the batch it put back. Values are JSON-encoded when not scalar.

### 3.6 Concurrent edits (Rest\Concurrency, Log\BatchState)

Client-side row locks only exist in one tab. The server is the arbiter: every list-mode wc/v3 product or variation write (quick edit, bulk save, the cross-parent variations batch, a History revert) passes `Saves::guard()` in `woocommerce_rest_pre_insert_{product,product_variation}_object` before WooCommerce saves it.

1. **Object lock.** `GET_LOCK('wcpl_{site}_o_{id}', wc_products_list/lock_timeout)` from the check to the end of the item's insert hooks (`Saves::inserted`), released also when the next item starts, at the end of the request, and by MySQL when the connection ends. Two app writes of the same object never interleave. Timeout → the item is refused: `wc_products_list_locked` (409), logged as a `skipped` row with reason `locked`. A database without named locks carries on unlocked.
2. **Fresh state.** A batch primes its items' caches up front (`Saves::primeBatch()`); under the lock the item's post row and meta are read again (two indexed queries), and when they differ from the cache the caches are dropped (`Concurrency::forget()`, WooCommerce's raw meta and product instance caches too) and the request's changes (props and meta) are put on a fresh load (`Concurrency::refresh()`). WooCommerce's derived values (`_price`, sale < regular, stock status, lookups) and the recorder's old values come from the stored state.
3. **Trash.** A product in the Trash, or a variation of one, is refused with `wc_products_list_trashed` (409, `skipped` row with reason `trashed`) unless the request sets `status`.
4. **Expected values.** Each item may carry `_wcpl_expect`: a flat map of log field path (`regular_price`, `categories`, `meta_data.{key}`, `i18n.se.name`, …) to the value the editor based the change on, as loaded (any JSON; compared in stored form, `null` and `''` alike, numbers by value, term and image lists by their ids in any order: `Concurrency::same()`). Send it for every field the item changes, for absolute and relative ops alike; a reload of the row gives fresh values. When a stored value differs, the item is not written: `wc_products_list_conflict` (409) with `data: {id, fields: string[], current: {path: value now}, expected: {path: value sent}}` (a batch item gets it as its `error`), logged as a `skipped` row per field with reason `conflict` (old = the stored value, new = the attempted one). The key itself is never logged (`Recorder::IGNORED_KEYS`). Writes outside the app (classic editor, orders, imports) do not take the lock, but are caught by this comparison.

The app sends `_wcpl_expect` on every quick and bulk write item (`resources/edit/expect.ts`, `writeItem()`): the loaded value of each changed core scalar key (`regular_price`, `sale_price`, the sale dates, `stock_quantity`, `status`, `sku`, `name`, …), term lists (`categories`, `tags`, `brands`, by id) and single-valued `meta_data.{key}`. It sends none for `inventory_delta` (a relative stock op is applied to the stock as stored, so an order meanwhile is not a conflict), for objects whose list form differs from the stored one (images, attributes, dimensions) or for extension fields; those rely on the lock and the fresh-state check. The editor shows `wc_products_list_conflict` as "Changed by someone else since it was loaded … apply the edits again" and re-reads those rows (the list shows the stored values, a retry works on them), `wc_products_list_locked` as "Another save of this item was running … try again", `wc_products_list_trashed` as "This item is in the Trash"; it does not post these to `/log/skipped` (the server logged them). A save of more than one row sends `X-WC-Products-List-Batch-Planned: <rows>` on each request and closes the batch (`closeBatch()`) in the runner's `finally`, before the snackbar offers Undo. History's batch list shows `state` ("Still running…", "Interrupted: N of M written"); the revert dialog shows the 409's message when the plan is refused.

**Running batches.** `Log\BatchState` keeps one non-autoloaded option `wcpl_batch_{id}` per batch being written (`{user, planned, started, updated, parents}`), set by every outermost list-mode write with a batch header (not the log routes, not `source=revert`) and only for the batch's own user.

- Without `X-WC-Products-List-Batch-Planned` the marker lives for the request only.
- With it (send it on every request of a multi-request save), the marker stays between the requests until the client calls `POST /log/batch/{id}/close` (in the save's `finally`, before offering Undo).
- While the batch was written to within `wc_products_list/batch_running_ttl` (120 s) it is `running`: the plan, check and revert of it answer 409 `wc_products_list_batch_running` ("This update is still running … Revert it when it is done.").
- A planned batch whose writes stopped and that was never closed is `interrupted` (`GET /log/batches` `state`, with `planned`): History can say "interrupted: N of planned written" and offer continue or undo.
- `parents` are the variable parents of the request in flight: when it died, WooCommerce's deferred parent sync never ran, and `BatchState::repair()` runs `WC_Product_Variable::sync()` for them the next time the stale marker is read (History, close, the daily prune).
- The daily log prune drops stale unplanned markers and interrupted ones older than the log retention.

## 4. Logging rules (Rest\Saves + Log\Recorder)

In list mode, `woocommerce_rest_pre_insert_product_object` / `_variation_object` snapshot the current value of every key present in the request body (top-level wc/v3 keys, each `meta_data[].key`, each extension write path such as `i18n.se.name`) from a fresh load of the product; `woocommerce_rest_insert_*` diffs against the saved product and writes one row per changed field (no row for no-ops; `null` and `''` compare equal), `action=update` (`create` for a new object), `source` from header `X-WC-Products-List-Source` (§1, default `quick`), `batch_id` from the batch header when it is a UUID v4 and holds no other user's rows (generated otherwise: `Logger::isOthers()`, so a known batch id cannot be used to make someone's batch shared and unrevertable). A refused write logs nothing: only requests that passed their permission check, by a logged-in user with `Plugin::capability()`, are logged, and refusals (`rest_forbidden`, `rest_cannot_*`, `rest_not_logged_in`, `woocommerce_rest_cannot_*`, `woocommerce_rest_authentication_*`, 401/403) are dropped from error rows, top level and per batch item (`Saves::mayLog()`, `Recorder::isRefusal()`). WooCommerce's relative stock key `inventory_delta` (added to the stock as stored at write time when the body has no `stock_quantity`) is logged as a `stock_quantity` row with the absolute old and new values; an error row shows the attempt as `+N`/`-N`. The app sends relative stock ops (increase/decrease by N or %) this way (`resources/edit/payload.ts STOCK_DELTA_KEY`), so an order placed while the editor is open is kept; a decrease the editor clamped at 0 is sent as the absolute `stock_quantity: 0`. Rows that may go negative (backorders `yes`/`notify`, or stock already below 0: `bulk-numeric.ts stockMayGoNegative()`) are never clamped: the exact requested amount is sent as `inventory_delta` (stock −3, decrease 2 → `-2`); the clamp to an absolute 0 applies only to rows without backorders whose stock is at or above 0, and a percent op leaves a negative stock alone. Values are stored as strings in wc/v3 **input** shape (`true`/`false`, dates `Y-m-d\TH:i:s` site time, term lists `[{"id":n}]`), so a revert posts them back verbatim. Batch endpoints fire the same hooks per item; in list mode each batch sub-request also gets the batch request's `fields` as its own `_fields` (`Rest\Saves::forwardFields()`), so WooCommerce builds only the row fields the app asked for (no price range or gallery for a status change) and integrations can respect it. Validation errors that throw before `pre_insert` (duplicate SKU) are logged as `status=error` rows with the field list from the request body. Error rows record what was tried: with one field, `old_value` holds the stored value and `new_value` the attempted one; with several, `context.before` and `context.attempted` hold them (`Recorder::attempted()`). A duplicate-SKU error names the owner in list mode: `The SKU "X" is already used by "Name" (#id).` A list-mode `products/batch` primes its items' posts, meta and raw meta up front and runs under WooCommerce's `ProductTransientsDeferrer`, so product transients are deleted once per request, not per item. Errors also go to `wc_get_logger()` source `wc-products-list`. The rows of a saved item are written right after it (`Saves::inserted` flushes the buffer), so a request killed mid-batch leaves no saved item without its row; error rows go in one multi-row INSERT at `rest_request_after_callbacks` (priority 1000) or shutdown. `Saves::inserted` runs at priority 20 (`Saves::INSERTED_PRIORITY`) of `woocommerce_rest_insert_{product,product_variation}_object`, after WooCommerce Brands writes `brands` at 10, so a brands change is logged and revertable. WooCommerce's side effects on the sale are logged with the change that caused them: when a request writes `regular_price`, `sale_price` or a sale date, `sale_price`, `date_on_sale_from` and `date_on_sale_to` are snapshot and diffed too (`Recorder::SALE_KEYS`, `watched()`), so a regular price at or below the sale price logs the cleared sale in the same batch and a revert puts it back. Stock status is not added (it follows the quantity). Items refused by §3.6 (`wc_products_list_conflict`, `_locked`, `_trashed`) are logged as `skipped` rows with context `reason` `conflict` / `locked` / `trashed` (`Recorder::SKIP_REASONS`), not as errors.

## 5. Bootstrap payload (`window.wcProductsListSettings`)

Typed in `resources/types/settings.ts` (`Settings`). Produced by `src/Bootstrap.php`, filtered by `wc_products_list/bootstrap`. Keys: `version, locale, currency {code, symbol, position, decimals, decimalSeparator, thousandSeparator}, units {weight, dimension}, dateFormat, timeFormat, timezone, user {id, name}, caps {edit, editOthers, publish, delete, deleteOthers, manageWoocommerce, manageTerms, viewLog}, statuses[], productTypes[], stockStatuses[], catalogVisibility[], backorders[], taxStatuses[], taxClasses[], shippingClasses[{id,value,label}], taxonomies[{name,label,restKey,hierarchical,attribute}], features {cogs, brands, reviews}, limits {perPageMax 100, maxChildrenPerParent 1000, batchSize 50, actionBatchSize 100, actionBatchSizes {actionId: n}}, links {admin, rest, page, history ('' without caps.viewLog), legacyList, newProduct, editProduct (sprintf %d), assets}, fields: DeclarativeField[], filters: DeclarativeFilter[], actions: DeclarativeAction[], languages: null | {default, others[], labels{}, currencies?{}}`. Option lists are `{value, label}[]`.

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
export function revertBatch(batchId: string, options?: RequestOptions & { fields?: string[]; ids?: number[]; revertBatchId?: string; force?: boolean; relative?: boolean }): Promise<ActionResponse>   // one chunk with ids (+ revert_batch_id shared by all chunks); conflicts come back as results { ok: false, code: 'conflict', fields, relative, already_reverted?: string[] }
export function checkRevert(batchId: string, options?: RequestOptions & { ids?: number[] }): Promise<RevertCheck>   // GET /log/batch/{id}/check (dry run, §3.5)
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
export function patchItems(items: Array<Partial<ProductListItem> & { id: number }>): void   // a pure cache merge into every cached list + variations page, and the hierarchy's children store (patchVariationRows); does NOT mark rows edited
export function markEdited(ids: Iterable<number>): void   // rows the user wrote: kept on a refetch of the same view as _noLongerMatches; called on wcProductsList.saved (`updated`) and wcProductsList.actionPerformed (`ids`)
export function removeItems(ids: number[]): void                                           // likewise (removeVariationRows)
export function invalidateProducts(options?: { counts?: boolean; variations?: boolean }): void  // variations: also invalidateVariations() of the hierarchy, which marks loaded variations stale (status 'idle', items kept on screen) instead of dropping them: expanded parents refetch and replace their rows only when the whole list is back, so a refetch never removes a row from under an open quick edit
export function refreshParentsOf(rows: ProductListItem[]): Promise<number[]>                 // GET products?include=…&_fields=PARENT_DERIVED_FIELDS for the cached parents of saved variations, then patchItems; runs on wcProductsList.saved
export function cachedProductIds(): Set<number>
```

`resources/store/rows.ts`: `setCurrentRows(rows)` (the Catalog screen, on every render of its rows) / `getCurrentRows()` (placeholders excluded) back `window.wcProductsList.getItems()`.

### `resources/list/selection.ts`, `selection-bar.tsx`, `whole-selection.ts`

The selection spans pages, searches, filters and sorts; a status tab change clears it. `useSelection(pageRows, resetKey)` returns `{ selection (ids, page rows first in page order), rows (fresh page objects where present, stored ones otherwise), offPageCount, onPageSelectionChange(ids) (DataViews' page-scoped change: replaces the page's part, keeps the rest), set(ids) (whole replace; ids without a row are dropped), clear(), selectAllMatching(query, total) (every product of the current list request in pages of `limits.perPageMax` with `_fields` = `SELECT_ALL_FIELDS`; capped at `MAX_SELECT_ALL` = 5,000 with an error above it; progress + cancel), selectAllProgress, selectAllError }`. The selection survives saves and actions, so bulk steps chain on the same set (status → price → tags): only rows that no longer exist leave it (`wcProductsList.deleted` ids, and `wcProductsList.saved` `errors` with a gone code, `edit/errors.ts isGoneCode`); rows a save or an action took out of the filtered list stay selected and count as "not in this view". `addRows(rows)` adds rows the caller already holds (variations loaded by "Select matching variations" before DataViews rendered them). `selectRows(ids: number[]): boolean` (module export) makes the mounted selection exactly those ids (known rows only), for notices outside the screen's tree ("Select the 15 skipped"); false when no list is mounted. Shift-click on a row checkbox selects or clears the range from the last checkbox clicked (`hierarchy/hierarchical-dataviews.tsx rangeSelection`). Alt+B (Option+B; `BULK_EDIT_SHORTCUT`, `aria-keyshortcuts` on the button) opens the editor on the selection from anywhere on the screen except text fields and the editor panel. The `trash` action is a `RenderModal`: one unpublished row goes at once (the modal renders nothing and closes), a published product or several rows are confirmed first (names listed), then the rows leave the page before the request with an Undo (restore) in a snackbar that stays until it is dismissed or a newer Undo snackbar replaces it (`ui/notices.tsx STICKY_UNDO_PREFIXES`; other Undo snackbars hide after 10 s, paused on hover/focus; only the latest Undo snackbar is kept). The screen passes `onPageSelectionChange` to DataViews and `set` to the actions context. `withWholeSelection(actions, getWhole)` wraps every `supportsBulk` action's `callback`, `RenderModal`, `label` and `modalHeader`: when DataViews passes exactly the page's selected rows, the rows selected on other pages are appended (`extendToWholeSelection`), so the footer's "Bulk edit" and the status/feature/trash actions act on the whole selection. `SelectionBar` (toolbar) shows "N selected (M not in this view)" (on other pages, or filtered out), "Select all N products", "Bulk edit" (calls `onEdit(rows)`: the screen opens the bulk editor in the panel on the selection) and "Clear selection". `WholeSelection.onPage` is the selected ids among the rows DataViews shows (`hierarchy.rows`); every other selected row (other pages, and variations under a collapsed parent) is `offPage`, so the row/footer label and the rows the editor opens with always agree. A bulk action with a count-dependent label (quick-edit: Quick edit / Bulk edit) called with one row stays on that row, label and callback alike: the memoised DataViews rows do not re-render when the selection elsewhere changes, so a widened row label could go stale; the selection bar's Bulk edit (and Alt+B) covers the whole selection.

### Editor panel (`resources/edit/editor-panel.tsx`, `editor-context.tsx`, `editor-session.ts`, `list/products-screen.tsx`)

Quick edit and bulk edit open in a slide-in panel on the right of the Catalog, like the product editor of WooCommerce's DataViews products app (removed in woocommerce#67883) and the site editor's side panels: never a modal and never a row of the table. The screen becomes a split view [list | panel]: the panel is `position: fixed` under the admin bar at `right: 0`, full height, `width: min(var(--wc-pl-panel-width), 100%)` (`100%` of a fixed box is the window without its scrollbar, so its right edge is always the window's, whatever the admin menu's state); on viewports 960 px and wider the list gets `margin-inline-end` = the panel's width + 16 px (one reflow; only the panel animates, a 200 ms `translateX` slide-in through the class `is-sliding`, set only when the document is visible so a panel opened in a background tab is not left off screen at the animation's first frame, and none under `prefers-reduced-motion`); below 960 px the panel covers the whole window (admin menu included) as a drawer with a shadow and no backdrop, and its resize handle is hidden. The list stays fully usable beside or under it (scroll, tick, expand, page, sort, filter). DataViews gets the same `data` whether the panel is open or not (`hierarchy.rows`), and the open session lives in a small store (`createSessionStore()` in products-screen.tsx: `get/set/subscribe`) that only `EditorMount` renders from, so opening, switching and closing the editor re-render neither the screen nor the table rows.

- **Markup**: `<aside class="wc-pl-editor-panel is-quick|is-bulk" role="region" aria-label="Quick edit: <name>" | "Bulk edit: N items" tabIndex=-1>` (`editorRegionLabel(host)`) holding a resize handle, a pinned header (a "Back to the list" skip link shown on focus, the heading slot, the close X "Close the editor") and a body that scrolls on its own (`.wc-pl-editor-panel__body`, `scroll-padding-block: 8px 88px` so a focused field clears the footer). The editor portals its heading (title, the bulk breakdown "3 products, 12 variations", the loading line) into the header slot (`EditorHost.headerSlot`); until the chunk has loaded the panel shows its own title there. The editor's footer (Update / Cancel / Update & next / progress) is `position: sticky; bottom: 0` in the body. The bulk item list is a collapsible `<details class="wc-pl-inline-edit__selection" open>` ("Selected items (N)") at the top of the body; the whole-selection and "N of them are not in this view" lines stay above it.
- **`<html>` classes**: `wc-pl-panel-open` plus `is-quick-edit` / `is-bulk-edit` while the panel is open (snackbars stay left of it), `wc-pl-panel-resizing` while its edge is dragged. CSS custom properties `--wc-pl-panel-width` (on the panel and `.wc-products-list__notices`) and `--wc-pl-panel-inset` (on `.wc-products-list`, the room the list makes), both in px and registered with `@property … inherits: false`, so opening, closing or resizing the panel restyles those elements only, not every row (a custom property on `<html>` restyled the whole ~600-row list, ~100 ms).
- **Width**: about half the window: it opens at 52 % of the window's width (`PANEL_DEFAULT_SHARE`), between 480 px (`PANEL_MIN_WIDTH`) and 75 % of the window (`PANEL_MAX_SHARE`), and never so wide that the list right of the admin menu (`#wpcontent`'s left edge) keeps less than 320 px (`LIST_MIN_WIDTH`); below 960 px (`PANEL_DRAWER_BELOW`) it is the window's width (`maxPanelWidth(viewport?, left?)`, `minPanelWidth(viewport?)`, `clampPanelWidth(width, viewport?, left?)`, `panelWidthFor(share, viewport?, left?)`). The user's choice is stored as a share of the window (three decimals), not pixels, in the user's preferences (`wc-products-list` / `editorPanelShare`, core `wp-preferences`, so it survives reloads and keeps its proportion from a laptop to a wide monitor; widths set in drawer mode are not stored; the 0.1 `editorPanelWidth` pixel preference is ignored). The width is refitted on window resize and when the admin menu folds or unfolds (`wp-menu-state-set`), one `requestAnimationFrame` per burst. Measured in Chrome at 1280 / 1440 / 1920 / 1000 / 800 px windows (classic 22 px scrollbar): 654 / 737 / 986 / 497 (list keeps 320 px) / 778 (drawer, full width) px; the panel's right edge is the window's, no horizontal overflow of the page, the panel body or its tab strip, every input inside the panel, and the footer buttons fully visible; the same with the admin menu folded. The handle is a `role="separator"` (`aria-orientation="vertical"`, `aria-valuenow/min/max`, label "Resize the editor panel"): pointer drag (only the panel follows the pointer, through `requestAnimationFrame`; the list moves over once on release) or ArrowLeft/ArrowRight (16 px, 64 px with Shift), Home (minimum), End (maximum). Each change is clamped and stored.
- **Edited row**: the quick-edited row (any layout: `tr`, grid card, list item, found through its name cell's id `wc-pl-row-<id>`) gets the attribute `data-wc-pl-edited` (`EDITED_ROW_ATTRIBUTE`; edit/style.scss gives it a tinted background and a 4 px inset left border in the admin theme colour) and `aria-current="true"` on the row element itself, not a class (DataViews re-renders a row's class name on hover and selection; React leaves attributes it does not manage alone) and not a generated style rule (changing a stylesheet restyled the whole document). A MutationObserver on the row's parent moves the mark when the list replaces the row element. Switching quick edit to another row hands the open panel the new session after the leave guard (it does not close in between). When it is off screen it is scrolled into view (`block: 'center'`), decided by an `IntersectionObserver` so nothing is measured in the commit. Update & next and a switch to another row move the highlight with the session; a bulk edit highlights nothing (the ticked rows are what it edits).
- **Focus and keys**: non-modal, no focus trap. The editor focuses its form on mount and its first field once the form is there (a variation: the regular price); on close focus returns to `origin` (the row's actions button by position, else the first ticked row, else the table). F6 (no modifiers) moves focus between panel and list (`focusList(host)`: the edited row's last button, else the first ticked checkbox, else `#wc-products-list-table`; `focusPanel(panel)`: the first field, else the panel); the "Back to the list" link does the first. Escape in the panel's chrome (close button, handle) closes through the editor's leave guard; inside the form the editor handles Escape itself (a select's dropdown or a picker keeps its Escape; a dirty form asks "Discard N unsaved changes?"). Escape in the list does not close the panel.
- **Sessions**: each session (`sessionKey(session)`) mounts its own editor in the same panel, so Update & next and Quick edit on another row swap the editor without sliding the panel out and in. Switching to another row while the editor is dirty asks the discard confirm first ("Keep editing" keeps the current row).
- **Layouts**: the panel works beside the table, grid and list layouts; switching layout keeps it open (`viewChangesRows` ignores `type`).
- **Quick edit on every row**: the `quick-edit` action sets `showIcon: true` (`ProductAction.showIcon`), and the patched DataViews `ButtonTrigger` renders such a primary action as a compact icon button (`.dataviews-primary-action-button`, the pencil, its label "Quick edit" as accessible name and tooltip) instead of a text button; style.scss keeps it visible on every row (DataViews shows primary actions only on hover). Plain CSS: no per-row state, no render cost. The ⋮ menu keeps Quick edit too (and is the only entry below 782 px, where DataViews hides primary actions).
- **Name column**: the name only; the SKU is its own column and never a second line under the name (`sanitizePersisted` drops `descriptionField: 'sku'` from saved views, no default layout sets a `descriptionField`).
- **HTML fields** (`ProductField.html`: `short_description`, `description`, and declarative `type: 'html'` fields such as the i18n descriptions): `edit/html-text-control.tsx createHtmlTextControl({ rows })` instead of a textarea of raw markup. Visual (default): a `contenteditable` `role="textbox"` with a toolbar (Bold, Italic, bulleted list, numbered list, Link (Ctrl/Cmd+K, an inline URL box whose Enter/Escape stay in it), Remove link); text is decoded (`&amp;` reads as &, `<br />` as a line break); paste is plain text (blank lines become paragraphs). Code: the stored HTML in a textarea. The choice is remembered per browser (`localStorage` `wc-products-list:html-editor-mode`). Round trip: nothing is written until the text is edited; a value without block tags (relying on `wpautop`) is shown as paragraphs (`toVisualHtml`) and stored without them again (`fromVisualHtml`: `</p><p>` → blank line, `<br>` → newline); `<b>`/`<i>` become `<strong>`/`<em>`, the browser's top-level `<div>`s `<p>`, an emptied editor ''. A value with HTML comments (block markup), `script`/`style`/`iframe`/`object`/`embed`/form controls/`svg`, an `on*` attribute or a `javascript:`/`vbscript:`/`data:text/html` URL opens in Code with a note and Visual disabled (`visualProblem`): it is parsed in an inert `DOMParser` document first, so nothing runs or loads. It is in the edit chunk, not the main bundle. Not used for a bulk field whose rows disagree (it keeps the Mixed control).
- **Performance marks**: `markEditorOpen()` (`wc-products-list:editor-open`, set when the screen opens an editor) and `measureEditorReady()` (`wc-products-list:editor-ready`, a `performance.measure` taken when the first field has focus), for audits.
- **Checkbox ids**: the editor's checkboxes use `ui/checkbox-control.tsx` (an id from React's `useId`): DataViews' inlined components copy counts `inspector-checkbox-control-N` from zero too, and a shared id sent a click on the editor checkbox's label to the list's select-all checkbox.

The screen owns one `EditorSession` (`{ mode: 'quick', id, initialTab?, origin }` or `{ mode: 'bulk', initialTab?, origin }`; `origin` is the `FocusOrigin` focus returns to on close: for a quick edit the row's position in the table body, `focusOriginForRow`) in its session store; `EditorMount` builds the `EditorHost` and renders `EditorHostProvider` (which renders the panel while a host is set): `{ session, fields, items (the edited row, or the live selection), offPageCount, wholeList, close(), advance(row), removeItem(id), setGuard(guard), setBusy?(busy), headerSlot? }`. The `quick-edit` action is a `callback` action (`isPrimary`, `supportsBulk`): one row opens a quick session, several make the selection those rows and open a bulk session (`ProductActionsContext.openEditor`). The editor installs a leave guard (`() => Promise<boolean>`: true at once when clean, after the "Discard N unsaved changes?" confirm when dirty, false while a save runs); the screen asks it before a view change that swaps the rows (`viewChangesRows`: page, perPage, search, sort, filters; column, density and layout changes pass through and keep the panel open), a status tab change, a collapse of the edited variation's parent (the chevron, the Expand/Collapse row action and Collapse all all go through the same guard: the screen passes a guarded hierarchy to the actions and the HierarchyProvider), and before opening another editor; a quick session whose row leaves `hierarchy.rows` (trashed, refetched away) closes with an info notice, but not while the edited variation's parent is still refetching its rows, and never while a save runs (`setBusy`); a bulk session whose selection empties closes silently (not while saving). Keyboard: the editor root takes focus on mount and the first control once the form is loaded; Escape closes (guarded); Enter in a single-line input updates, Cmd/Ctrl+Enter from anywhere, Shift+Enter updates and moves to the next row on screen (`advance`); on unmount focus returns to `origin` (the row's actions button by position, else the table). The bulk editor follows the live selection until the first save (a ticked row is hydrated on its own for every tab visited; the x on a listed item calls `removeItem`); from the first save on it works on the rows that save had, so a partial failure keeps the editor open on them with "Retry N failed". Extensions cannot replace the editor (no `RenderModal` on the `quick-edit` action); they add tabs and fields as before.

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
export const EXPAND_ALL_WARN_ROWS = 400     // expandAll asks above this
export const EXPAND_ALL_MAX_ROWS = 600      // a page never grows past this: expandAll stops in page order (notice), restored/revisited expansions are trimmed
export const BULK_PUBLISH_ROWS = 50         // bulk loads (expandAll, expandNext, a restored expansion) commit loaded parents in slices of about this many rows (one per macrotask; a parent is never split), never one render of the whole page at the end and never a commit long enough to leave the request limiter idle
export const ACROSS_MAX_PARENTS = 100       // parents per cross-parent variations request
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
export function InlineEditor({ host }: { host: EditorHost }): JSX.Element   // inline-editor.tsx (build/edit.js): the quick/bulk form; see "Editor panel" above
export function saveLabelFor(plan: SavePlan): string; export function successMessage(result: SaveResult): string; export function partialFailureMessage(result, names, detailed?): string; export function nextRowOnScreen(id: number, rows?): ProductListItem | null   // inline-editor.tsx
export type EditorSession; export function findEditedRow(rows, id): ProductListItem | undefined; export function viewChangesRows(current: View, next: View): boolean   // editor-session.ts
export interface EditorHost; export type LeaveGuard; export function EditorHostProvider({ value, children? }): JSX.Element; export { editorRegionLabel }   // editor-context.tsx
export function EditorPanel({ host }); export function editorRegionLabel(host): string; export function sessionKey(session): number; export function clampPanelWidth(width, viewport?, left?): number; export function maxPanelWidth(viewport?, left?): number; export function minPanelWidth(viewport?): number; export function panelWidthFor(share, viewport?, left?): number; export function storedPanelShare(): number; export function viewportWidth(): number; export function rowElement(id, doc?): HTMLElement | null; export function focusList(host, doc?): boolean; export function focusPanel(panel): boolean; export function markEditorOpen(): void; export function measureEditorReady(): void; PANEL_OPEN_CLASS, PANEL_RESIZING_CLASS, PANEL_WIDTH_PREFERENCE, PANEL_DEFAULT_SHARE, PANEL_MIN_WIDTH, PANEL_MAX_SHARE, LIST_MIN_WIDTH, PANEL_DRAWER_BELOW, PANEL_KEY_STEP, EDITED_ROW_ATTRIBUTE, EDITOR_OPEN_MARK, EDITOR_READY_MEASURE   // editor-panel.tsx
export function createSessionStore(): SessionStore; export function EditorMount(props: EditorMountProps)   // list/products-screen.tsx
export function buildInlineForm(fields, tab, items, settings, options?): Form; export function columnsOfTab(fields, tab): ProductField[][]; export function columnOf(field): 1 | 2 | 3   // form-layouts.ts: the General tab in three columns (COLUMN_OF_GROUP / COLUMN_OF_FIELD, WooCommerce's quick-edit order), other tabs short controls left and textareas right; DataForm `row` layout of `regular` columns of labelled `regular` groups
export function mergeItems(items: ProductListItem[], fields: ProductField[]): { data: Record<string, unknown>; mixed: Record<string, { isMixed: boolean; isEmpty: boolean; placeholder: string }> }          // merge.ts
export function visibleEditFields(fields: ProductField[], items: ProductListItem[], options: { mode: 'quick' | 'bulk'; applyToVariations: boolean }): ProductField[]   // visibility.ts
export type NumericOp = { operation: 'dont_change' | 'set' | 'increase' | 'decrease' | 'regular_minus'; value: string; percent?: boolean; round?: '00' | '90' | '95' | '99' | 'w9' | 'w49' | 'w99' | 'w0'; roundMode?: 'nearest' | 'up' | 'down' }   // regular_minus: only for sale-price-leaf fields; percent = percent of the regular price; round: price point applied in integer minor units after a relative money op (never for 'set'): cent endings '00' '90' '95' '99' for two-decimal currencies except kronor-style ones (SEK, NOK, DKK, ISK…), whole-unit points 'w9' (…9), 'w49' (…49/…99), 'w99' (…99), 'w0' (nearest 10) for every currency; roundMode (default 'nearest', a tie goes up) picks the direction (roundToPricePoint)
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
export interface SaveOptions extends RowEditOptions { batchId?: string /* the History batch the save joins (staged language tools run after it under the same id) */; applyToVariations: boolean; source: 'quick' | 'bulk'; fields?: string[]; onProgress?(done: number, total: number): void; prefetchedVariations?: ReadonlyMap<number, ProductListItem[]> }   // RowEditOptions = { enableManageStock?: boolean; skipExistingSales?: boolean } (row-rules.ts)
export interface SaveResult extends BatchResult { unchanged: number; stockSkipped: number; saleSkipped: number; notLowerSkipped?: number; replacedSales: number; skippedItems?: PlanSkip[] }   // PlanSkip = { id; reason: 'no_stock_management' | 'has_sale' | 'other'; fields: string[] /* edit keys dropped */; message? }
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
export function createDateTimeControl(settings): ComponentType<DataFormControlProps>   // datetime-control.tsx; datetime-local in site wall-clock time (min 1970-01-01T00:00, max 9999-12-31T23:59), emits Y-m-d\TH:i:s; an input the browser flags (validity.badInput) or a year that does not parse emits 'invalid-date:<raw>', which saleScheduleProblems() (sale-schedule.ts) and the field's isValid.custom turn into a blocking error while the schedule is on
export function useEditState(items: ProductListItem[], fields: ProductField[], resetKey: string): { data; edits; setField(id, value); reset(); isDirty; hasInput }   // use-edit-state.ts; edits are dropped when resetKey (the selection) changes
```

Round 8 edit rules. `date_modified_gmt` is in `EDIT_BASE_FIELDS`: every hydrated row has a baseline, and before a bulk save with relative price ops (`hasLoadRelativeOps`, stock excluded: stock goes as `inventory_delta`) the rows are re-read (`hydrateSelection(ids, ['id','status','date_modified_gmt'])`); rows saved by someone else since the editor loaded them (`changedSinceLoaded()`, variable parents included via WooCommerce's deferred variation sync) are reloaded with their variations and listed, and nothing is written until Update is pressed again. Language tools in the editor are staged, not run: their button adds the run to Update ("Also saved with Update"), they count as unsaved changes and appear on the Update button; on Update the field edits are saved first, then the staged tools run in the order added under the same `X-WC-Products-List-Batch` id (`SaveOptions.batchId`, `runDeclarativeAction(..., { batchId, silent })`): one History batch, one snackbar, one Undo. A tool's `array` arg (fields) only offers options whose `applies` (`{product: bool | types[], variation: bool}`, kept by `Registry::options()`) matches at least one item (`optionAppliesTo()`); when none applies the button is disabled with the reason. The History revert confirm runs the dry-run check (`checkRevertPlan()`, one `checkRevert` per chunk when the plan has more than one) and says before Revert how many items changed since the batch (left as they are), how many an earlier revert already put back, and one `describeConflict()` example.


Bulk save details: products go out in `products/batch` requests side by side (`runConcurrently`, `concurrency` default 3), cut so every slot has work (100 rows → 34 + 34 + 32); variations in lanes of whole parents (`packVariationLanes`). A partial failure always names the failed items and the reason in a snackbar that stays until dismissed and links to History (`links.history?batch=…`). A declarative action with a non-null `group` and a select arg with id `lang` (gds-woo-i18n's `i18n_copy`, `i18n_clear`) is hosted inline in the editor's `<group>:<lang>` tab (language-tools.tsx, hosted-actions.ts) and removed from the row action menu whenever an editor is available. `toolTabIds(settings, items)` (form-layouts.ts) keeps a `<group>:<lang>` tab for the tools even when the selection has no editable field of that language (bulk: names, slugs, SEO title and SEO description are not bulk fields, `BULK_UNSUPPORTED_EXTENSION_LEAVES`; one SEO text on many products goes through the tools' templates); in bulk the tools panel starts unfolded. Variation quick edit focuses the regular price first. The editor's lazy chunk sits in an `ErrorBoundary` (context `editor`) whose fallback offers Reload (a chunk error) or Try again, plus Cancel (closes the panel). A declarative text cell whose value object (the path minus its last segment) carries `referenceLabel` uses it as the cell title, and `untranslated: [{id, taxonomy, name, edit_link}]` adds an "untranslated term" tag linking to the term (gds-woo-i18n variation names). The editor reports a running save through `EditorHost.setBusy(busy)`; while busy the screen never closes it (an emptied selection, a refetched list).

### `resources/history/`

```ts
export function runRevert(batchId: string, plan: Pick<RevertPlan, 'chunk' | 'chunks'>, options?: { ids?: number[]; force?: boolean; relative?: boolean; revertBatchId?: string; onProgress?(done, total) }, post?: typeof revertBatch): Promise<RevertOutcome>
export function describeConflict(result: ActionResult, label?: (key) => string): string   // "Pelsi Black 37-38: Stock quantity 10 → 9 kept" (value the batch left → value now); used by History and the Undo snackbar
export function relativeConflicts(conflicts: ActionResult[]): ActionResult[]   // the ones the server marks `relative`   // revert.ts; one POST per chunk (plan.chunks, or `ids` cut to plan.chunk) under one revert batch id; RevertOutcome = { revertBatchId, ok, conflicts: ActionResult[], failed: ActionResult[], skipped }
export function revertWholeBatch(batchId: string, options?): Promise<RevertOutcome & { plan: RevertPlan }>   // getRevertPlan then runRevert; what the editor's Undo uses (conflicts are reported, never forced)
export function scopeFromPlan(plan): BatchScope; export function describeBatchScope(scope): string   // batch-scope.ts; the Revert confirm's scope line from GET /log/batch/{id}; `skipped` entries named, failed changes counted apart ("1 failed change, nothing to revert.")
export function createBatchFields(settings, { users?, fieldOptions?, formatTime }): Field<LogBatch>[]; export function batchQueryFromView(view): BatchQuery; export function describeBatchObjects(batch): string; export function describeBatchChanges(batch, fieldOptions): string   // batch-fields.tsx; the Batches landing view
export function useLogBatches(query, { enabled? }): { items: LogBatch[]; total; totalPages; isLoading; isFetching; error?; refetch() }   // use-log.ts; cache key `log:batches:<json>` (dropped by invalidateLog())
export function formatLogValue(field: string, value: string | null, settings): string   // log-fields.tsx; prices in the shop format, `i18n.<lang>.*_price` in the language's currency (settings.languages.currencies), sale dates in the site format
```

`<HistoryScreen fields={ProductField[]} />` lands on Batches (one row per batch: field labels via `logFieldOptions()`, "on 348 variations of 5 products", failures, "Reverted by <user> at <time>" or "Revert of <id>") unless the URL carries `object_id`, `batch` or `view=changes`; "Show changes" switches to All changes filtered by the batch. The Field column shows and filters by registry labels ("Deutsch: SEO title"), Item ID shows the bare id, the batch filter takes an id prefix, and an empty filtered list says "No changes match these filters." with a Reset button. A batch already reverted warns in the confirm and its button reads "Revert again". The History "Revert batch" modal loads the plan, posts the chunks behind a progress bar, and when any object comes back `conflict` keeps the modal open with "N put back. M items were changed again after this batch (field labels) and were left as they are:" plus one `describeConflict()` line per item, a destructive "Revert M anyway" that re-posts those ids with `force: true` under the same revert batch id, and, when some conflicts are `relative`, "Subtract the change instead" that re-posts those with `relative: true`. Before the revert the confirm previews the first 5 revertable changes of the batch (name: field label, value the batch set → value it goes back to) and the plan's `left_out` count. The "already reverted" warning is not shown for the revert just run in the same modal. A status `skipped` row shows its message in the Result column. The confirm is a small DataViews action modal, not an edit form. The Change column of a `duplicate` row links to the copy (`LogRow.related`), or says the copy no longer exists.

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
3. `App` builds fields (`createProductFields`) once per settings and registry version (`useRegistryVersion()`: a `registerField` after mount re-derives them), renders `list/products-screen.tsx` or, lazily (`build/history.js`), `history/history-screen.tsx` by `?screen=`. The editor is `build/edit.js`, loaded on the first Quick/Bulk edit (`edit/editor-panel.tsx` mounts it into the slide-in panel, which is in the main bundle).

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
| `wcProductsList.actionPerformed` | `{ action, ids, batchId, items }` — a declarative (server) action finished; `ids` are the rows it processed without error, `items` the refreshed rows it returned. The products store marks `ids` edited (`markEdited`); the selection keeps them. |

## 9. Speed budgets (completion criteria)

List page (100 rows, `_fields` trimmed) < 1 s server time; expanding 100 variations < 1 s; 100-row bulk save < 5 s with progress; every mutation optimistic (`patchItems` before the request, rolled back on error); no page reloads; `build/index.js` ≤ 2 MB minified (currently 1.92 MB, 380 KB gzipped; lazy-load `edit/` before raising). Measured with `SCRIPT_DEBUG` off and Query Monitor inactive (README, "Measuring").

Rendering rules that keep the budgets: table rows are memoised by `patches/@wordpress__dataviews@20.0.0.patch` (docs/dataviews-patch.md): a row re-renders only when its item, the fields, the view, the actions or its own selected state change, so a checkbox toggle re-renders one row and a 100-row save re-renders 100 rows, not the page; everything handed to DataViews must therefore be referentially stable across renders (`getItemId`, `isItemClickable`, `actions`, `fields`, the item objects themselves: patch rows into new objects, never mutate). Cell renders are memoised too (`field()` in `fields/helpers.ts` wraps `render` in `memo`; `fieldFromDeclarative` too); the children store publishes load progress through one coalesced emit per `EMIT_WINDOW` (40 ms); while a bulk load runs (Expand all, Expand next, a restored expansion) loaded parents are committed in slices of about `BULK_PUBLISH_ROWS` (50) rows, one per macrotask, so no commit is a long task and the request limiter's slots are refilled between commits; the counter next to "Expand all" reads `useExpandAllProgress()` (`{done, total}` from a store of its own) so progress never re-renders the table; user gestures emit at once; variation loads are abortable (see §11) and run `MAX_CONCURRENT_REQUESTS` (6) at a time.

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

**Hook API** (`Hierarchy`, returned by `useHierarchy(parents, fields, options?)`): `rows`, `expandedItemIds`, `onChangeExpandedItemIds`, `isExpanded(id)`, `toggle(id)`, `expand(id)` (resolves when loaded), `collapse(id)`, `retry(id)`, `expandAll({ force? })` → `Promise<boolean>` (false when the user declined the > `EXPAND_ALL_WARN_ROWS` (400) rows confirm or nothing fits under `EXPAND_ALL_MAX_ROWS` (600)), `collapseAll()`, `getItemParentId`, `getItemHasChildren`, `getItemLevel`, `childrenOf(id)`, `childrenState`, `variationIdsOf(parentIds)` (loaded children or `_fields=id` fetch, `MAX_CONCURRENT_REQUESTS` in flight, cached per parent), `selectVariations(parentId, currentSelection, where?)` → new selection ids (expands first: DataViews drops selected ids that are not in `data`; `where(variation)` keeps only the matching ones, e.g. the out-of-stock). Options: `fetchVariations` (defaults to `api/client` `getVariations`; receives `params` when a variation filter is on), `maxChildren` (`limits.maxChildrenPerParent`), `confirmExpandAll(rows, plan)` (asked when the page would pass `EXPAND_ALL_WARN_ROWS` or when some products would stay collapsed; `plan` is `{ expanding, skipped, rows, maxRows }` and `expandAllConfirmMessage(plan)` words it: "Expands 17 of 100 products (about 595 rows on one page); 83 stay collapsed…"), `onExpandAllLimit`, `storage`, `variationFilter: { key, params }`. `expansionSummary(parents, expandedIds)` → `{ expanded, total }` feeds the persistent "17 of 100 expanded" next to Expand all.

**Variation-level filters**: `api/query.ts variationFilterParams(view, fields)` → `{ params, pending, key }` turns the filters that are about variations into variations-endpoint params: "Variation stock" (`variation_stock`, wins) or the product "Stock" filter → `stock_status`; "Attribute: X" → `attributes[][attribute]=pa_x&attributes[][terms][]=<slug>` (wc/v3 matches the variation's `attribute_pa_x` meta; slugs come from the terms the filter loaded, `fields/terms.ts termSlugs`; `pending` lists taxonomies whose slugs are not loaded yet, `list/variation-filter.ts` loads them and builds again); an extension field's `rest.toVariationParams(value, operator)`. The screen passes it as `variationFilter`; every load applies it (`setVariationFilter`, module level; a new key invalidates the loaded variations so expanded parents refetch), the loaded state is marked `filtered: true`, and the parent's name cell says "3 of 15 variations match · Show all" (`showAllVariations(id)` lifts the filter for that parent, "Only matching" / `showMatchingVariations(id)` restores it). `selectVariations` (the "Select all variations" action) selects the matching variations only; `variationIdsOf` (apply to every variation) never reads filtered rows. With a variation filter on, the toolbar offers "Select matching variations": Expand all (within its limits), then every loaded variation is added to the selection (`list/products-screen.tsx selectMatchingVariations`). A variation row's checkbox is named "<parent name> — <variation>" (`withVariationTitles` wraps the title field's `getValue`, which DataViews reads for the checkbox label). Module helpers: `abortLoad(parentId)`, `abortLoads()`, `loadingParentIds()`.

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

A patch or removal that arrives while a parent's load is in flight (a first expand of a parent with more than 100 variations, or the refetch after `invalidateVariations`) is recorded on that load and replayed, in order, on the rows the load brings back before they are published, like the query cache's `pendingPatches`: a save that lands during a refetch never shows the pre-save value, and a deleted variation never comes back.

**Placeholder rows**: `id = -parentId`, `_kind: 'variation'`, `_level: 1`, `_parentId`, `_placeholder: 'loading' | 'error' | 'more'`, `_placeholderMessage`; `getItemId` → `"<parentId>:<kind>"`.

**Rows that left the filter**: every id the user wrote (`markEdited`: the `updated` rows of `wcProductsList.saved`, the `ids` of `wcProductsList.actionPerformed`; never a plain `patchItems` merge such as an editor's hydration, a rollback or a parent's refreshed price range) is remembered until the list query (filter, search, page, tab) changes. A refetch of the same query that no longer returns such a product row puts it back at its old position with `_noLongerMatches: true` (a "No longer matches" badge in the name cell) and counts it in `total` (`store/products.ts retainEditedRows`). `stripMeta` drops the flag.

**Variation SKU search**: while `view.search` is set the list asks for `sku`; parents whose own name/SKU do not contain every token matched through a variation, and up to `MAX_SEARCH_EXPANDS` (10) of them are expanded once per search and page. Variation rows whose SKU contains such a token get the `is-search-match` class and a "Matches search" badge (`HierarchyViewValue.searchMatchIds`); the first is scrolled into view without moving focus (`hierarchy/search-match.ts useSearchReveal`).

**Error boundaries**: `ui/error-boundary.tsx` `ErrorBoundary({ context, fallback?, onRetry? })` logs `[wc-products-list] <context>` with `console.error` and shows an inline notice: "Reload the page" for a `ChunkLoadError` (`isChunkLoadError`), "Try again" otherwise. The app wraps the Catalog, the table and the History chunk; `createProductFields` wraps every non-core cell `render` with `guardCell` (a throw shows "—" in that cell only).

**Persistence**: `sessionStorage['wcProductsList.expanded']` = JSON array of parent ids; ids not on the current page are kept so paging back restores them, bounded per page as described in §7 (`EXPAND_ALL_MAX_ROWS`; `EXPAND_ALL_WARN_ROWS` right after a reload). `expandAll` expands in page order only as many parents as keep the page under `EXPAND_ALL_MAX_ROWS` and calls `onExpandAllLimit({ expanded, skipped, rows })` (default: an info notice) when it skipped some; it resolves false when the user declined the warning or nothing fit.

## Round 9 integration

- `Saves::preInsert` refuses, in list mode, a product or variation whose `categories`, `tags` or `brands` list has an entry that is not `{id: <positive int>}`: the item fails with `wc_products_list_invalid_term` (`data.field` names the list) and its terms stay as they were. The client's `termsField` `rest.write` also drops every token that is not a positive integer id. In list mode `brands: []` clears `product_brand` (WooCommerce's own handler ignores an empty list): `Saves::clearBrands()` empties the terms before the Recorder completes, so one `brands` log row (`[{id}] → []`) is written and a revert puts the brand back; items without brands are skipped.
- The editor passes `applyToVariations` and `parentVariations` (the loaded variations of the selected variable parents) to `<LanguageTools>`. Staged tools resolve their ids with `stagedToolIds(entry, rows, parentVariations)`, so "Adjust market prices" runs on the variations of variable parents; after such a run the fetched variations are forgotten and fetched again. On a language tab the variation fetch also asks for that language's `regular_price` / `sale_price` rest fields, so the price preview covers the reached variations.

## Round 9 list and hierarchy

- **First paint.** `AdminPage::render()` prints a static skeleton inside `#wc-products-list-root` (the "Catalog" h1, a tab strip, toolbar placeholders and `AdminPage::SKELETON_ROWS` grey rows, inline CSS, `aria-busy`); `createRoot()` replaces it when the app mounts. Next to it an inline script (`AdminPage::prefetchScript()`) reads `localStorage['wc-products-list:prefetch'][location.search]` (the GET paths the app stored on an earlier load of the same admin URL: the first list request and the counts, `api/prefetch.ts recordBootRequest`; at most `PREFETCH_MAX_PATHS` paths, `PREFETCH_MAX_ENTRIES` query strings kept, only `/wc/v3/…` and `/wc-products-list/v1/…` paths) and fetches them at once with the REST nonce, the list-mode header and `_locale=user` into `window.wcProductsListPrefetch[path]` (`Promise<{ ok, status, headers: { total, totalPages }, data }>`). `api/client.ts` `list()` and `getCounts()` take a prefetched response for the exact path they are about to request (`takePrefetched`, once, within `PREFETCH_MAX_AGE` = 60 s of navigation; a failed one falls back to a normal request), so the first rows no longer wait for the bundle. A first visit fetches nothing.
- **Expand next.** When Expand all stopped at `EXPAND_ALL_MAX_ROWS`, the toolbar shows "51 of 100 expanded" and "Expand next 49" (`Hierarchy.nextExpand: { count, replaces } | null`, `Hierarchy.expandNext()`, `nextExpansion(parents, expandedIds, children, maxChildren, rowsNow, maxRows)`): the collapsed variable products after the last expanded one (then those before it) that fit; when none fit on top of the open ones, the page's open ones collapse first (`replaces`; selected variations stay selected, and the screen asks the editor's leave guard first when the edited variation's parent would collapse).
- **"Select all variations" keeps the row limit.** `selectVariations(parentIds, …)` expands only the parents that keep the page under `EXPAND_ALL_MAX_ROWS` (`parentsWithinRows`), loads the variations of the others too (across parents) and selects them collapsed, with an info notice ("49 products stay collapsed so the page stays under 600 rows; their variations are selected all the same"). `useSelection` resolves selected ids the page does not show through `options.lookupRow` (default `findLoadedVariation(id)`, every loaded variation by DataViews id), so they stay in the selection and count as "not in this view".
- **Row renders.** `HierarchyViewProvider` also publishes its value as a store; `NameCell` and `Chevron` read it through `useHierarchyRowView(id)` (per-row `useSyncExternalStore` subscriptions: this parent expanded, its `ChildrenState`, a search match, the variation filter flag) and call the callbacks through `useHierarchyViewGetter()` at event time, so expanding a parent or a slice of Expand all landing re-renders the cells of the rows that changed, not every name cell. `useHierarchyView()` (the whole value, re-rendering on every change) remains for other consumers. `patchVariationRows` keeps a row object when a patch changes nothing (`isNoopPatch`), so the rows a save hands over twice (patchItems, then the `saved` action) re-render once. The DataViews patch also memoises the primary column and the row actions, and mounts a row's actions menu on first use (docs/dataviews-patch.md).


## Round 10 translation editing

- **Bootstrap `languages`** (gds-woo-i18n `wc_products_list/settings`) also carries `chains: {lang: string[]}` (each other language's fallback chain, `{de: ['de', 'en']}`), `routes: {preview, terms, term}` (REST paths; `term` has an `{id}` placeholder) and `machineTranslate: bool` (the `i18n_machine_translate` action is offered because something hooks `gds_woo_i18n/machine_translate`). Typed in `LanguageSettings` (resources/types/settings.ts).
- **Row text values** in `row.i18n[lang][field]` may carry `shownLabel` ("Shown now (English fallback)") next to `effective` / `effectiveLang`, and `machine: true` for a machine-translated draft that still needs review. The quick-edit reference line reads `<shownLabel>: <effective> · Default: <source>` (`ProductField.shownReference`).
- **`i18n_transform`** has an operation `set` ("Set to the same text", no tokens), and its `own_name` arg defaults to true ("Skip products without their own name in this language").
- **Template preview from the server.** `POST settings.languages.routes.preview` `{ids: number[] (≤ 100), args}` (the `i18n_transform` args as the tool sends them) is a dry run: `{items: [{id, parent_id, name, name_source?: {lang, label, own, value}, fields: {field: {old, new, status: change|unchanged|skipped|error, reason?, message?}}} | {id, error: gone|forbidden, message}], summary: {items, change, unchanged, skipped, error, name_sources}, message: string|null}`; 400 for invalid args, 403 without `edit_products`. The language tool asks it (`edit/server-preview.tsx`, `useServerPreview`, 350 ms debounce, the first 100 ids, a newer setting aborts the request) for `template`, `set`, `prefix`, `suffix` and `replace` when the route exists, and shows its message, counts and the first five changed / skipped / failing values with the language each `{name}` comes from, instead of the client-side estimate (which stays as the fallback and while the first answer is on its way).
- **Translate product by product.** A bulk edit's language tab starts with a folded "Translate product by product (<language>)" grid (`edit/translation-grid.tsx`): one row per selected product (variations are left out: their names come from the parent), an input for `i18n:<lang>.name` and a textarea for `i18n:<lang>.short_description`, the shop's current fallback text as placeholder and reference ("Suomi: …"), "Only products missing a translation", 100 rows at a time. Unfolding it loads `i18n.<lang>.name` / `i18n.<lang>.short_description` for the products (`hydrateSelection`, one request per 100). Enter moves down the column, Shift+Enter up (a new line in the textarea). A short description that is only paragraphs and line breaks is edited as text and stored in the same shape (`htmlToGridText` / `gridTextToHtml`), other HTML is edited as HTML. Typed values live in the editor's `TranslationStore` (inputs are uncontrolled, a tab switch keeps them) and count as language changes ("Update 3 products + 2 language changes", the discard confirm, the Update button). Update saves them after the field edits and the staged tools, in the same History batch: `buildPayload` per product from the registry fields, `products/batch` in chunks of `limits.batchSize`, three at a time, rows patched from the response; a failed product keeps its typed text for the next Update.
- The other gds-woo-i18n routes the app does not call yet: `GET routes.terms?ids[]=&lang=&all=` (attribute terms of a selection with `{id, taxonomy, taxonomy_label, name, value, shown, items, rest, edit_link}`), `PUT routes.term` `{translations: {lang: {name}}}`, and the `gds_woo_i18n/machine_translate` filter (`(null, text, source, lang, format, product, field) => string|null|WP_Error`).
