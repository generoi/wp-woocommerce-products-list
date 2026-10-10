# Changelog

## 0.3.7 - 2026-10-10

Fixes for the side issues of the closeout verification on 0.3.6.

- The list's refresh of a variable product after its variations were saved no longer shows a product deleted meanwhile as a priceless Simple product. A parent that reads back half-deleted (WordPress removes its product type and other terms first) or not at all is checked until its deletion is over: gone, it leaves the list and a notice names it; still there, it is read again.
- An Undo (a revert in one request) lets go of its claim on the batch when it ends, and a revert in several requests when its batch is closed, so a History revert started right after is no longer refused as "already running". A revert chunk refused before it started (another revert or the save still running) records no failed rows.
- The variation pricing note ("Prices will change on N variations of M variable products") counts the variations whose price the edit changes, not every variation, once a price or sale edit is set.
- After the translation grid is refused on an item, the list's "Svenska: Name" cell drops a stale "copied" tag: a translated value read again replaces the cached one whole instead of merging into it.
- A staged language tool that wrote nothing ("Keep as is" on values already kept) is no longer reported as "1 language change applied"; with nothing else saved, Update says "Nothing changed".

## 0.3.6 - 2026-10-10

- Adjust market prices on a variable product in quick edit names the quick edit control ("Set the price of all its variations") instead of the bulk edit one ("Also apply to the variations").

## 0.3.5 - 2026-10-10

Fixes for the last three errors of the verification on 0.3.4.

