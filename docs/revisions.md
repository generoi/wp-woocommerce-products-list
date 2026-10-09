# Native revisions next to the change log (proof of concept)

This is a proof of concept. The custom change log (`src/Log/*`, `LogController`, the History screen) is unchanged and stays the default. Native WordPress revisions can be recorded next to it, so the two can be compared on the same edits.

## Switching modes

Set the constant in `wp-config.php` (or `config/application.php` on Bedrock):

```php
define('WC_PRODUCTS_LIST_HISTORY', 'both');
```

| Value | What happens |
|---|---|
| unset or `log` | Today's behaviour. `src/History/` is not loaded and no hook is added. |
| `both` | The log records as today. Revisions are also recorded for every product and variation save, from any path (the list, wc/v3, the classic editor, CSV import, WP-CLI, plain CRUD). Saves made by the app use the same batch id in both. |
| `revisions` | Only revisions are recorded. The log recorder is quiet (`src/Rest/Saves.php`, the three `History::logs()` checks). The History screen still reads the log, so it shows nothing new; undo of a revisions batch is `wp wc-products-list history undo`. Porting the History screen is not part of the POC. |

Retention is 50 revisions per product and 20 per variation. Change it with the `wc_products_list/history_options` filter (`keep_product`, `keep_variation`). Retention is counted per object against every save of it that takes a revision, not per batch: a variation edited 20 more times after a campaign has lost the campaign's revision. Stock changes from orders take no revision (extension 9), so checkout no longer pushes campaigns out; edits still do. `history undo` says how many of a batch's revisions were pruned (extension 13).

`history_options` also takes `variation_text` (default `false`): whether a variation's description and its translations are revisioned (extension 11).

## Comparing the two

In `both` mode, take the batch id from the History screen, or from `X-WC-Products-List-Batch` in the browser's network tab, and run:

```sh
wp wc-products-list history compare --batch=<uuid> [--limit=50] [--format=json]
```

The command prints:
- the batch term (source, user, time, changed fields);
- a summary of the objects. `match` means the log's fields and the keys that changed between a revision and its predecessor are the same. Prices and stock values are compared too;
- for the log: rows, bytes, read time, and the time and result of the revert check;
- for revisions: revision count, meta rows, bytes, read-and-diff time, and a dry run of the undo (would restore, conflicts, skipped);
- a table with one row per object: the log's keys, the revisions' keys, and the status.

Other commands, available in `both` and `revisions` modes:
- `wp wc-products-list history undo <uuid> [--dry-run] [--force]` undoes a batch from revisions, through WooCommerce CRUD. The undo is itself a batch, so undoing the undo redoes.
- `wp wc-products-list history backfill` writes a baseline revision for every product and variation that has none. Run it before a campaign, so the campaign does not pay for baselines.
- `wp wc-products-list history purge [--keep-baselines] [--chunk=<n>] [--yes]` deletes the revisions of every product and variation (through `wp_delete_post_revision()`, meta and batch relationships included) and every `wcpl_batch` term with its term meta, in chunks. It is available in every mode, `log` included, so a site switched back can clean up. `--keep-baselines` keeps the revisions that belong to no batch.

## What core does, and what we added

Core already provides:
- the `revisions` post type support;
- meta registered with `revisions_enabled`, which core copies into each revision (`wp_save_revisioned_meta_fields`);
- the meta change check (`wp_check_revisioned_meta_fields_have_changed`);
- `wp_save_post_revision()`, with pruning by `wp_revisions_to_keep`;
- the Restore button, `wp_restore_post_revision()`, with its meta copy back.

All of these are used as they are. Each extension below says what core does, why that falls short for WooCommerce products, and the smallest hook we added. Line numbers refer to `src/History/`.

### 1. Revisions support and revisioned meta (core API, no workaround)

