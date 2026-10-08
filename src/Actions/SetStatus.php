<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Product;
use WP_REST_Request;

/**
 * The `publish` and `draft` actions: one class, one target status each.
 */
final class SetStatus implements Action
{
    public function __construct(private readonly string $status) {}

    public function id(): string
    {
        return $this->status;
    }

    public function appliesTo(): string
    {
        return 'product';
    }

    public function can(WC_Product $product): bool
    {
        if ($this->status === 'publish') {
            return current_user_can('publish_post', $product->get_id());
        }

        return current_user_can('edit_post', $product->get_id());
    }

    public function sanitizeArgs(array $args): array
    {
        return [];
    }

    public function run(WC_Product $product, array $args, WP_REST_Request $request): array
    {
        $old = $product->get_status();

        if ($old === $this->status) {
            return [];
        }

        $product->set_status($this->status);
        $product->save();

        return ['changes' => ['status' => [$old, $this->status]]];
    }
}
