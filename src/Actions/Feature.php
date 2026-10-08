<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Product;
use WP_REST_Request;

/**
 * Feature or unfeature: `{"featured": true|false}`, default true.
 */
final class Feature implements Action
{
    public function id(): string
    {
        return 'feature';
    }

    public function appliesTo(): string
    {
        return 'product';
    }

    public function can(WC_Product $product): bool
    {
        return current_user_can('edit_post', $product->get_id());
    }

    public function sanitizeArgs(array $args): array
    {
        return ['featured' => array_key_exists('featured', $args) ? wc_string_to_bool($args['featured']) : true];
    }

    public function run(WC_Product $product, array $args, WP_REST_Request $request): array
    {
        $featured = (bool) ($args['featured'] ?? true);
        $old = $product->get_featured();

        if ($old === $featured) {
            return [];
        }

        $product->set_featured($featured);
        $product->save();

        return ['changes' => ['featured' => [$old, $featured]]];
    }
}