- **Core:** products and variations do not support `revisions`. WooCommerce registers the post types without it, and registers no meta.
- **Added:** `Revisions::registerMeta()` (Revisions.php:88). It calls `add_post_type_support($type, 'revisions')` and `register_post_meta($type, $key, ['revisions_enabled' => true])` for the keys the editor can change:
  - prices and sale dates, SKU and GTIN;
  - stock fields, weight and dimensions;
  - tax, image and gallery, virtual and downloadable;
  - upsells and cross-sells, default attributes;
  - on variations, `_variation_description` and `attribute_pa_*` for every global attribute.
- **Gap:** a variation of a custom, product-level attribute stores `attribute_{name}`, which can't be listed ahead of time, so it is not revisioned. This is lighter than a per-post key filter. It's rarely edited.
- **Not revisioned:** derived keys such as `_price`, `total_sales`, `_wc_average_rating` and `_product_version`. WooCommerce computes them.

### 2. Translations (one filter, to move into gds-woo-i18n)

- **Core:** a plugin that wants its meta revisioned passes `revisions_enabled => true` to `register_post_meta`.
- **Added:** `Revisions::i18nArgs()` (Revisions.php:136). This is a `register_meta_args` filter that sets `revisions_enabled` for gds-woo-i18n's `_i18n_{field}_{lang}` keys on products and variations. It's a shim so the POC needs no change in gds-woo-i18n.
- **Lighter, for later:** add `'revisions_enabled' => true` to `Meta::args()` in gds-woo-i18n and delete the shim.

### 3. The revision is taken after WooCommerce's save (needed)

- **Core:** `wp_update_post` takes the revision on `post_updated` / `wp_after_insert_post`.
- **Why that falls short:** `WC_Product_Data_Store_CPT::update()` (class-wc-product-data-store-cpt.php:323–389) has two problems:
  - it only calls `wp_update_post` when a post field changes, so a price-only save takes no revision;
  - when it does call `wp_update_post`, it writes the meta afterwards (line 383), so the revision holds the previous meta.
- **Added:**
  - `beforeSave()` (Revisions.php:365) on `woocommerce_before_product_object_save` sets a per-id flag;
  - `toKeep()` (Revisions.php:178) on `wp_revisions_to_keep` returns 0 while the flag is set, so core's revision inside the save is skipped;
  - `afterSave()` (Revisions.php:397) on `woocommerce_after_product_object_save`, priority 99, clears the flag and calls core's `wp_save_post_revision()`.
- These hooks fire for products and variations, and for every path that saves through CRUD: REST, admin, import, CLI.
- `toKeep()` also sets the per-type retention.

### 4. Baseline (needed for undo of the first change)

- **Core:** the first revision is taken after the first save, so the state before it is lost.
- **Added:** `baseline()` (Revisions.php:451) calls core's `_wp_put_post_revision()` with the stored post when the object has no revision yet. It runs:
  - from `beforeSave()`, only when the save changes something;
  - from `prePostUpdate()` (Revisions.php:438) on `pre_post_update`, because the classic editor updates the post row before WooCommerce's meta box saves.
- A create takes no revision. The first change writes the created state as the baseline.
- `wp wc-products-list history backfill` writes baselines ahead of time.

### 5. Terms (needed: core does not revision taxonomies)

- **Core:** revisions do not record terms.
- **Why that matters for WooCommerce:** categories, tags, brands, the shipping class, and featured and catalog visibility (`product_visibility`) are all terms.
- **Added:**
  - `putRevision()` (Revisions.php:278) on `_wp_put_post_revision`, at 20 after core's meta copy at 10, stores the term ids as one `_wcpl_terms` revision meta row. It uses `add_metadata`, because `add_post_meta` on a revision writes to its parent;
  - `termsChanged()` (Revisions.php:309) on `wp_save_post_revision_post_has_changed`, at 20 after core's meta check, so a terms-only change still takes a revision.

### 6. Batches (needed for bulk undo; uses a core taxonomy)

