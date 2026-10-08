<?php

namespace GeneroWP\ProductsList;

use WP_REST_Request;

/**
 * Whether the current request comes from the Catalog app.
 *
 * The app sends `X-WC-Products-List: 1` on every REST request, and
 * `X-WC-Products-List-Batch: <uuid>` on writes. Only then does the plugin
 * enrich wc/v3 rows, map its extra query params and log changes, so other
 * wc/v3 consumers pay nothing. A header rather than a query param because
 * batch sub-requests are rebuilt from body params but keep the headers.
 */
final class ListMode
{
    public const HEADER = 'X-WC-Products-List';

    public const BATCH_HEADER = 'X-WC-Products-List-Batch';

    /**
     * Where a write came from. The app sends `quick`, `bulk` or `extension`;
     * the plugin itself sets `action` and `revert` on its own nested
     * requests. Defaults to `quick`. The log table stores exactly these.
     */
    public const SOURCE_HEADER = 'X-WC-Products-List-Source';

    public const SOURCES = ['quick', 'bulk', 'action', 'extension', 'revert'];

    private static ?bool $active = null;

    private static ?string $batchId = null;

    private static ?WP_REST_Request $request = null;

    /** @var array<int, ?WP_REST_Request> the requests a nested dispatch interrupted, innermost last */
    private static array $stack = [];

    /** @var array{0: ?bool, 1: ?string}|null */
    private static ?array $forced = null;

    public const CACHE_KEY_PART = 'wc-products-list';

    public static function register(): void
    {
        add_filter('rest_request_before_callbacks', [self::class, 'capture'], 1, 3);
        // Last of all: every other after-callbacks listener still sees the
        // request that was dispatched.
        add_filter('rest_request_after_callbacks', [self::class, 'release'], PHP_INT_MAX, 3);
        add_filter('woocommerce_rest_api_cache_key_info', [self::class, 'cacheKey'], 10, 2);
    }

    /**
     * WooCommerce's REST response cache (the `rest_api_caching` feature)
     * keys a products or variations response on route, method and query
     * params, never on headers. A list-mode row carries the `wc_products_list`
     * key, the integrations' keys, a trimmed gallery and the current user's
     * capabilities, so such a response must not be served to another
     * consumer, nor theirs to the app: in list mode the key gets a marker
     * and the user.
     *
     * @param  mixed  $parts
     * @param  mixed  $request
     * @return mixed
     */
    public static function cacheKey($parts, $request = null)
    {
        if (! is_array($parts)) {
            return $parts;
        }

        $active = $request instanceof WP_REST_Request
            ? self::requestHasHeader($request)
            : self::active();

        if (! $active) {
            return $parts;
        }

        $parts[] = self::CACHE_KEY_PART;
        $parts[] = 'user_'.get_current_user_id();

        return $parts;
    }

    private static function requestHasHeader(WP_REST_Request $request): bool
    {
        if (self::$forced !== null && self::$forced[0] !== null) {
            return self::$forced[0];
        }

        $value = $request->get_header(self::HEADER);

        return $value !== null && $value !== '' && $value !== '0';
    }

    /**
     * Remember the request being dispatched. Runs for every dispatched
     * request, including the ones the plugin dispatches from inside its
     * own (the actions refresh, the revert's wc/v3 writes), so the memo is
     * per request and the interrupted one is kept to be restored by
     * `release()`. Batch sub-requests are not dispatched and never come here.
     *
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function capture($response, $handler, WP_REST_Request $request)
    {
        self::$stack[] = self::$request;
        self::$request = $request;
        self::$active = null;
        self::$batchId = null;

        return $response;
    }

    /**
     * The dispatched request is done: the one it interrupted (if any) is
     * the current request again, with its own header memo.
     *
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function release($response, $handler, WP_REST_Request $request)
    {
        if (self::$request !== $request) {
            return $response;
        }

        self::$request = self::$stack === [] ? null : array_pop(self::$stack);
        self::$active = null;
        self::$batchId = null;

        return $response;
    }

    public static function active(): bool
    {
        if (self::$forced !== null && self::$forced[0] !== null) {
            return self::$forced[0];
        }

        if (self::$active !== null) {
            return self::$active;
        }

        $value = self::header(self::HEADER);

        /**
         * Filters whether the current request is treated as a Catalog app request.
         *
         * @param  bool  $active
         */
        return self::$active = (bool) apply_filters('wc_products_list/active', $value !== null && $value !== '' && $value !== '0');
    }

    /**
     * The batch id the app attached to this write, or null. One batch groups
     * every log row of one user gesture (a bulk save, an action on many rows).
     */
    public static function batchId(): ?string
    {
        if (self::$forced !== null && self::$forced[1] !== null) {
            return self::$forced[1];
        }

        if (self::$batchId !== null) {
            return self::$batchId;
        }

        $value = self::header(self::BATCH_HEADER);

        if ($value === null || ! preg_match('/^[A-Za-z0-9_-]{1,64}$/', $value)) {
            return self::$batchId = null;
        }

        return self::$batchId = $value;
    }

    /**
     * The source declared for this write (one of SOURCES); anything else, or
     * no header, is `quick`. The log stores it per row.
     */
    public static function source(): string
    {
        $value = self::header(self::SOURCE_HEADER);
        $value = $value === null ? null : strtolower(trim($value));

        return $value !== null && in_array($value, self::SOURCES, true) ? $value : 'quick';
    }

    /**
     * The request being dispatched, or null outside REST dispatch. During
     * `POST …/batch` this is the batch request, not its items.
     */
    public static function request(): ?WP_REST_Request
    {
        return self::$request;
    }

    /**
     * The HTTP method of the request being dispatched (`GET`, `POST`, ...),
     * or null outside a request. Batch sub-requests are not dispatched, so
     * during `POST /wc/v3/products/batch` this stays `POST`.
     */
    public static function method(): ?string
    {
        if (self::$request !== null) {
            return self::$request->get_method();
        }

        return isset($_SERVER['REQUEST_METHOD']) ? strtoupper((string) $_SERVER['REQUEST_METHOD']) : null;
    }

    /**
     * Pretend the header is (not) there. For tests and CLI commands; pass
     * nulls to go back to reading the request.
     */
    public static function force(?bool $active, ?string $batchId = null): void
    {
        self::$forced = $active === null && $batchId === null ? null : [$active, $batchId];
        self::$active = null;
        self::$batchId = null;
    }

    /**
     * Forget the dispatched requests. For tests, where a request may end
     * in an exception before `release()` ran.
     */
    public static function reset(): void
    {
        self::$request = null;
        self::$stack = [];
        self::$active = null;
        self::$batchId = null;
    }

    private static function header(string $name): ?string
    {
        if (self::$request !== null) {
            return self::$request->get_header($name);
        }

        $key = 'HTTP_'.strtoupper(str_replace('-', '_', $name));

        return isset($_SERVER[$key]) ? (string) $_SERVER[$key] : null;
    }
}
