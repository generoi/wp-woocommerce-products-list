<?php

namespace GeneroWP\ProductsList\Tests\Integration;

use GeneroWP\ProductsList\ListMode;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/**
 * Dispatches REST requests the way the app sends them: with the list-mode
 * header on every request and a batch id on writes.
 */
abstract class RestTestCase extends TestCase
{
    protected WP_REST_Server $server;

    public function set_up(): void
    {
        parent::set_up();

        $this->server = rest_get_server();
    }

    public function tear_down(): void
    {
        // The next test gets a fresh server with freshly registered routes.
        $GLOBALS['wp_rest_server'] = null;

        parent::tear_down();
    }

    /**
     * @param  string  $route  e.g. '/wc/v3/products' or '/wc-products-list/v1/counts'
     * @param  array<string, mixed>  $params  query params for GET, body params otherwise
     * @param  array<string, string>  $headers  extra headers; `X-WC-Products-List: 1` is always set unless passed as ''
     * @param  array<string, mixed>  $query  query params of a write (`fields`, `_fields`); ignored for GET, where `$params` are the query
     */
    protected function request(string $method, string $route, array $params = [], array $headers = [], array $query = []): WP_REST_Response
    {
        $request = new WP_REST_Request(strtoupper($method), $route);

        $headers += [ListMode::HEADER => '1'];

        if (in_array($request->get_method(), ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            $headers += [ListMode::BATCH_HEADER => $this->batchId()];
        }

        foreach ($headers as $name => $value) {
            if ($value !== '') {
                $request->set_header($name, $value);
            }
        }

        if ($request->get_method() === 'GET') {
            $request->set_query_params($params);
        } else {
            $request->set_body_params($params);
            $request->set_query_params($query);
        }

        return rest_do_request($request);
    }

    /**
     * @return mixed the response data, as the client would see it
     */
    protected function data(WP_REST_Response $response): mixed
    {
        return $this->server->response_to_data($response, false);
    }

    protected function assertStatus(int $expected, WP_REST_Response $response): void
    {
        $this->assertSame(
            $expected,
            $response->get_status(),
            'Response: '.wp_json_encode($this->data($response), JSON_PRETTY_PRINT)
        );
    }

    private ?string $batch = null;

    /**
     * The batch id of this test. Every write in one test belongs to it, as
     * every write of one user gesture does in the app.
     */
    protected function batchId(): string
    {
        return $this->batch ??= wp_generate_uuid4();
    }
}
