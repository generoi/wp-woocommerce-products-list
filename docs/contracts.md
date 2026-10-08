# Contracts

The authoritative interfaces between the PHP side, the JS app and extensions. Builders of the individual modules code against this document; when a module needs something that is not here, add it here first.

Conventions: PHP namespace `GeneroWP\ProductsList`, text domain `wp-woocommerce-products-list`, hook prefix `wc_products_list/`, script and style handle `wc-products-list`, admin page `edit.php?post_type=product&page=wc-products-list`, own REST namespace `wc-products-list/v1`. JS lives in `resources/` (TypeScript, `@wordpress/dataviews` 20 imported only through `resources/dataviews.ts`). Ids of fields are the wc/v3 keys. Times in REST are site-local ISO strings with `_gmt` twins, as wc/v3 does. Money is a decimal string (`"189"`, `"12.50"`).

## 1. Request headers (list mode)

| Header | Sent | Meaning |
| --- | --- | --- |
| `X-WC-Products-List: 1` | every request from the app | `ListMode::active()` is true: wc/v3 rows are enriched, extra params mapped, writes logged. Other wc/v3 consumers see nothing. |
| `X-WC-Products-List-Batch: <id>` | every write (POST/PUT/DELETE) | `ListMode::batchId()`; `[A-Za-z0-9_-]{1,64}`, the app sends a UUID v4. One id per user gesture (one bulk save, one action on N rows), shared across the requests it takes. Groups log rows; `revert` works per batch. |

PHP: `ListMode::active(): bool`, `ListMode::batchId(): ?string`, `ListMode::force(?bool $active, ?string $batchId = null)` (tests/CLI; `force(null)` resets). Captured on `rest_request_before_callbacks` (priority 1), so it is per request, including batch sub-requests. Filter `wc_products_list/active` (bool) can override.

JS: `api/client.ts` installs an `apiFetch` middleware that adds both headers; the batch id comes from the caller (`batchId` option) or is generated per call.

## 2. PHP hooks

### Filters

| Hook | Signature | Where |
| --- | --- | --- |
| `wc_products_list/modules` | `(class-string<Module>[] $modules): class-string<Module>[]` | `Plugin::boot` |
| `wc_products_list/capability` | `(string $cap = 'edit_products'): string` | `Plugin::capability()`, menu + REST permission of own routes |
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
| `wc_products_list/log_retention_days` | `(int $days = 180): int` | `Log\Prune` |
| `wc_products_list/replace_legacy_screen` | `(bool $replace = false): bool` | `Modules\LegacyRedirect` |

### Actions

| Hook | Signature | Where |
| --- | --- | --- |
| `wc_products_list/activate` | `()` | `Plugin::activate()` (activation hook, and `tests/bootstrap.php`), after modules are registered. `Log\Table` installs here and on `init` when the stored version differs. |
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

`Plugin::MODULES = [Rest, AdminPage, Log, Actions, LegacyRedirect]`; `Plugin::getInstance()->module(Rest::class)` returns the instance. Constants: `Plugin::HANDLE`, `Plugin::PAGE`, `Plugin::REST_NAMESPACE`, `Plugin::TEXT_DOMAIN`, `Plugin::url()`, `Plugin::path()`, `Plugin::capability()`. `AdminPage::SCREEN = 'product_page_wc-products-list'`, `AdminPage::ROOT_ID = 'wc-products-list-root'`, `AdminPage::isScreen()`.

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
| `orderby=sku|stock_quantity|menu_order` | lookup-table join; core already does `id,title,date,modified,price,popularity,rating,include,slug` |