- **Core:** has no grouping of revisions across posts.
- **Added:** `Batches.php`:
  - a private taxonomy `wcpl_batch` on `revision`, registered at Batches.php:50;
  - one term per batch: the app's batch id, or one per REST request, or one per process for admin, import and CLI;
  - term meta: source, user, time, `reverts` and the changed fields;
  - `assign()` uses core's `wp_set_object_terms()`.
- **Lighter for writes:** a direct `INSERT` into `term_relationships`, with the count updated once per request. It saves about 5 queries per revision. Kept on core's API for the POC.

### 7. Undo and the Restore button go through WooCommerce CRUD (needed)

- **Core:** `wp_restore_post_revision()` writes the post fields with `wp_update_post` and copies the revisioned meta back raw (`wp_restore_post_revision_meta`).
- **Why that falls short:** raw meta skips WooCommerce's derived data:
  - `_price`;
  - the variable parent's price range;
  - `wc_product_meta_lookup`;
  - transients;
  - the stock status terms.
- **Added:** `restored()` (Revisions.php:472) on `wp_restore_post_revision`, at priority 5. It runs before core's meta copy at 10, and sets the revision's values as WooCommerce props, then saves (`Restore::apply()`). Core's raw copy then writes the same values again, so it is left in place.
- `restored()` also deletes the revision core took during its own `wp_update_post`. That revision has the restored post fields but the old meta.
- **Lighter alternative:** keep that extra revision. It's harmless but confusing in the compare screen.
- **Batch undo** (`Restore::undo()`): for each object, it restores the predecessor of the batch's first revision. Only the keys that differ from the batch's last revision are written, through the same CRUD path. A key changed since the batch is a conflict: the object is left alone unless `--force` is given. The writes form a new batch with `reverts`, so undoing the undo redoes.

### 8. Not built: compare-screen fields

The plan calls for `_wp_post_revision_field_{key}` callbacks, so the product compare screen shows prices and terms. This is a small, separate step, and it's not needed to judge the data model.

### 9. Stock and rating saves take no revision (needed for checkout)

