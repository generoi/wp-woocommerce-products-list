# WooCommerce Products List

A fast product catalog for the WooCommerce admin, built on `@wordpress/dataviews` 20. Variations expand inline under their parents. Quick edit and bulk edit work in place in the table, like the classic list's quick edit, with no modal and no page reload. That includes scheduled sales across all variations of the selected variable products. Every change made through the list is logged and can be reverted. Extensions add columns, filters, quick-edit tabs and actions from PHP alone, or from JavaScript through `window.wcProductsList`.

Requires WordPress 6.8+ (developed on 7.1), WooCommerce 11.0+ (developed on 11.1) and PHP 8.2+. The plugin adds **Products → Catalog** and leaves the classic list untouched.

## Features

- **List.** Status tabs with counts, search by name or SKU, filters (type, status, stock, categories, tags, brands, attributes, price, "any variation out of stock"), sorting (including SKU, stock and menu order), 20/50/100 per page, table/grid/list layouts. The view is saved in the user's preferences; page, search, filters and tab are mirrored to the URL.
- **Hierarchy.** A chevron expands a variable product's variations under it (paginated, 100 per request). The expansion survives paging, search and reload (sessionStorage). A SKU search that matches a variation expands its parent and marks the row. Expand all / Collapse all are in the toolbar, with a confirm and a row cap. "Select all variations" and "Select out-of-stock variations" are row actions. Parent rows summarise their variations ("4 of 16 variations out of stock", "Scheduled · 12 variations").
- **Quick edit.** The editor replaces the row in place. Tabs: General (three columns) plus one tab per extension group, such as one per language. Enter updates, Shift+Enter updates and opens the next row, Escape cancels (asking first when there are unsaved changes), and focus returns to the row.
- **Bulk edit.** Alt+B or the Bulk edit button opens an editor row at the top of the table. The selected items are listed on the left (x removes one) and the fields on the right. WooCommerce's visibility rules apply: SKU is never bulk-edited, parent-owned fields drop out when variations are selected, and sellable fields drop out for variable parents unless **Apply price and sale fields to all variations** is ticked. Mixed values show as "Mixed" / "— Mixed (no change) —" / indeterminate checkboxes. Prices and stock take Set / Increase / Decrease (amount or %), with rounding (for example to ,90) and a worked old → new example. Money is computed in integer minor units with half-up rounding; relative stock changes are applied on the server, so a sale placed meanwhile is not overwritten.
- **Scheduled sales.** Sale price as "Regular price minus %" plus from/to dates in site time, on simple products and on all variations of the selected variable products in one save. Before saving, the editor warns about rows already on a running sale (Replace or Skip) and about sales that would be higher than today's price; sale ≥ regular is blocked per item.
- **Saves.** Optimistic row updates. Variations are saved first through one cross-parent batch route, then products in parallel chunks, with progress, per-item errors (the editor stays open with Retry), rollback of failed rows and a snackbar summary with Undo.
- **Actions.** Duplicate, publish / move to draft, feature, trash (with Undo), restore, delete permanently (Trash only), enable/disable variations, row History.
- **Change log and revert.** Every field change made through the list is one log row (who, when, object, field, old → new, batch, source, outcome). The History screen groups rows into batches ("Sale price on 220 variations of 5 products") with "Show changes" and filters by user, field, item, source and time. **Revert batch** puts the old values back, skips values changed since unless you confirm, and is itself logged as a batch.
- **Extension API.** Declarative PHP fields, filters and actions, and a JS API with `wp.hooks` filters. See [docs/extension-api.md](docs/extension-api.md) and [examples/extension-demo.js](examples/extension-demo.js). The gds-woo-i18n integration (per-language columns, quick-edit tabs, "Missing in …" filters, copy/clear/find-and-replace/market-price tools) is built on it.

## Install

The package is on GitHub, not Packagist. In the site's `composer.json`:

```json
{
  "repositories": [
    { "type": "vcs", "url": "https://github.com/generoi/wp-woocommerce-products-list" }
  ],
  "require": {
    "generoi/wp-woocommerce-products-list": "^0.1.0"
  }
}
```

```sh
composer update generoi/wp-woocommerce-products-list
wp plugin activate wp-woocommerce-products-list
```

`build/` is committed, so a Composer install needs no Node. Activation creates the `{prefix}wc_products_list_log` table and schedules the daily prune.

## Usage

Open **Products → Catalog** (`edit.php?post_type=product&page=wc-products-list`).

- Tick rows (Shift-click selects a range; the selection survives paging and search) and press **Bulk edit**.
- For a campaign on variable products: filter by brand or category, select the parents, open Bulk edit, tick **Apply price and sale fields to all variations**, set Sale price "Regular price minus %" and the schedule, check the summary, press **Update**.
- **History** in the toolbar opens the log (`&screen=history`). `&object_id=<id>` scopes it to one product, `&batch=<uuid>` to one save.

## Capabilities

