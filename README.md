# WooCommerce Products List

A fast product catalog for the WooCommerce admin, built on `@wordpress/dataviews` 20. Variations expand inline under their parents. Quick edit and bulk edit open in a slide-in panel beside the list, like WooCommerce's DataViews product editor, so the list, your place in it and the ticked rows stay in view; no modal and no page reload. That includes scheduled sales across all variations of the selected variable products. Every change made through the list is logged and can be reverted. Extensions add columns, filters, quick-edit tabs and actions from PHP alone, or from JavaScript through `window.wcProductsList`.

Requires WordPress 6.8+ (developed on 7.1), WooCommerce 11.0+ (developed on 11.1) and PHP 8.2+. The plugin adds **Products → Catalog** and leaves the classic list untouched.

## Features

- **List.** Status tabs with counts, search by name or SKU, filters (type, status, stock, categories, tags, brands, attributes, price, "any variation out of stock"), sorting (including SKU, stock and menu order), 20/50/100 per page, table/grid/list layouts. The view is saved in the user's preferences; page, search, filters and tab are mirrored to the URL.
- **Hierarchy.** A chevron expands a variable product's variations under it (paginated, 100 per request). The expansion survives paging, search and reload (sessionStorage). A SKU search that matches a variation expands its parent and marks the row. Expand all / Collapse all are in the toolbar, with a confirm and a row cap. "Select all variations" and "Select out-of-stock variations" are row actions. Parent rows summarise their variations ("4 of 16 variations out of stock", "Scheduled · 12 variations").
- **Editor panel.** Quick edit and bulk edit open in a panel on the right; the list narrows and stays usable (scroll, tick, expand, page, filter), and below 960 px the panel lies over it as a drawer. It opens at about half the window, so the form's column groups sit side by side; drag its left edge (or use the arrow keys on it) to resize it between 480 px and 75 % of the window (the list always keeps some room); the share of the window is remembered. Its right edge is the window's at any width, and below 960 px it covers the window. F6 moves focus between the list and the panel, Escape or the X closes it.
- **Quick edit.** A pencil on every row opens it (also in the ⋮ menu). Short and long descriptions (and their translations) edit as formatted text with Bold, Italic, lists and links, or as HTML in the Code view; nothing is rewritten unless edited. The edited row is highlighted in the list while the panel edits it. Tabs: General (its column groups stack or sit side by side as the panel width allows) plus one tab per extension group, such as one per language. Enter updates, Shift+Enter updates and opens the next row, Escape cancels (asking first when there are unsaved changes), and focus returns to the row. Quick edit on another row switches the panel to it (asking first when there are unsaved changes).
- **Bulk edit.** Alt+B or the Bulk edit button opens the panel on the selection. The selected items are listed in a collapsible section at the top (x removes one) above the fields, and ticking or unticking rows in the list updates the panel until the first save. WooCommerce's visibility rules apply: SKU is never bulk-edited, parent-owned fields drop out when variations are selected, and sellable fields drop out for variable parents unless **Apply price and sale fields to all variations** is ticked. Mixed values show as "Mixed" / "— Mixed (no change) —" / indeterminate checkboxes. Prices and stock take Set / Increase / Decrease (amount or %), with rounding (for example to ,90) and a worked old → new example. Money is computed in integer minor units with half-up rounding; relative stock changes are applied on the server, so a sale placed meanwhile is not overwritten.
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
    "generoi/wp-woocommerce-products-list": "^0.1.1"
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

## History modes (POC)

The change log (`{prefix}wc_products_list_log`) is the History and Undo of the app, and stays the default. A proof of concept records native WordPress revisions next to it, switched by a constant in `wp-config.php` (`config/application.php` on Bedrock):

```php
define('WC_PRODUCTS_LIST_HISTORY', 'both'); // log (default) | both | revisions
```