- **Core:** a revision is taken on every save that changes a revisioned key.
- **Why that falls short:** `wc_update_product_stock()` (every order line) writes `_stock` with SQL and then calls `$product->save()`; reviews save the rating. Each would take a revision and a batch term per frontend request: about 45 extra queries per order line, and a campaign's revisions pushed out of retention by sales.
- **Added:** `beforeSave()` skips the revision when the save changes nothing beyond `Revisions::DERIVED_ONLY` (stock quantity and status, date modified, total sales, rating counts) and is not in an explicit context (`explicitContext()`: the app, a REST write other than the Store API, a forced batch, WP-CLI, an import, the admin's screens). No revision means no batch term either.

### 10. REST saves: the revision is taken after the insert listeners (needed for brands)

- **Why:** WooCommerce Brands writes `brands` on `woocommerce_rest_insert_product_object` (priority 10), after the CRUD save, so a revision taken in `afterSave()` held the old brands.
- **Added:** `restSaving()` on `woocommerce_rest_pre_insert_{product,product_variation}_object` (last) marks the id; `afterSave()` then defers the revision to `restInserted()` on `woocommerce_rest_insert_*` at 30 (after Brands at 10 and the log at 20). `restDone()` on `rest_request_after_callbacks` (998) takes any revision whose insert hooks never ran. A brands-only change of an object that has no revision yet takes none (no baseline can be taken after the fact).

### 11. Variation text is not revisioned by default (storage)

- **Why:** a variation's description and its five translations are about 5.7 KB of a 6 KB revision; a full campaign was 221–346 MB, about 53 MB without them.
- **Added:** `metaKeys()` on core's `wp_post_revision_meta_keys` drops `_variation_description` and the `_i18n_*` keys for `product_variation` unless `history_options` `variation_text` is true. Product text stays revisioned.

### 12. Cleanup (needed before any client)

- **Empty batch terms:** `Batches::pruneEmpty()` runs with the daily log prune (`wc_products_list_prune_log`) and deletes `wcpl_batch` terms with no revisions left (pruned by retention), older than an hour, with their term meta.
- **Purge:** `History\Purge::run()` (the `purge` command above).
- **Uninstall:** `uninstall.php` (deleting the plugin in wp-admin, not deactivating) runs the purge, drops the change log table, deletes the running-batch markers and unschedules the prune. Composer removal on Bedrock does not run it.

### 13. Undo reports pruned revisions

- `Batches` keeps the number of revisions recorded under a batch in term meta `revisions` (written once per flush). `Restore::undo()` and `undoAll()` report `pruned` (recorded minus those still there); the CLI warns, and fails when nothing is left to undo, instead of "Success … total 0".

## What it costs (ddev, production copy: 865 products, 24,242 variations)

These numbers come from the Phase 0 benchmark, a sale price on every variation. The full report has the method and the raw numbers.

- **Correctness:** `compare` matched the log for all 24,242 objects of a campaign. There were 0 key mismatches, 0 value mismatches, and the undo dry run had 0 conflicts.
- **Queries per variation save:**

  | Mode | Queries |
  |---|---|
  | `log` | 45 |
  | `revisions` or `both`, first campaign (with baseline) | 100 |
  | `revisions` or `both`, later campaigns | 89–91 |

  The count did not grow over 11 campaigns.
- **Save time:** measured on the same 3,000 variations, back to back.

  | Mode | Time |
  |---|---|
  | `log` | 22–33 s |
  | `revisions` | 47 s |
  | `both` | 49–51 s |

  That is +40 % to +110 %.
- **Storage per full campaign:**

  | Setup | Storage |
  |---|---|
  | Log | about 10 MB |
  | Revisions, full key set, first campaign (with baseline) | about 346 MB |
  | Revisions, full key set, later campaigns | about 221 MB |

  Most of it is the variation description and its five translations: a revision carries about 5.7 KB of meta. Without those keys, a revision carries about 225 bytes of meta, and a campaign estimates at about 53 MB, measured on 5,000 variations.
- **Batch page of 100:** 80–100 ms, against 67–93 ms for the log.
- **Undo of 24,242 variations through CRUD:** 356 s, against a save of 309 s.

### Side effects and cost to know about

- **Yoast SEO** reacts to `wp_insert_post` for revisions too: two `wp_yoast_indexable` SELECTs per revision post, part of the extra queries per save in `both` mode. This is third-party behaviour; nothing in the POC asks for it.
- **Cost (audit, isolated clone):** `both` roughly doubles save time (2,000 variations 14.1 s → 27.9 s; full catalogue, 3 writers, 99 s → 186 s) and adds 207–326 MB of postmeta per campaign with variation text revisioned. Keep `log` as the default; never enable `both` on a client store without extension 11, a retention plan and the purge in place.

## Concurrency (all modes)

The save path is guarded server-side (docs/contracts.md §3.6): a MySQL named lock per object for the duration of one item's save, a fresh load under the lock when the batch's primed caches are stale, refusal of trashed rows, optional expected values per item (`_wcpl_expect`, 409 `wc_products_list_conflict`), one revert per batch at a time, and a running-batch marker that blocks History's plan, check and revert of a batch still being written. In `both` mode the revision of a refused item is not taken (nothing is saved).

## Tests

`tests/Integration/RevisionsSpikeTest.php` covers these edit paths:
- price-only, name and price, terms-only, translation-only;
- the classic `edit_post` save;
- wc/v3 single and batch;
- our cross-parent `variations/batch`;
- `WC_Product_CSV_Importer`;
- plain CRUD;
- conflicts, the Restore button and retention;
- the three modes.

Each test asserts:
- the newest revision equals the saved state, and there's no duplicate;
- the baseline exists and has no batch;
- the batch term is on the new revision;
- undo and redo leave `_price`, the parent's range and `wc_product_meta_lookup` right.
