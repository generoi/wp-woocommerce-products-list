<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\Plugin;
use WP_Error;
use WP_REST_Controller;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/**
 * POST /wc-products-list/v1/client-errors: the app reports its own browser
 * errors (render crashes, uncaught errors from the bundle, failed REST calls)
 * here, so they end up in WooCommerce → Status → Logs under the source
 * `wc-products-list-client` instead of only in someone's console.
 *
 * Bounded: at most RATE_LIMIT reports per user per RATE_WINDOW seconds, every
 * string is truncated, nothing is stored outside the WooCommerce log.
 */
class ClientErrorsController extends WP_REST_Controller
{
    public const LOG_SOURCE = 'wc-products-list-client';

    public const RATE_LIMIT = 60;

    public const RATE_WINDOW = 600;

    protected $namespace = Plugin::REST_NAMESPACE;

    protected $rest_base = 'client-errors';

    public function register_routes(): void
    {
        register_rest_route($this->namespace, '/'.$this->rest_base, [
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => [$this, 'create_item'],
                'permission_callback' => [$this, 'create_item_permissions_check'],
                'args' => [
                    'kind' => ['type' => 'string', 'required' => true, 'enum' => ['render', 'uncaught', 'rejection', 'api']],
                    'message' => ['type' => 'string', 'required' => true],
                    'stack' => ['type' => 'string', 'default' => ''],
                    'context' => ['type' => 'object', 'default' => []],
                    'url' => ['type' => 'string', 'default' => ''],
                ],
            ],
        ]);
    }

    /**
     * @param  WP_REST_Request  $request
     * @return bool|WP_Error
     */
    public function create_item_permissions_check($request)
    {
        if (current_user_can(Plugin::capability())) {
            return true;
        }

        return new WP_Error('wc_products_list_forbidden', __('Sorry, you are not allowed to report errors.', 'wp-woocommerce-products-list'), ['status' => rest_authorization_required_code()]);
    }

    /**
     * @param  WP_REST_Request  $request
     * @return WP_REST_Response|WP_Error
     */
    public function create_item($request)
    {
        $userId = get_current_user_id();
        $key = 'wc_pl_client_errors_'.$userId;
        $count = (int) get_transient($key);

        if ($count >= self::RATE_LIMIT) {
            return new WP_REST_Response(['logged' => false, 'reason' => 'rate_limited'], 202);
        }

        set_transient($key, $count + 1, self::RATE_WINDOW);

        if (! function_exists('wc_get_logger')) {
            return new WP_REST_Response(['logged' => false, 'reason' => 'no_logger'], 202);
        }

        $context = $request->get_param('context');
        $context = is_array($context) ? $context : [];
        $encodedContext = wp_json_encode($context);

        wc_get_logger()->error(
            sprintf('[%s] %s', (string) $request->get_param('kind'), self::clip((string) $request->get_param('message'), 1000)),
            [
                'source' => self::LOG_SOURCE,
                'user_id' => $userId,
                'plugin_version' => defined('WC_PRODUCTS_LIST_VERSION') ? WC_PRODUCTS_LIST_VERSION : '',
                'url' => self::clip(esc_url_raw((string) $request->get_param('url')), 500),
                'context' => self::clip(is_string($encodedContext) ? $encodedContext : '', 2000),
                'stack' => self::clip((string) $request->get_param('stack'), 4000),
                'user_agent' => self::clip(isset($_SERVER['HTTP_USER_AGENT']) ? sanitize_text_field(wp_unslash((string) $_SERVER['HTTP_USER_AGENT'])) : '', 300),
            ]
        );

        return new WP_REST_Response(['logged' => true], 201);
    }

    private static function clip(string $value, int $max): string
    {
        $value = wp_strip_all_tags($value);

        return strlen($value) > $max ? substr($value, 0, $max).'…' : $value;
    }
}