The Catalog screen and the plugin's REST routes need `edit_products` (shop managers and administrators have it; the `wc_products_list/capability` filter changes it). Saves go through WooCommerce's `wc/v3` endpoints, which have requirements of their own:

- Quick edit of one product: `POST /wc/v3/products/{id}` needs `edit_post` on that product.
- Bulk edit and every multi-row save: `POST /wc/v3/products/batch` and `/wc-products-list/v1/variations/batch` need **`edit_others_products`** (WooCommerce's rule for batch writes). The settings payload exposes it as `caps.editOthers`.
- Actions (`/wc-products-list/v1/actions/{action}`) check `delete_post` / `edit_post` / `publish_post` per id, plus `manage_woocommerce` for duplicate.
- History and revert need `edit_others_products`.

A role with `edit_products` but not `edit_others_products` can browse and quick-edit its own products, but cannot bulk edit.

### Personal data and retention

Every log row stores who made the change (`user_id`) and, in its `context` column, the request's IP address and user agent. The REST API never returns `context`. Rows are pruned after 180 days by a daily cron (`wc_products_list/log_retention_days`). Mention the log in the site's privacy policy if the store has several editors.

## Speed

Budgets (completion criteria, [docs/contracts.md](docs/contracts.md) §9): list page < 1 s, expanding 100 variations < 1 s, 100-row bulk save < 5 s, optimistic UI, no reloads.

Measured on the widetoes ddev site (855 products, 24k variations, no persistent object cache):

| Operation | Measured |
| --- | --- |
| List, 100 per page, in-process | 307–452 ms, ~111–119 queries (plain wc/v3 without the list header: 388–1175 ms, 208–213 queries) |
| List, 100 per page, browser TTFB | 420–560 ms warm; first request of a cold PHP-FPM worker up to 1.6 s |
| Expand 100 variations | 244–367 ms, ~76–80 queries |
| 100-row bulk save (menu order +1) | 2.8 s from Enter to snackbar (three parallel batch requests, 1.0–1.5 s each) |
| Scheduled sale on 125–220 variations | 2.2–4.3 s |
| Revert of a 100-row batch | 3–4.5 s |

Measure on a production-like build: `SCRIPT_DEBUG` off (Bedrock's development environment turns it on, which loads the development builds of React and makes rendering several times slower) and Query Monitor deactivated (its backtraces double REST timings).

`build/index.js` is 2.2 MB minified (≈440 KB gzipped); `edit.js` and `history.js` are lazy chunks. Most of it is the `@wordpress/components` copy that dataviews 20's `/wp` entry inlines. CI fails above 2,306,867 bytes.

## Develop

```sh
composer install
pnpm install          # node 22, pnpm 11; applies patches/ to @wordpress/dataviews
pnpm start            # watch build
pnpm build            # commit build/ with the sources

composer lint && composer stan && composer test      # pint, phpstan level 5, PHPUnit unit suite
pnpm lint:js && pnpm lint:types && pnpm test         # eslint, tsc, vitest
```

Integration tests boot WordPress and WooCommerce. With wp-env: `pnpm env:start && pnpm test:php`. On a Bedrock site under DDEV (test DB `wp_tests`, config in `tests/wp-tests-config.php`):

```sh
ddev exec -d /var/www/html/web/app/plugins/wp-woocommerce-products-list \
  env WP_PHPUNIT__TESTS_CONFIG=tests/wp-tests-config.php \
  vendor/bin/phpunit --bootstrap tests/bootstrap.php --testsuite integration
```

CI runs the static checks, the JS suite, a rebuild with `git diff --exit-code build/` and the size budget.

Further reading:

- [docs/contracts.md](docs/contracts.md): headers, PHP hooks, REST routes, logging rules, bootstrap payload, JS boundaries.
- [docs/hierarchy-upstream.md](docs/hierarchy-upstream.md): the hierarchy mirrors the prop names of gutenberg#83316 (`getItemParentId`, `getItemHasChildren`, `expandedItemIds`, `onChangeExpandedItemIds`) and explains how to switch once upstream ships it ([gutenberg#80360](https://github.com/WordPress/gutenberg/issues/80360)).
- [docs/dataviews-patch.md](docs/dataviews-patch.md): the one patch applied to dataviews 20 (row re-render).

## Known gaps

- No row virtualisation: Expand all on a 100-per-page view is capped at about 1,500 rows and takes several seconds to render; selecting or collapsing at that size blocks the tab noticeably.
- The first list request of a cold PHP-FPM worker can take 1.6–1.9 s (not profiled yet).
- Translation work for names and short descriptions is form-based (quick edit, staged bulk tools); there is no spreadsheet-style per-language grid, no per-language image alt text and no per-language local attribute values.
- Whole-krona price points (…9 / …99 kr) are not a rounding option; the market-price "Default" hint does not recompute from an unsaved EUR edit.
- Back/Forward do not step through in-app URL state (it uses `replaceState`).
- The SKU-owner error names the owning product by id without a link.
- The bundle is over the plan's original 1.5 MB target (see Speed).
- `languages/` has no `.pot` yet.

## License

MIT
