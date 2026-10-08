# Changelog

## Unreleased

- Variable product rows carry `variation_stock` ("4 of 16 variations out of stock") and `sale_summary` ("Scheduled · 12 variations") from one query per page, and the list takes `variation_stock_status` ("Any variation: Out of stock").
- Expand all asks in an in-page dialog instead of `window.confirm`; History shows an error row's reason in the cell and old → new values for extension actions with a field.
- Server: list pages no longer load every variation when WooCommerce's price cache is warm; batch write answers trim the gallery; `delete` refuses products outside the Trash unless hard delete is allowed; batch ids must be UUID v4 and a batch shared by two users is not revertable; rejected items on the cross-parent variations route are logged once.
- Extension actions report what they changed: a snackbar "Copy translations: 2 items updated" with Undo (the log's revert of the batch), results carry `changed`, and History reverts their batches like any update; only trash/restore/delete/duplicate rows stay skipped.
- Quick edit and bulk edit are inline rows of the table (WooCommerce's classic quick/bulk edit, three-column General tab): the quick editor replaces the edited row, the bulk editor sits above the first row with the selected items listed (x unticks one) and follows the selection until the first save; paging, sorting, filtering, collapsing the edited variation's parent and opening another editor ask before discarding unsaved changes. The edit modal is gone.
- Scaffold: plugin skeleton, Products → Catalog screen rendering a DataViews table, list-mode header, declarative field/filter/action registry, bootstrap payload, PHP and JS test suites, CI.