- `log` or unset: as before; the revisions module is not loaded.
- `both`: the log as before, plus a revision for every product and variation save from any path (the list, wc/v3, the classic editor, imports, WP-CLI) under the same batch id. Compare them with `wp wc-products-list history compare --batch=<uuid>`.
- `revisions`: revisions only; undo is `wp wc-products-list history undo <uuid>` (History's screen still reads the log).

`backfill` writes baselines ahead of a campaign, `purge` removes the revisions and batch terms again (in every mode). `both` roughly doubles save time and storage per campaign, so do not enable it on a client store without a retention plan. Design, every core/WooCommerce extension and the measured cost: [docs/revisions.md](docs/revisions.md).

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

Measured on the widetoes ddev site (855 products, 24k variations, no persistent object cache). Server numbers are in-process or Resource Timing TTFB on an otherwise idle machine unless noted; client numbers come from a background Chrome tab with the development React build, so they are upper bounds.

| Operation | Measured |
| --- | --- |
| List, 100 per page, in-process | 260–452 ms, ~111–121 queries (plain wc/v3 without the list header: 388–1175 ms, 208–213 queries) |
| List, 100 per page, browser TTFB | 370–750 ms warm; counts 37–206 ms |
| Skeleton (first paint) | about 1 s; the list request is prefetched before the bundle runs (default view only) |
| Expand 100 variations (cross-parent route) | 244–504 ms, ~76–113 queries |
| Expand all, 100 per page (5 cross-parent requests) | network done in about 1.7 s; about 600 rows rendered in 4–8 s |
| Quick edit open | 86–340 ms (398 ms with about 555 rows on the page) |
| Bulk edit open, 100 rows | 148–416 ms; current values loaded in 0.9–2 s |
| 100-row bulk save (menu order +1, featured) | 2.8–3.3 s from Update to panel closed (three parallel batch requests) |
| Scheduled sale on 125–220 variations | 2.2–4.3 s |
| Revert of a 100-row batch | 3–4.5 s |

With four audit sessions sharing the same ddev host (load average 20–100) the list TTFB rose to 1–5.6 s and a 100-row save to about 11.5 s; those runs are not comparable with the budgets and an idle re-measure in a foreground tab is still open (see Known gaps).

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

- [docs/contracts.md](docs/contracts.md): headers, PHP hooks, REST routes, logging rules, concurrent edits (§3.6), bootstrap payload, JS boundaries.
- [docs/revisions.md](docs/revisions.md): the native-revisions POC (History modes) and every core/WooCommerce extension it adds.
- [docs/hierarchy-upstream.md](docs/hierarchy-upstream.md): the hierarchy mirrors the prop names of gutenberg#83316 (`getItemParentId`, `getItemHasChildren`, `expandedItemIds`, `onChangeExpandedItemIds`) and explains how to switch once upstream ships it ([gutenberg#80360](https://github.com/WordPress/gutenberg/issues/80360)).
- [docs/dataviews-patch.md](docs/dataviews-patch.md): the one patch applied to dataviews 20 (row re-render).

## Known gaps

- Speed under concurrency: with several editors saving at once the list request and 100-row saves exceeded the budgets in the last audit round. Client timings have only been measured in background tabs. A foreground, idle-host re-measure and CI timing gates are the next step.
- No row virtualisation: Expand all on a 100-per-page view expands as many parents as fit in about 600 rows, and rendering that takes several seconds; selecting or collapsing at that size blocks the tab noticeably.
- Only the default view's list request is prefetched; deep links with search or filters wait for the bundle.
- Per-row variation summaries cost 226–437 ms of a list request on a loaded host, and batch writes compute them once per item.
- History reverts whole batches only (no single-change revert) and is a separate page load.
- Translations: the per-product grid lives in bulk edit's language tabs (name and short description; no SEO columns, short descriptions with markup show as HTML). There is no inline per-language editing in the list itself, no EUR → SEK/NOK/DKK conversion, no attribute-term translation UI, no per-language image alt text and no per-language local attribute values.
- Whole-krona price points (…9 / …99 kr) are not a rounding option.
- Back/Forward do not step through in-app URL state (it uses `replaceState`).
- No uninstall cleanup or privacy exporter/eraser for the log.
- The bundle is over the plan's original 1.5 MB target (see Speed).
- `languages/` has no `.pot` yet.

The full list of open findings from the last audit round is tracked as a GitHub follow-up issue.

## Audit

The plugin was audited in ten rounds by six personas each (three store managers running real weekly price, stock, campaign and translation work in the browser, and senior PHP, JS/TS and WordPress/WooCommerce reviewers). In round 10 four of six signed off: the operations lead, the PHP/REST reviewer, the JS/TS reviewer and the WordPress/WooCommerce reviewer (data correctness verified against the database in every scenario, every revert exact). The two store managers who did not sign off cited speed measured on a heavily loaded shared host and translation work that is still mostly form-based.

## License

MIT
