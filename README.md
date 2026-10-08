# WooCommerce Products List

A fast product catalog for the WooCommerce admin, built on `@wordpress/dataviews`: variations expand inline under their parents, quick edit and bulk edit (including scheduled sales across variations) happen in place without a page reload, and every change made through the list is logged with a revert path. Extensions add columns, filters and actions in PHP alone, or in JavaScript through `window.wcProductsList`.

Requires WordPress 6.8+, WooCommerce 11.0+ and PHP 8.2+. Adds **Products → Catalog**; the classic list stays untouched.

## Install

```sh
composer require generoi/wp-woocommerce-products-list
wp plugin activate wp-woocommerce-products-list
```

`build/` is committed, so a Composer install needs no Node.

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
