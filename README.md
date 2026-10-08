# WooCommerce Products List

A fast product catalog for the WooCommerce admin, built on `@wordpress/dataviews`: variations expand inline under their parents, quick edit and bulk edit (including scheduled sales across variations) happen inline in the table like the classic list's quick edit, without a modal or a page reload, and every change made through the list is logged with a revert path. Extensions add columns, filters and actions in PHP alone, or in JavaScript through `window.wcProductsList`.

Requires WordPress 6.8+, WooCommerce 11.0+ and PHP 8.2+. Adds **Products → Catalog**; the classic list stays untouched.

## Install

```sh
composer require generoi/wp-woocommerce-products-list
wp plugin activate wp-woocommerce-products-list
```

`build/` is committed, so a Composer install needs no Node.

## Capabilities

The Catalog screen and the plugin's own REST routes need `edit_products` (shop managers and administrators have it; change it with the `wc_products_list/capability` filter). Saves go through WooCommerce's `wc/v3` endpoints, which have requirements of their own:

- Quick edit of one product: `POST /wc/v3/products/{id}` needs `edit_post` on that product (`edit_products`, plus `edit_others_products` for products the user did not create, `edit_published_products` for published ones).
- Bulk edit and every multi-row save: `POST /wc/v3/products/batch` and `/variations/batch` need **`edit_others_products`** (WooCommerce's rule for batch writes), or WooCommerce answers `woocommerce_rest_cannot_batch`. The settings payload exposes it as `caps.editOthers`.
- Trash, restore, delete and duplicate run through `/wc-products-list/v1/actions/{action}` and check `delete_post` / `edit_post` (and `manage_woocommerce` for duplicate) per product.

A role that has `edit_products` but not `edit_others_products` can browse and quick-edit its own products, but cannot bulk edit.

## History

Every change made through the list is logged. The History screen is the Catalog page with `&screen=history`: `edit.php?post_type=product&page=wc-products-list&screen=history` (the **History** button in the Catalog toolbar, `links.history` in the settings payload). `&object_id=<id>` scopes it to one product, `&batch=<uuid>` to one save; a row's **History** action opens the same screen for that row. There is no separate submenu slug.

### Personal data and retention

Every log row stores who made the change (`user_id`) and, in its `context` column, the request's IP address and user agent, so an unexpected change can be traced to a session. The REST API never returns `context`; it is only in the database table. Rows are pruned after 180 days by a daily cron (`wc_products_list/log_retention_days` changes the period). Mention the log in the site's privacy policy if the store has several editors, and shorten the retention if 180 days is more than the store needs.

## Measuring

The speed budgets in `docs/contracts.md` §9 are measured on a production-like build: `SCRIPT_DEBUG` off (Bedrock's development environment turns it on, which loads the development builds of React and the components and makes rendering several times slower) and Query Monitor deactivated (its per-query backtraces double the REST timings). Activate either for a diagnosis, not for a measurement.

## Develop

```sh
composer install
pnpm install
pnpm start            # watch build
composer lint && composer stan && composer test
pnpm lint:js && pnpm lint:types && pnpm test && pnpm build
```

Integration tests boot WordPress and WooCommerce: `pnpm env:start && composer test:wp-env`, or on a Bedrock site under DDEV `ddev exec -d /var/www/html/web/app/plugins/wp-woocommerce-products-list env WP_PHPUNIT__TESTS_CONFIG=tests/wp-tests-config.php vendor/bin/phpunit --bootstrap tests/bootstrap.php --testsuite integration`.

The contracts between the PHP side, the JS app and extensions are in [docs/contracts.md](docs/contracts.md).

## License

MIT
