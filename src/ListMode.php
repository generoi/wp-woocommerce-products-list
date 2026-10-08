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

    private static ?bool $active = null;

    private static ?string $batchId = null;

    private static ?WP_REST_Request $request = null;

    /** @var array{0: ?bool, 1: ?string}|null */
    private static ?array $forced = null;

    public static function register(): void
    {
        add_filter('rest_request_before_callbacks', [self::class, 'capture'], 1, 3);
    }

    /**
     * Remember the request being dispatched. Runs for every REST request,
     * including the sub-requests of a batch, so the memo is per request.
     *
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function capture($response, $handler, WP_REST_Request $request)
    {
        self::$request = $request;
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
     * Pretend the header is (not) there. For tests and CLI commands; pass
     * nulls to go back to reading the request.
     */
    public static function force(?bool $active, ?string $batchId = null): void
    {
        self::$forced = $active === null && $batchId === null ? null : [$active, $batchId];
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