- Bulk edit, "Adjust market prices": the preview warns when the new market regular price would be at or below the market sale price (the language's own or the converted one), for every selected item and the variations of selected variable products, as quick edit does. A language tab now loads its market prices in bulk edit too; a sale price that is not loaded is no longer taken for "no sale".
- A staged language tool refused on several items names each of them in the problem list and the snackbar, not only the first.
- The "Svenska: Name" fallback (the default-language name in italics) shows a name stored with "&amp;" (saved by a shop manager) as "&". Display only: stored and expected values are unchanged.
- A quick edit refused by WooCommerce (a duplicate SKU) writes one error row to the History log, not a second empty "SKU — → —" row.

## 0.3.4 - 2026-10-10

Fixes for the last errors of the final verification on 0.3.3.

- History names stock quantity "Quantity" everywhere, as its Field column: in the "changed again after this batch (…)" summary of a revert and in the Result text of the rows a revert left as they are (the stored messages are unchanged). The editor and Undo keep "Stock quantity".
- History shows names stored with "&amp;" (saved by a shop manager) as "&": the change column, the item column, the revert preview and conflict lines. The stored log values are unchanged.
- Quick edit: typing a name stored with "&amp;" back to the shown text (a character typed, then deleted) is no change ("Nothing changed"), not a dirty form that reports "1 item updated" while nothing is stored. The expected value is still the stored text.
- Bulk edit: a variable product deleted while the save writes its variations is checked until the deletion is over before it is read again. WordPress removes its terms, meta and variations before the product itself, so a read meanwhile found it still there: it was not named as deleted, and its emptied Categories, Tags and Brands showed as "changed by someone else".

## 0.3.3 - 2026-10-10

- Quick edit shows a product name stored with "&amp;" (saved by a user without unfiltered_html, such as a shop manager) as "&", like the product screen. The stored value stays the form value and the expected value until the user types, so nothing changes for saves or clash checks.

## 0.3.2 - 2026-10-10

Fixes for the leftovers of the final editor QA pass on 0.3.1.

- A row re-read after a refused save (the translation grid's conflict re-read, and the other re-reads merged over list rows) keeps its thumbnail-size image; the cross-parent variations read passes `image_size` on to wc/v3.
- Quick edit "Set the price of all its variations": the running-sales notice counts only the rows whose sale the update changes, not the rows that already have the resulting price.
- The "Adjust market prices" preview warns about a row whose market regular price would be at or below the sale price the shop shows there, which the run refuses.
- A whole-list selection with rows on other pages offers its bulk actions in the selection bar's "More actions" menu, judged on the whole selection (both "Mark as featured" and "Remove from featured" when both apply); the footer keeps Bulk edit.
- Conflict texts name stock quantity as the rest of the screen: "Stock quantity" in the editor (as its form field), "Quantity" in History (as its Field column).

## 0.3.1 - 2026-10-10

Fixes from three rounds of editor QA on 0.3.0 (quick edit of simple and variable products, bulk edit, translations, History and clash handling).

### Saving
- Turning "Schedule sale" off or clearing a sale date now clears the stored dates (WooCommerce skipped the `null` the editor sent; it now sends an empty string).
- A product name with "&" is no longer stored as "&amp;" when saved from the list, and the duplicate SKU message no longer shows the owner's name with HTML entities.
- A typed slug is cleaned with `sanitize_title()` (Polylang for WooCommerce stored it with spaces and capitals).
- Quick edit can clear the weight and the low stock threshold (it said "Nothing changed"), and accepts a negative menu order (it said "The quantity cannot be negative."); bulk "Change to" a negative menu order is no longer refused or clamped to 0.
- A save that turns Virtual on or stock management off asks back the fields WooCommerce clears with it, so the next edit does not call them someone else's change; Undo/revert puts the cleared shipping data back.
- Saved rows keep their thumbnail-size image, and a parent's "set the price of all its variations" no longer shows the parent's image on variations with their own.
- A sale end date typed without a time is stored as 23:59:59.
- A price operation whose result equals the stored price is no longer sent or counted.

### Quick and bulk edit
- Bulk edit no longer crashes when a stock notice's controls come or go (typing a relative stock value such as -5), or after a partial failure with a pending numeric operation.
- Bulk edit no longer says every field was changed by someone else after the selection changes; the first-shown value is kept per row.
- A whole-list selection's footer action (Mark as featured, Publish, Move to Trash …) reaches the other pages' rows, also when some rows on the page do not need it, and no longer keeps stale off-page rows.
- The change summary names categories, tags and brands instead of their ids, does not count non-price fields on the variations added for prices or plain values on rows that already hold them, and does not count fields that reach no row.
- Variable parents no longer make a shared price "Mixed" unless "Also apply to the variations" is ticked; shared prices use the shop's notation. The stock notice counts only rows a stock edit reaches. The existing-sales notice follows "Only where lower".
- A variable parent's "On sale" line is dated by the running sale, and leaves a side open when a variation has no start or end date. Changing only the dates of a variation's sale is not counted as replacing a sale; a scheduled sale is reported as "already have a sale".
- The save error notice stays in view above the sticky Update bar, focus moves to the new form after switching rows, and "Update & next" picks the right next row after expanding or collapsing.
- A sale time cleared segment by segment no longer keeps the "Enter a complete date" error.
- No empty "Also saved with Update:" heading when only the translation grid has changes.
- The trash confirm no longer says "0 of them are published"; Undo of a Trash on a product already restored no longer shows an error.

### Translations
- The translation grid reloads its texts after an Update, so a saved cell shows the saved value and the next edit of it is not refused as someone else's change; refused translations are named by product.
- A refused grid Apply re-reads the row; the list no longer keeps a refused text. Rows written by language tools stay in a "Missing in" list.
- Market price fields (SEK) use the shop's notation with the market currency and keep their "Default: …" hint; the Prices (SEK) group no longer shows the euro range. Language tools keep their typed settings when the tab is left.

### History and clashes
- Undo of turning a variation's stock management off puts the quantity back.
- History no longer counts an item as skipped after "Revert anyway" or "Subtract the change instead" wrote it, no longer marks a batch reverted when its revert put nothing back, and skips items an earlier revert already put back as unchanged instead of "changed by someone else".
- Revert stays available for a batch whose Undo left items changed since; the revert confirm lists only items it will write and keeps the dry-run scope after a pass. Long Changed lines are cut with an ellipsis; the Item ID filter chip has no thousands separator.
- Conflict texts show prices in the shop's notation.

## 0.3.0 - 2026-10-10

New layout for the quick and bulk edit panel, following WooCommerce's Edit product screen. It replaces the three equal columns (General, Organization, Pricing) that were hard to scan, repeated the Shipping heading and put the apply-to-variations box above the tabs.

### Layout
- One card per section. Main column: Product (name, slug, short description), Pricing, Buy button, Inventory, Description. Side column: Status and visibility, Organization (categories, tags, brands), then Shipping, Tax and Advanced, which start collapsed and stay in the side column in every quick and bulk edit.
- The form takes two columns from 720 px of its own width (it follows the form, not the window); narrower panels are one column in task order: Product, Pricing, Status and visibility, Organization, Inventory, Description, then the settings. Tab order follows what is on screen. The panel opens at least 880 px wide until its edge is dragged, so a 1280-1440 px laptop gets the side column.
- Fields where a manager expects them: SKU under Inventory, Virtual under Shipping, Downloadable under Advanced, Status beside Catalog visibility and Featured, and a single Shipping section. Paired fields sit side by side and stack when narrow (regular and sale price, sale dates, stock quantity and status, backorders and low stock threshold). WooCommerce wording: Stock status, Stock quantity, Allow backorders?
- The "apply to variations" checkbox leads the Pricing card (and a language's Prices card) instead of a box above the tabs, with a corrected plural ("Prices will change on 51 variations of 1 variable product").
- A collapsed card opens for a pending edit or a problem and shows " •" while it holds a pending edit; a field focused from the problem list opens its card first. Long texts show their first lines until focused and do not capture the mouse wheel.
- Language tabs are split into Translation, Prices (with the currency) and SEO cards and drop the language name from labels. The tab strip stays on one row, scrolls sideways when narrow and stays in view while the form scrolls. A language's "Default:" hint shows unsaved General text.
- The panel starts below a wrapped admin toolbar, a snackbar over a wide panel rises above the Update / Cancel footer, and sale times keep room for "hh.mm".

### Editing
- Quick edit of a variable product with "Set the price of all its variations" ticked offers the bulk price operations (regular price minus 20 %, `r-20%`, rounding), shows the variations' current regular price and how many are on sale, and runs the existing-sales choice, "only lower" and the change summary as bulk edit does.
- Bulk price operations: the operation select has its own row, rounding sits beside the value, and the note slot keeps its height, so typing "r-20%" moves nothing below.
- Stock: quick edit shows Stock quantity, Allow backorders? and Low stock threshold only with Manage stock ticked, and bulk edit does the same when no selected item manages stock. Stock status is not offered for variable products and is not sent to rows that manage stock (WooCommerce sets it from the quantity); before, the save reported success and nothing changed. Inventory explains why and offers "Set Stock quantity to 0" (which keeps focus and becomes its own Undo) or, for variable products, selecting their variations.
- No "Also apply to the variations" box when every variation of the selected variable product is selected too. Bulk edit opens on General (or the filtered language); quick edits still remember their tab. The bulk item list starts folded above 5 items, and a greyed-out Update says why.
- A variation's tax class stored as "parent" no longer raises a false "changed by someone else" notice after a save.

## 0.2.4 - 2026-10-10

- Translation grid: an edit typed back to its original keeps the value it was typed over, so a later keystroke cannot expect a value the input never showed and write over another user's change (f88dcbe).
- Translation grid: after a refusal, typing over the value the grid now shows (another user's save) and Retry saves, instead of being refused again; a reload that shows the stored value drops a stale base (dcf37ff).
- Audit close-out: the robustness, performance and front-end reviewers all signed off on the save, History and clash-prevention path.

## 0.2.3 - 2026-10-10

Clash-prevention fixes from audit rounds 11-13: the value a save sends as expected (`_wcpl_expect`, translation `expect`) is now always the one the form or grid showed the user, never one loaded after they started editing.

- Quick and bulk edit take each field's expected value from the rows as they were rendered when the user first changed that field (`resources/edit/shown-values.ts`, passed to the save as `expectBase`). Before, the expected value came from the editor's fresh load, so a price typed into a box still showing the list value could write over another user's change without a conflict. Only the stale-row warning's refresh and "Write my values over the other change" replace the remembered values, because both show the user the current ones.
- A path two fields share (sale price and regular price; stock status, quantity and manage stock; `meta_data`) is taken from the field the user changed first, if its snapshot carries it; a later snapshot only fills a path no earlier one had. `meta_data` is settled whole from the first snapshot that carries it, and a meta key shown absent is expected empty (`null`), so a value set meanwhile is refused (rounds 12-13).
- The price box shows a newer stored value straight away while focused, as long as the user has not typed; typed text is kept. The HTML editor updates its reference text the same way. The editor notes a field "changed by someone else since the list loaded, now X" (untouched) or "since you started editing it, now X" (edited; the save is then refused with 409).
- Fields whose value the rows do not have yet (non-column fields, descriptions, translations) are read-only until the editor's load lands.
- Translation grid: an edit keeps the expected value it started from until the edit is taken out; before, every keystroke replaced it with the stored value, so after folding and unfolding the grid a translation saved meanwhile was written over. Untouched cells show the reloaded value, and an edited cell whose stored value changed says so.
- History: `GET /log/batches` returns `skipped_fields`, so a batch where every item was refused reads "Regular price on 2 items, none written" instead of "— on 0 items". The revert dialog no longer counts items changed since the batch as put back, and disables Revert when nothing is left.
- gds-woo-i18n (site repo): when the term edit screen refuses the translations, core's "Item updated." becomes "Name and slug were saved; the translations were not (see the error above)."

## 0.2.2 - 2026-10-10

Clash-prevention fixes from audit rounds 8-10: attribute-term translations (gds-woo-i18n) are locked, clash-checked and logged; row actions write their History row from the change's own hook; a variation's tax class `parent` no longer fails validation or causes a false conflict.

- Quick and bulk edit of variations offer "Same as parent" for the tax class (stored as `parent`, every variation's default): a variation that was never given a class of its own no longer fails validation, and the list and the conflict text show it as "Same as parent". The clash guard and the log read a variation's tax class as stored (`parent`), not as the parent's class, so an unrelated edit is no longer a false conflict and a revert puts `parent` back.
- A refused list-mode write to a route that is not a product route (a term translation) is no longer also logged as product rows keyed by that route's `id`.
- Attribute-term translations are clash-checked and logged (audit round 8): gds-woo-i18n's term route (`PUT /gds-woo-i18n/v1/terms/{id}`) and the term edit screen take a per-term lock (`Concurrency::lockName('t', id)`), compare the loaded value (`expect`) with the stored one and refuse a clash with 409 `wc_products_list_conflict` naming the term, the field and its value now; every change and refusal is a History row. The log accepts `object_type` `term` (`Logger::OBJECT_TYPES`), action `translate_term` and source `i18n`; term rows are never reverted and never match a product's `object_id` filter (`GET /log` takes `object_type`). History names them "Translate attribute term" / "(attribute term)". docs/contracts.md §3.6.
- Row actions log a trash, restore, publish, draft or delete from the change's own hook (`Rest\EarlyRow`: first `transition_post_status` / `deleted_post` of the id, priority `PHP_INT_MIN`, `Logger::writeNow()`), and overwrite that row with the handler's row once it returns (`Logger::replace()`). A request killed during core's and WooCommerce's after-hooks (`trashed_post`, lookup tables, revisions, unlock) no longer leaves the change without its History row; only the time inside `wp_update_post()` / `wp_delete_post()` before those hooks remains (audit round 9).
- gds-woo-i18n (site repo): the term edit screen no longer refuses a save because another user changed a language this user did not touch; a language posted as it was loaded is not part of the write, and a refusal logs every change it refused.

## 0.2.1 - 2026-10-10

Clash-prevention and background-update fixes from audit rounds 5-7 of the 0.2.0 save and History path. Default `log` mode still measures within noise of 0.1.10 (round 7, isolated clone: full catalogue over HTTP 185 s vs 191 s mean at comparable load, 51.7 vs 46.5 queries per save on the CLI, the clash checks 3-6 % of a 100-row save; client long tasks during a foreground background save p50 65 ms, max 102 ms).

Final audit verdicts (round 7): **dev-performance happy** (no regression in rounds 5-7); **dev-robustness not happy** on two medium items: row actions logged only at the end of the request (fixed below, per id) and attribute-term translations not clash-checked (gds-woo-i18n's term route; documented, not fixed); **dev-js-ux not happy** on one medium item: a refused or uncertain row action turned a variable product into "Simple product" in the list (fixed below). The two fixes were covered by tests, not re-checked live by a further round.

- Clash prevention, round 5: a list save of a product the current user has open in the product editor in another tab is refused like another user's (their Update put the editor's values back over it); row actions other than Duplicate (including Restore, the Undo of a Trash) are refused while the product is open in the product editor (core's own Trash refuses that too), logged as skipped with reason `editing`; core's trash, restore and delete (wp-admin, WP-CLI) wait for a list save of the same row and the other way round, so a save can no longer publish a product trashed meanwhile or write meta for one deleted meanwhile. docs/contracts.md §3.6.
- A refused or uncertain row action, quick edit or bulk update no longer turns a variable product into "Simple product" in the list (no variations expander, no variation actions, until a reload). The rows read again after a conflict or an unknown outcome ask only for the changed fields; the type, name, parent and hierarchy keys the client filled in by default for that narrow read are no longer patched over the row (`withoutUnaskedIdentity()` in `resources/edit/hydrate.ts`, applied in `hydrateSelection()` and the status actions).
- Failed rows of the menu and footer actions are recorded too: status changes (Publish, Move to draft, Enable/Disable variations, Mark/Remove featured), Trash and its Undo, Restore, Duplicate, Delete, declarative tools, Undo and History reverts post the rows whose request got no answer (or that wc/v3 refused) to their History batch as failed, so an attempt that failed entirely, a one-request revert included, still shows in History. Their error notices offer "Select the N failed" and "View in History", as the editor's do.
- Failure notices of the row and footer actions (status changes, Mark/Remove featured, Move to Trash and its Undo, Restore, Duplicate, declarative tools) name the rows that failed and why, grouped by reason, the first three then "and N more" ("1 product was not moved to the Trash: Pelsi Black: Anna is editing this product in the product editor. …"; a refused Undo of a Trash says "1 product is still in the Trash: …" and links to the Trash tab instead of "Select"). Before, they gave the first failure's message only. "Select the N failed" keeps the notice up, selects only rows the list shows, and leaves the selection alone (with a note) when it shows none of them; before, it cleared the selection and the notice. Notice actions take `keepsNotice: true` for this (docs/extension-api.md).
- Quick and bulk edit after a clash: a row someone else changed meanwhile lists the value stored now next to the one the editor loaded ("Regular price 30 (was 12 when loaded)"), the form keeps your values and says so, and the retry button reads "Overwrite with my values" (bulk: "Apply the edits to the N changed items") and stays disabled until you tick "Write my values over the other change". Before, "Retry 1 failed" wrote over the other change without showing it.
- Attributes are clash-checked too: the server compares an expected `attributes` / `default_attributes` value in its stored form or as wc/v3 returns it, attribute by attribute (before, an attribute list matched on its ids alone), and the client sends the loaded list when an item writes them (`batchUpdate()`, registered fields). Failed rows of a row action are logged under that action (`POST /log/skipped` takes an optional `action`, a registered action id), so History shows a failed Trash as "Move to Trash". The fallback text of `wc_products_list_editing` no longer says "another user" (the server's message names who). docs/contracts.md §3.5, §3.6.
- Extension writes computed from the current value are built on a change made meanwhile: the list's concurrency guard now runs first on `woocommerce_rest_pre_insert_{product,product_variation}_object` (priority `PHP_INT_MIN`, `Saves::guardInsert()`), so resolvers that come after it, such as gds-woo-i18n's staged translation and market-price tools (`gds_i18n_ops`), read the stored value under the object lock. Before, a suffix added by a bulk tool could replace a translation another tab saved while the batch was waiting. docs/contracts.md §3.6, docs/extension-api.md.
- The editor loads descriptions and short descriptions as stored (wc/v3's `context=edit`) and sends that raw text as the expected value: a shortcode stays a shortcode when the description is edited (before, the rendered HTML could be written back in its place), and a shortcode with changing output is no longer a false conflict. In list mode, edit context answers a variation's description raw too, and `GET /wc-products-list/v1/variations` passes `context` (`view` or `edit`) on to wc/v3. The list's own columns keep the view context.
- `window.wcProductsList.batchUpdate()` now runs like a bulk save: progress bar, locked rows and the leave-page guard while it runs, the loaded values sent as `_wcpl_expect` (a row changed meanwhile is refused with `wc_products_list_conflict` and its current values, not overwritten; pass your own `_wcpl_expect` per item, or `{ expect: false }`), rows still being saved in the tab kept back, the batch marked running until done, failed rows recorded. Registered fields can supply expected values for their own storage with `rest.expect( item, payload )`. docs/extension-api.md.
- Row and footer actions (Trash, Delete, Restore, status, featured, extension actions) write each id's History rows as soon as that id is done, and sync each variable parent as soon as its last variation in the request is done (listed on the batch marker until then). A request killed or timed out part-way no longer leaves finished trashes or deletes without History rows and Undo, or a parent's price range stale.
- Documented (docs/contracts.md §3.6): gds-woo-i18n's attribute-term translation route (`PUT /gds-woo-i18n/v1/terms/{id}`) is not clash-checked or logged yet, with the contract it should adopt.

## 0.2.0 - 2026-10-09

Native-revisions proof of concept behind a constant, plus the fixes from a four-round audit of the save and History path (robustness, performance, clash prevention, the background-update indicator). The default `log` mode keeps the change log as the only history and measured equal to 0.1.10 within noise.

- **History modes (POC).** `WC_PRODUCTS_LIST_HISTORY` = `log` (default; `src/History/` is not loaded and no hook is added), `both` (the log plus a native revision for every product and variation save, from any path: the list, wc/v3, the classic editor, CSV import, WP-CLI, plain CRUD, under the same batch id) or `revisions` (revisions only; History's screen still reads the log). WP-CLI: `wp wc-products-list history compare --batch=<uuid>`, `undo <uuid> [--dry-run] [--force]`, `backfill` and `purge` (purge in every mode). Every core and WooCommerce extension the POC needs is listed with its reason in docs/revisions.md. `both` is not meant for a client store yet: it roughly doubles save time and adds about 200-330 MB of postmeta per full-catalogue campaign with variation text revisioned.
- **Clash prevention on the server.** Every list write (quick edit, bulk update, row action, History revert, the revisions undo) takes a MySQL named lock per object, re-reads the object under it, refuses rows in the Trash, deleted meanwhile or open in WooCommerce's product editor by another user, and compares the values the editor loaded (`_wcpl_expect`) with the stored ones. A clash is refused with a clear per-row message and logged as skipped; nothing is overwritten silently. Running batches are marked on the server, so History cannot revert an update still being written, and an update or revert cut short shows as "Interrupted: N of M written". See docs/contracts.md §3.6.
- **Background updates.** A list-level progress bar, rows locked for mouse and keyboard, a leave-page guard and durable outcome notices for bulk updates, reverts and multi-request row actions; failed and held-back rows are recorded in the History batch.
- **Measured (ddev, production copy: 865 products, 24,242 variations; shared host, so compare queries and back-to-back runs).** Default `log` mode vs 0.1.10: full catalogue over HTTP, 3 requests in flight, 172.5 s vs 167.9 s (+2.7 %, within noise); 2,000 variations 27.5-32.8 s vs 31.1-35.0 s; queries per save 51 vs 46 (the concurrency guard, 0.3-0.6 ms per item); read queries identical (list 20 = 41, list 100 = 115); History batch list 117-348 ms instead of 424-550 ms on a 104k-row log. `both` mode: about 2x the save time (full catalogue 340 s vs 172.5 s, 108-111 queries per save) and 13.4 revision meta rows per variation revision. No slowdown over a long save in either mode once the batch term is counted once per request.

- Edits of the checked fields can no longer overwrite each other. Every list write (quick edit, bulk update, History revert) takes a short server-side lock per product or variation, re-reads it before saving, and carries the values the editor loaded for the fields it changes (`_wcpl_expect`). A row changed meanwhile, in another tab, by another user, by an order or outside the app, is not saved: it is reported as "Changed by someone else since it was loaded…", shows its current values and is logged as skipped (reason conflict) in the batch. A row whose save is still running elsewhere is refused with "Another save of this item was running…", a row in the Trash with "This item is in the Trash…". Relative stock changes stay safe against orders as before (applied to the stored stock) and send no expected value. The checked fields are the core prices, sale dates, stock, status, SKU, product name, flags (manage stock, virtual, downloadable, sold individually, reviews), external URL and button text, slug, categories, tags, brands, dimensions, single-valued meta, and every translation and market price (`i18n.{lang}.{field}`, from the bulk and quick editors and the "Translate product by product" grid). Descriptions, short descriptions, images (the featured image), cost of goods and a variation's name are checked too: the editor sends them as the list loaded them and the server accepts that rendered form. A description with a shortcode whose output changes between two renders is reported as a conflict (nothing is saved; reload and apply again). Not checked (the last write still wins, under the lock; History's old value shows what was overwritten): attributes and extension fields other than translations. See docs/contracts.md §3.6.
- A bulk update of several requests is marked as running on the server until it is done. While it runs, History and Undo answer "This update is still running … Revert it when it is done." in every tab, and the batch list shows "Still running…"; an update that stopped half way (tab closed, connection lost) shows "Interrupted: N of M written", and the parents of the request that died are synced the next time it is read.
- Only one revert of a batch runs at a time: the chunks of one revert share its claim, a revert from another tab or user is refused until it is done.
- Rows whose write failed are logged as errors of the batch (POST /log/skipped reason `failed`), so History counts them as failed; they are never part of a revert.
- Brand changes are logged; clearing a sale by changing the regular price logs the sale fields it cleared; a killed request no longer leaves saved rows unlogged (log rows are written per item).
- History mode `both`/`revisions` (POC): order stock decrements take no revisions; `history undo` reports pruned revisions; new `wp wc-products-list history purge`; variation descriptions and translations are not revisioned unless `variation_text` is on; uninstall removes the plugin's data. A long bulk update in those modes no longer slows down as it goes: the batch term is counted once per request instead of once per revision (100 saves into a 24,000-revision batch: 1,069 ms of counting before, 61 ms now).
- History mode `both`/`revisions` (POC): undoing a batch no longer puts back stock sold since the object's last revision, or clears an edit made while History was in `log` mode: a save of an object that changed without a revision first takes a catch-up revision (no batch). Order stock changes take no revision on any route (wc/v3 orders from a POS or ERP, payment webhooks, admin order screens and refunds), only in the app, imports, WP-CLI and WooCommerce's product editing screens.
- A bulk save item whose product changed after the batch started now saves every value it asks for: a value equal to the batch's stale copy (but not to what another tab stored meanwhile) was dropped silently, and a relative stock change was added to the stale quantity.

- Rows locked by a background update are locked for every way in, not only the mouse: row actions (Mark as featured, Move to draft, Duplicate, Move to Trash, extension actions) are hidden on them and skip them when run from the footer or the selection ("Some selected rows are still being updated; they were left out."), and their checkbox, Quick edit and Actions buttons leave the keyboard's tab order. View, History and the expand/select-variations actions stay available. This is a guard for the current tab; other tabs and users are stopped on the server.
- Rows that fail in a bulk update are recorded in its History batch as "failed to save", with the error, next to the rows that saved. A background update that ends with failures offers "Select the N failed" in its snackbar, to reopen the editor on them and retry.
- The background update speaks less to screen readers: the list's progress bar announces the start and every 25 % instead of every second, and the "Updating…" mark on each row is plain text instead of a live region of its own (rows get `aria-busy`).
- The rows of a background update are locked, the progress bar shows and leaving the page asks first as soon as Update is pressed, including while the pre-save checks run ("Preparing the update…").
- Correction to 0.1.9: the rows of a background update stay locked until the whole update is done, not until their chunk is saved.
- Editing a variation's name no longer fails every time with "changed by someone else": the editor compared the attribute summary wc/v3 shows with the stored title.
- Rows a bulk update held back because someone else saved them meanwhile are recorded in its History batch ("Saved by someone else meanwhile; not updated", reason conflict). With the panel closed, the update's notice stays until dismissed and offers "Select the N held back" instead of reporting a plain success.
- Undo and History's revert show in the list like an update: the bar says "Reverting N of M rows…", the rows are locked and leaving the page asks first. An Undo whose rows a running update in the same tab still writes is refused with "N items of this batch are still being saved in this tab…" instead of splitting the update. A revert of several requests sends the planned header under its revert batch id and closes it at the end, and the server marks the revert batch as running until then: History shows a revert cut short as "Interrupted: N of M written", and a revert cannot itself be reverted while its chunks still run (docs/contracts.md §3.6).
- An Update with staged language tools keeps its History batch running until the tools are done too: the field save no longer closes the shared batch before the tools write under it, so History cannot plan or revert it, and no Undo is offered, while translation rows are still being added.
- Publish, Move to draft, Enable/Disable variations, Mark/Remove featured, Move to Trash and the extension (declarative) actions run as a bulk update does: the list's progress bar shows, the rows are locked and leaving the page asks first until every request is back; an action of several requests sends the planned header and closes its batch at the end, so History shows one cut short as "Interrupted: N of M written" instead of offering to revert half of it.
- Publish, Move to draft, Enable/Disable variations and Mark/Remove featured carry the loaded status or featured flag (`_wcpl_expect`): a row another tab or user changed meanwhile is refused instead of overwritten, shows its current value and is reported as "Changed by someone else since it was loaded…".
- A row deleted in another tab or by another user while a save or bulk update is running is no longer saved as an empty shell: it is reported as "Deleted meanwhile (another tab or user); nothing was saved for this item", leaves the list and is logged as skipped (reason deleted); the rest of the update carries on.
- Row actions (Delete, Trash, Restore, Publish/Draft, Feature, Duplicate, extension actions) wait for a save of the same row in another tab or by another user; one that waits too long is refused with "Another save of this item was still running … Try again in a moment." and logged as skipped (reason locked). History undo in `both`/`revisions` mode re-reads each object under the same lock, so a save made meanwhile is a conflict, not overwritten.
- Undo of a menu order change now puts a variation's menu order back to 0: WooCommerce's variations API ignores a 0, so the variations that had 0 before kept the new value while the notice said everything was put back (found in the round 3 smoke test: 14 of 203 variations). A bulk "change to 0" on variations works for the same reason.
- A request that fails among several (a network drop on request 2 of 3) no longer throws away the ones that went through. Those rows stay updated with Undo and "View in History"; only the failed request's rows are rolled back, after re-reading them when the outcome is unknown (a row that holds the new value counts as updated; one that cannot be read says it "may have been saved anyway"). The same holds for Move to Trash, declarative actions, Delete, Duplicate, Restore and the extension API's `batchUpdate`: per-row errors for the failed request's rows (`data.wcpl_request_failed`), the call only rejects when no request got an answer.
- A background update's notice of failed or held-back rows ("1889 updated, 195 failed … Select the 197 failed") is no longer replaced by the next save's notice or pushed out by later snackbars: each such notice has its own id (`wc-pl-outcome-{batch}`), and errors, notices that stay until dismissed and these outcomes neither count toward nor are dropped by the three-snackbar cap.
- An Undo or History revert that loses one of several requests now reports what it did: "N put back, M failed: …" (the lost request's rows say they may have been put back anyway when no answer came), and the list and History refresh. It only fails as a whole when no request got an answer.
- A row held back by a bulk update (saved by someone else meanwhile), or re-read while the update locked it, gets Quick edit, Trash, status and featured back in its row menu when the update ends: the list rebuilds its row actions whenever rows are locked or released (not on every progress step).
- A list save (quick edit, bulk update, History revert) of a product or variation another user has open in WooCommerce's product editor (core's post lock, `_edit_lock`, within its 150-second window; for a variation the parent's lock counts) is refused instead of written under them: it reads "<name> is editing this product in the product editor. Nothing was saved for this item…" and is logged as skipped (reason editing, History: "open in the product editor"). History undo in `both`/`revisions` mode skips such objects the same way. Row actions do not check the post lock yet (docs/contracts.md §3.6).
- A variations bulk update syncs each parent product (price range, stock status) right after its variations are written, through WooCommerce's own deferred product sync, and requests of one update that run side by side keep each other's list of parents to sync: a request that dies half way leaves at most one parent unsynced, and closing the batch syncs any parent still listed.
- History mode `both`/`revisions` (POC): a status-only or menu-order-only save now takes a revision (snapshot `_wcpl_post`) and undoes; parallel requests of one bulk update no longer create the batch term twice or lose each other's revision counts.

- History's batch list reads only the batches on the page: it picks the page's batch ids first and aggregates their rows, instead of aggregating the whole change log for every page (same response; 424-550 ms -> 117-348 ms on the 104k-row ddev log, and no longer growing with the log).
- Opening a large batch in History no longer stalls the site: its undo check runs three chunks at a time instead of all at once (a 24,231-variation batch fired 243 requests together, took every PHP worker for about a minute and held a storefront page for 54 s on ddev), and each chunk reads only its own log rows (about half the time per chunk on that batch).

## 0.1.10 - 2026-10-09

- Searching no longer opens products whose variations only match by name (an attribute value such as "Black x BREJD"). Only a search that matches a variation's SKU or barcode opens its product and scrolls to the variation. Searched rows carry `wc_products_list.variation_sku_match`.
- Checkbox ticks and the "some selected" dash are white and inset again instead of black and edge to edge on the blue box.
- The toolbar (count, selection, Columns, Expand all, History, Add new) sits beside the search box again, on one line that scrolls sideways instead of wrapping, so selecting a row never shifts the table.
- The Trash tab follows Draft instead of sitting at the far right.
- With the editor panel open the filter chips stay visible on one line that scrolls sideways when they do not fit.

## 0.1.9 - 2026-10-09

- "Decrease by" on Sale price (an amount or a percent) now starts from the regular price on rows that are not on sale, instead of skipping them. A running sale is still decreased from its sale price. "Increase by" on an empty sale price still skips the row.
- Bulk updates can run in the background: the editor panel can be closed while saving ("Close, keep updating in the background"). A progress bar above the list shows rows done, percent and time left, and rows not written yet show "Updating…" and are locked until their chunk is saved. Opening the editor on rows still being updated is refused. Leaving the page during an update asks first, since the update runs in the tab.
- Save progress in the panel is a full-width block with the count, percent and time left.
- "Apply to all variations" counts the variations as they load ("Loading variations… 9,800 of 24,225").
- Verified on the full catalog on ddev: 850 variable products, 24,231 variations, sale −20 %, saved in about 7 minutes with steady progress.

## 0.1.8 - 2026-10-09

- Quick and bulk edit remember the last tab used (for example Svenska) when switching to another product, opening bulk edit or reloading the page. A translation filter ("Missing in Svenska") and "Update & next" still choose the tab first.

## 0.1.7 - 2026-10-09

- History: the title and the Batches / All changes switch get the same inset as the list page instead of touching the card edge.

## 0.1.6 - 2026-10-09

- The toolbar group with the layout/settings buttons and the list header always takes the full width under the search box, so selecting a row no longer wraps it and shifts the table.

## 0.1.5 - 2026-10-09

- The list header (counts, selection, Columns, Expand all, History, Add new) always takes its own line, so ticking the first row no longer wraps it and pushes the table down under the pointer.
- Plugin header version matches the release again.

## 0.1.4 - 2026-10-09

- Side by side, the editor panel is a card like the list: the same 8px gap under the admin bar, the same border and 4px radius, the list's 15px right gutter and a 16px gap between them.
- While the panel is open the list hides the History / Add new links and the filter chips, so the narrowed list does not grow and jump as they wrap.

## 0.1.3 - 2026-10-09

- Browser errors from the app are reported to `POST /wc-products-list/v1/client-errors` and written to WooCommerce → Status → Logs under the source `wc-products-list-client`: render crashes (error boundary), uncaught errors and unhandled rejections from the bundle, and failed REST calls (5xx and network errors). Deduplicated, at most 25 per page load and 60 per user per 10 minutes.
- The page title lines up with the status tabs instead of touching the card edge.

## 0.1.2 - 2026-10-09

Demo polish for the split view, editor input and undo.

- Split view: while the editor panel is open the list hides date, type, categories, tags, brands and status and moves SKU, price and stock next to the name (capped at 240 px); translation columns stay and the rest scrolls sideways. Sort or column changes made in split view map back onto the saved view, and every column returns when the panel closes.
- Selection bar gets a "More actions" dropdown in split view with the other bulk actions for the selection; destructive actions (Move to Trash, Delete permanently, Delete variations permanently) are listed last, in red, under a separator, here as well as in row menus and the footer.
- Bulk save Undo snackbars (with "View in History") and Undo for status or declarative actions on more than one item stay until dismissed or replaced by a newer Undo; a quick save's Undo keeps the 10 s timeout.
- HTML fields open in Visual every time the editor opens; Code only lasts for the panel session where it was picked (the stored mode is gone). Entities such as `&nbsp;` round-trip unchanged.
- Sale dates are a date plus an optional time: no time means 00:00 for "from" and 23:59 for "to". A time without a date, or a half-typed date, is invalid and blocks Update.
- Bulk numeric fields show how a typed shorthand reads ("-5", "+10%", "r-20%" become e.g. "Reads as: Decrease by 5 €"). Plain Enter in a bulk numeric field no longer saves the whole bulk edit; Cmd/Ctrl+Enter or Update do.

## 0.1.1 - 2026-10-09

Changes since 0.1.0 (one feature commit, 3961c8c, plus this release commit).

- Bulk edit's language tabs have "Translate product by product": a spreadsheet of each selected product's name and short description in that language, with the text the shop shows now as reference, Enter to move down the column, and saving with Update in the same History batch.
- "Edit translated text" previews templates, set, prefix, suffix and find & replace from the server: tokens such as {name} and {brand} are resolved, and the preview says which products would take {name} from another language.
- Market price inputs on language tabs centre their currency sign.
- Quick edit and bulk edit open in a slide-in panel on the right of the Catalog instead of an editor row in the table: the list narrows beside it (a drawer over it below 960 px) and stays usable, the quick-edited row is highlighted, ticking or unticking rows updates a bulk edit live, and Quick edit on another row switches the panel (after the discard confirm). The panel opens at about half the window (52 %) and is resizable (drag or arrow keys, 480 px to 75 % of the window while the list keeps at least 320 px; the share is remembered); its right edge stays on the window's at every width and admin-menu state, and below 960 px it covers the window. F6 moves between list and panel, Escape and the X close it. Opening or closing it no longer re-renders the table's rows.
- Quick edit is a pencil button on every row (no hover needed); the ⋮ menu keeps it too.
- The name column no longer repeats the SKU on a second line (the SKU is its own column); saved views that had it are cleaned up.
- Short description, description and their translations edit as formatted text (Bold, Italic, lists, links) with a Code view for the HTML, instead of raw markup with `&amp;` and `<br />` in a textarea. Nothing is rewritten unless edited, text stored without paragraph tags keeps that form, and HTML the visual editor cannot keep (scripts, embeds, block comments) opens in Code.
- A click on the label of the editor's first checkbox ("Apply price and sale fields to all variations") no longer ticks every row of the list (the editor's checkboxes shared an id with the list's select-all checkbox).
- The list page prints a static skeleton and prefetches the default view's list and counts requests before the bundle runs.
- Expand all, Select all variations and bulk-edit hydration read variations across parents (`GET /wc-products-list/v1/variations`, one request per 100 variations instead of one per parent).
- Name cells and row parts subscribe per row; saves write the cache twice per save instead of once per response; reverts are sent three chunks at a time.
- Server: `brands: []` clears `product_brand` and logs it; History labels mixed batches as both edit and action; `/log/skipped` writes one row per item.

## 0.1.0 - 2026-10-09

First release. Products → Catalog: a DataViews product list for WooCommerce 11 with variations inline under their parents, in-place quick edit and bulk edit (scheduled sales on simple products and on all variations of variable products, numeric and percent operations with rounding, mixed-value state, server-side relative stock), optimistic saves with per-item errors and Undo, a change log with a batch History screen and revert, and a declarative PHP plus JavaScript extension API (used by gds-woo-i18n for per-language columns and tools).

- Bulk market prices reach the variations of selected variable products when "apply to all variations" is ticked; term lists without a valid id are refused per item instead of clearing the product's terms.
- History offers a dry run before a revert; selecting variations of many parents loads them in parallel; translation tools run in chunks.
- History lands on Batches: one row per gesture ("Sale from, Sale to, Sale price on 4 variations of 1 product"), failures, and "Reverted by <user> at <time>" / "Revert of <id>"; "Show changes" opens its per-field rows. Field labels come from the registry, values are formatted (prices in the language's own currency, sale dates in site time), Item ID is a bare id, the batch filter takes an id prefix, a filtered empty list offers Reset, a second revert of a batch warns and reads "Revert again", and failed changes are counted apart in the revert confirm.
- A refetch (a column added, an action on another row, an undo) keeps loaded variations on screen until the new rows arrive, so it never discards an open variation quick edit; Collapse all, the collapse row action and the chevron all ask before removing the edited variation; a running save keeps its editor mounted.
- Bulk saves send product chunks side by side (100 rows: 34 + 34 + 32, three at a time); the bulk success snackbar links to its batch in History, and snackbars show every action (core renders only the first).
- Scheduled-sale badges use a compact window ("Oct 12 – 18"); the bulk editor's "every product in the list" note shows only for a Select-all selection.
- Server: Restore of a never-published draft no longer leaves a `__trashed` slug; error log rows record the attempted values and a duplicate SKU names its owner; the log stores which batch a revert put back (schema 2); list reads prime raw meta (100 variations: 178 → 79 queries); list-mode product batches prime their items and defer WooCommerce's product transients.
- Variable product rows carry `variation_stock` ("4 of 16 variations out of stock") and `sale_summary` ("Scheduled · 12 variations") from one query per page, and the list takes `variation_stock_status` ("Any variation: Out of stock").
- Expand all asks in an in-page dialog instead of `window.confirm`; History shows an error row's reason in the cell and old → new values for extension actions with a field.
- Server: list pages no longer load every variation when WooCommerce's price cache is warm; batch write answers trim the gallery; `delete` refuses products outside the Trash unless hard delete is allowed; batch ids must be UUID v4 and a batch shared by two users is not revertable; rejected items on the cross-parent variations route are logged once.
- Extension actions report what they changed: a snackbar "Copy translations: 2 items updated" with Undo (the log's revert of the batch), results carry `changed`, and History reverts their batches like any update; only trash/restore/delete/duplicate rows stay skipped.
- Quick edit and bulk edit are inline rows of the table (WooCommerce's classic quick/bulk edit, three-column General tab): the quick editor replaces the edited row, the bulk editor sits above the first row with the selected items listed (x unticks one) and follows the selection until the first save; paging, sorting, filtering, collapsing the edited variation's parent and opening another editor ask before discarding unsaved changes. The edit modal is gone.
- Scaffold: plugin skeleton, Products → Catalog screen rendering a DataViews table, list-mode header, declarative field/filter/action registry, bootstrap payload, PHP and JS test suites, CI.