The app always sends `_fields` (union of visible fields' `rest.fields` + `id,type,status,parent_id,wc_products_list`), `image_size=thumbnail`, `per_page ≤ 100`, `search_name_or_sku` instead of `search`. Response headers `X-WP-Total`, `X-WP-TotalPages` are read.

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
  "items": [ /* refreshed wc/v3 rows of the ids that still exist, list-mode shape, with _fields from ?_fields */ ]
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

registered through `wc_products_list/action_handlers`. Every id gets one log row (`source=action`, `action=<id>`, `old_value`/`new_value` as the handler returns them in `data.changes` if any).

### 3.5 Log

`GET /wc-products-list/v1/log?object_id=&batch=&user=&field=&source=&action=&since=&until=&page=&per_page=` → `{"items": [LogRow], "total": n, "totalPages": n}` ordered newest first.

```ts
interface LogRow {
  id: number; batch_id: string; created_at: string /* ISO, site tz */; created_at_gmt: string;
  user: { id: number; name: string };
  source: 'quick' | 'bulk' | 'action' | 'extension' | 'revert';
  action: 'update' | 'trash' | 'restore' | 'delete' | 'duplicate' | string;
  object_type: 'product' | 'variation'; object_id: number; parent_id: number;
  object_name: string; edit_link: string | null;
  field: string; old_value: string | null; new_value: string | null;
  status: 'ok' | 'error'; message: string;
}
```

`GET /wc-products-list/v1/log/batches?page=&per_page=` → `{"items": [{batch_id, created_at, user, source, rows: n, objects: n, fields: string[], revertable: bool}], total, totalPages}`.

`POST /wc-products-list/v1/log/batch/{batch_id}/revert` → same shape as an action response (`results` per object), written as a new batch with `source=revert`. Only `update` rows revert; trash/delete/duplicate rows are reported as skipped.

Table `{prefix}wc_products_list_log`: `id BIGINT PK, batch_id VARCHAR(64), created_at DATETIME, user_id BIGINT, source VARCHAR(20), action VARCHAR(40), object_type VARCHAR(20), object_id BIGINT, parent_id BIGINT, field VARCHAR(100), old_value LONGTEXT NULL, new_value LONGTEXT NULL, status VARCHAR(10), message TEXT, context JSON/LONGTEXT`; indexes `batch_id`, `(object_id, created_at)`, `user_id`, `created_at`. Values are JSON-encoded when not scalar.

## 4. Logging rules (Rest\Saves + Log\Recorder)

In list mode, `woocommerce_rest_pre_insert_product_object` / `_variation_object` snapshot the current value of every key present in the request body (top-level wc/v3 keys, each `meta_data[].key`, each extension write path such as `i18n.se.name`) from the loaded product; `woocommerce_rest_insert_*` diffs against the saved product and writes one row per changed field (no row for no-ops), `source` from header `X-WC-Products-List-Source` (`quick|bulk|extension`, default `quick`), `batch_id` from the batch header (generated when missing). Batch endpoints fire the same hooks per item. Errors also go to `wc_get_logger()` source `wc-products-list`.

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
| `reference` | null | dot path to a read-only companion value shown beside the control (`i18n.se.name.source`) |
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

**Filter** (`DeclarativeFilter`): `id, label, type (select|text|boolean|number|date), param (string|null), options [{value, label, params {…}}], operators ['is'], isPrimary, multiple, variations (also sent on variation requests), order, source`. An option's `params` are merged into the query verbatim (`{"gds_i18n[lang]": "se", "gds_i18n[status]": "missing"}`); without `params`, `{[param]: value}`.

**Action** (`DeclarativeAction`): `id, label, description, icon (dashicon/wp icon name|null), scope (product|variation|both), supportsBulk true, isPrimary, destructive, confirm (string|null), capability (Caps key|null), group, order, args [{id, label, type (text|select|boolean|integer|number), required, default, options}], source`. The UI collects `args` in a modal when any exist, then `POST /actions/{id}`.

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
export function runAction(action: string, ids: number[], args?: Record<string, unknown>, options?: RequestOptions): Promise<ActionResponse>  // chunks of limits.actionBatchSize
export function getCounts(options?: RequestOptions): Promise<Record<string, number>>
export function getTerms(taxonomy: string, params?: { search?: string; include?: number[]; page?: number; perPage?: number }, options?: RequestOptions): Promise<ListResult<Term>>
export function getLog(params: LogQuery, options?: RequestOptions): Promise<ListResult<LogRow>>
export function getLogBatches(params?: { page?: number; perPage?: number }): Promise<ListResult<LogBatch>>
export function revertBatch(batchId: string, options?: RequestOptions): Promise<ActionResponse>
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
  patch<T>(key: string, updater: (data: T) => T): void
  invalidate(prefix: string): void          // drops entries, refetches subscribed ones
  subscribe(key: string, listener: () => void): () => void
}
export function createQueryCache(): QueryCache
export function useQuery<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, options?: { keepPreviousData?: boolean; enabled?: boolean }): { data: T | undefined; error: Error | undefined; isLoading: boolean; isFetching: boolean; refetch: () => Promise<T> }
export const cache: QueryCache   // the app singleton
```

Keys: `products:<json of query>`, `variations:<parentId>:<page>`, `counts`, `terms:<taxonomy>:<json>`, `log:<json>`.

### `resources/store/products.ts`

```ts
export function useProductList(view: View, tab: string, fields: ProductField[]): { items: ProductListItem[]; total: number; totalPages: number; isLoading: boolean; isFetching: boolean; error?: Error; refetch(): Promise<void> }
export function useCounts(): { counts: Record<string, number>; refetch(): Promise<void> }
export function patchItems(items: Array<Partial<ProductListItem> & { id: number }>): void   // into every cached list + variations page
export function removeItems(ids: number[]): void
export function invalidateProducts(options?: { counts?: boolean }): void
```

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
export function useHierarchy(parents: ProductRow[], fields: ProductField[]): {
  rows: ProductListItem[]; expandedItemIds: number[]; onChangeExpandedItemIds(ids: number[]): void;
  expand(id: number): Promise<void>; collapse(id: number): void; expandAll(): Promise<void>; collapseAll(): void;
  getItemParentId(item: ProductListItem): number | null; getItemHasChildren(item: ProductListItem): boolean;
  childrenOf(parentId: number): ChildrenState | undefined; variationIdsOf(parentIds: number[]): Promise<number[]>
}
// hierarchical-dataviews.tsx — DataViews plus the #83316 prop names
export function HierarchicalDataViews(props: DataViewsProps<ProductListItem> & { getItemParentId; getItemHasChildren; expandedItemIds; onChangeExpandedItemIds }): JSX.Element
// context.tsx
export function useHierarchyContext(): ReturnType<typeof useHierarchy>
```

