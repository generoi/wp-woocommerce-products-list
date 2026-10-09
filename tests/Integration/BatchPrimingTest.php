<?php

namespace GeneroWP\ProductsList\Tests\Integration;

/**
 * The list-mode batch priming loads every item of a write batch up front.
 * It must run only for a request that passed its permission check, and
 * never for more items than WooCommerce's batch limit.
 */
class BatchPrimingTest extends RestTestCase
{
    /** @var array<int, string> */
    private array $primes = [];

    private function startCounting(): void
    {
        $this->primes = [];
        add_filter('query', [$this, 'countPrime']);
    }

    private function stopCounting(): void
    {
        remove_filter('query', [$this, 'countPrime']);
    }

    public function countPrime(string $query): string
    {
        if (preg_match('/FROM \S*(postmeta|posts)\s.*WHERE (post_id|ID) IN \(/s', $query)) {
            $this->primes[] = $query;
        }

        return $query;
    }

    /**
     * @return array<int, array{id: int}>
     */
    private function items(int $count): array
    {
        return array_map(static fn (int $id): array => ['id' => $id], range(900001, 900000 + $count));
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function batchRoutes(): array
    {
        return [
            'products batch' => ['/wc/v3/products/batch'],
            'variations batch' => ['/wc-products-list/v1/variations/batch'],
        ];
    }

    /**
     * @dataProvider batchRoutes
     */
    public function test_an_anonymous_batch_does_no_per_id_work(string $route): void
    {
        $this->actAs('guest');

        $this->startCounting();
        $response = $this->request('POST', $route, ['update' => $this->items(1000)]);
        $this->stopCounting();

        $this->assertStatus(401, $response);
        $this->assertSame([], $this->primes, 'Primed before the permission check: '.implode("\n", $this->primes));
    }

    public function test_a_user_without_the_capability_does_no_per_id_work(): void
    {
        $this->actAs('subscriber');

        $this->startCounting();
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => $this->items(1000)]);
        $this->stopCounting();

        $this->assertSame(403, $response->get_status());
        $this->assertSame([], $this->primes);
    }

    public function test_an_oversized_batch_primes_at_most_the_batch_limit(): void
    {
        $this->startCounting();
        $response = $this->request('POST', '/wc/v3/products/batch', ['update' => $this->items(1000)]);
        $this->stopCounting();

        // WooCommerce refuses more than 100 items in the callback.
        $this->assertSame(413, $response->get_status());

        foreach ($this->primes as $query) {
            preg_match('/IN \(([^)]*)\)/', $query, $match);
            $this->assertLessThanOrEqual(100, count(explode(',', $match[1] ?? '')), 'Primed more ids than the batch limit.');
        }
    }

    public function test_an_authorised_batch_is_still_primed(): void
    {
        $ids = [];

        for ($i = 0; $i < 3; $i++) {
            $ids[] = $this->simpleProduct(['sku' => 'PRIME'.$i])->get_id();
        }

        wp_cache_flush();

        $this->startCounting();
        $response = $this->request('POST', '/wc/v3/products/batch', [
            'update' => array_map(static fn (int $id): array => ['id' => $id, 'featured' => true], $ids),
        ], [], ['fields' => 'id,featured']);
        $this->stopCounting();

        $this->assertStatus(200, $response);
        $this->assertNotSame([], $this->primes);
    }
}
