<?php

namespace GeneroWP\ProductsList\Tests\Unit;

use GeneroWP\ProductsList\Bootstrap;
use GeneroWP\ProductsList\Log\Revert;
use GeneroWP\ProductsList\Rest\ActionsController;
use PHPUnit\Framework\TestCase;

/**
 * The caps on what one write request may carry.
 */
class BulkLimitsTest extends TestCase
{
    public function test_action_batch_size_is_the_wc_batch_limit(): void
    {
        $this->assertSame(100, Bootstrap::ACTION_BATCH_SIZE);
        $this->assertSame(100, Revert::PRODUCTS_CHUNK);
    }

    public function test_ids_are_integers_unique_and_capped(): void
    {
        $this->assertSame(['ok' => true, 'ids' => [1, 2, 3]], ActionsController::parseIds([1, '2', 3.0, 2, 0, -4], 100));

        $tooMany = ActionsController::parseIds(range(1, 101), 100);
        $this->assertFalse($tooMany['ok']);
        $this->assertSame('wc_products_list_too_many_ids', $tooMany['code']);

        $this->assertTrue(ActionsController::parseIds(range(1, 100), 100)['ok']);

        $this->assertSame('wc_products_list_no_ids', ActionsController::parseIds([], 100)['code']);
        $this->assertSame('wc_products_list_no_ids', ActionsController::parseIds([0, 0], 100)['code']);
        $this->assertSame('wc_products_list_invalid_ids', ActionsController::parseIds('1,2', 100)['code']);
        $this->assertSame('wc_products_list_invalid_ids', ActionsController::parseIds([1, 'abc'], 100)['code']);
        $this->assertSame('wc_products_list_invalid_ids', ActionsController::parseIds([1.5], 100)['code']);
        $this->assertSame('wc_products_list_invalid_ids', ActionsController::parseIds([[1]], 100)['code']);
    }

    public function test_revert_plan_handles_more_products_than_one_batch(): void
    {
        $rows = [];

        for ($i = 1; $i <= 250; $i++) {
            $rows[] = ['id' => $i, 'object_type' => 'product', 'object_id' => $i, 'parent_id' => 0, 'action' => 'update', 'status' => 'ok', 'field' => 'sale_price', 'old_value' => '', 'new_value' => '9'];
        }

        $plan = Revert::plan($rows);

        $this->assertCount(250, $plan['products']);
        $this->assertCount(3, array_chunk($plan['products'], Revert::PRODUCTS_CHUNK, true));
        $this->assertSame([], $plan['skipped']);
    }
}