`expandedItemIds` persist in `sessionStorage` key `wcProductsList.expanded`.

### `resources/edit/`

```ts
export function mergeItems(items: ProductListItem[], fields: ProductField[]): { data: Record<string, unknown>; mixed: Record<string, { isMixed: boolean; isEmpty: boolean; placeholder: string }> }          // merge.ts
export function visibleEditFields(fields: ProductField[], items: ProductListItem[], options: { mode: 'quick' | 'bulk'; applyToVariations: boolean }): ProductField[]   // visibility.ts
export type NumericOp = { operation: 'dont_change' | 'set' | 'increase' | 'decrease'; value: string; percent?: boolean }
export function applyNumericOp(current: string | number | null, op: NumericOp, kind: 'money' | 'integer', settings: Settings): string | null   // bulk-numeric.ts
export function validateBulkNumericEdits(items: ProductListItem[], edits: Record<string, unknown>, fields: ProductField[], settings: Settings): Array<{ id: number; field: string; message: string }>
export function buildPayload(item: ProductListItem, edits: Record<string, unknown>, fields: ProductField[], settings: Settings): Record<string, unknown>   // payload.ts; applies wcProductsList.savePayload
export function saveEdits(items: ProductListItem[], edits: Record<string, unknown>, fields: ProductField[], options: { applyToVariations: boolean; source: 'quick' | 'bulk'; onProgress?(done: number, total: number): void }): Promise<BatchResult>   // save.ts; variations first (per parent), then parents, one batchId
export function useEditState(items: ProductListItem[], fields: ProductField[]): { data; edits; setField(id, value); reset(); isDirty }   // use-edit-state.ts
```

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

1. `createExtensionApi()` → `window.wcProductsList`; `doAction('wcProductsList.ready', api)`.
2. `domReady` → mount `<App />` into `#wc-products-list-root`.
3. `App` builds fields (`createProductFields`) once per settings, renders `list/products-screen.tsx` or `history/history-screen.tsx` by `?screen=`.

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
| `wcProductsList.loaded` | `items, { tab, view, total }` |
| `wcProductsList.saved` | `result: BatchResult, { source }` |
| `wcProductsList.deleted` | `ids, { action: 'trash' | 'delete', batchId }` |

## 9. Speed budgets (completion criteria)

List page (100 rows, `_fields` trimmed) < 1 s server time; expanding 100 variations < 1 s; 100-row bulk save < 5 s with progress; every mutation optimistic (`patchItems` before the request, rolled back on error); no page reloads; `build/index.js` ≤ 2 MB minified (currently 1.92 MB, 380 KB gzipped; lazy-load `edit/` before raising).

## 10. Testing contracts

PHP integration tests extend `Tests\Integration\TestCase` (`actAs(role)`, `simpleProduct(props)`, `variableProduct(sizes, props)`) or `RestTestCase` (`request(method, route, params, headers)` adds the list-mode header and, on writes, a per-test batch id; `data(response)`, `assertStatus(code, response)`, `batchId()`). Run: `composer test` (unit), ddev/wp-env command in README (integration). JS: vitest, `tests/js/**/*.test.ts(x)`, jsdom, `sampleSettings()` in `tests/js/settings.test.ts` (move to `tests/js/fixtures.ts` when a second test needs it).
