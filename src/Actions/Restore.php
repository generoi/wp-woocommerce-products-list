<?php

namespace GeneroWP\ProductsList\Actions;

use WC_Product;
use WP_Error;
use WP_REST_Request;

/**
 * Restore from the trash to the status it had: WooCommerce's
 * `wp_untrash_post_status` filter puts products back where they were
 * rather than in draft, which is what `wp_untrash_post` does on its own.
 */
final class Restore implements Action
{
    public function id(): string
    {
        return 'restore';
    }

    public function appliesTo(): string
    {
        return 'both';
    }

    public function can(WC_Product $product): bool
    {
        return current_user_can('delete_post', $product->get_id());
    }

    public function sanitizeArgs(array $args): array
    {
        return [];
    }

    public function run(WC_Product $product, array $args, WP_REST_Request $request): array|WP_Error
    {
        if ($product->get_status() !== 'trash') {
            // Restored another way already: nothing to undo, logged as a no-op (skipped, unchanged), not a failure.
            return new WP_Error('wc_products_list_not_trashed', __('The product is not in the trash.', 'wp-woocommerce-products-list'), ['skip_reason' => 'unchanged']);
        }

        $previous = (string) get_post_meta($product->get_id(), '_wp_trash_meta_status', true);

        if (! wp_untrash_post($product->get_id())) {
            return new WP_Error('wc_products_list_restore_failed', __('The product could not be restored.', 'wp-woocommerce-products-list'));
        }

        $status = (string) get_post_status($product->get_id());

        if ($previous !== '' && $status !== $previous) {
            // A site filter overrode the previous status; keep what WooCommerce
            // intended, which is what the app showed before the trash.
            wp_update_post(['ID' => $product->get_id(), 'post_status' => $previous]);
            $status = $previous;
        }

        self::restoreSlug($product->get_id(), $status);

        wc_delete_product_transients($product->get_id());

        return ['changes' => ['status' => ['trash', $status]]];
    }

    /**
     * Undo the `__trashed` suffix core leaves behind. `wp_trash_post()`
     * appends it to the slug and remembers the old one, but a product that
     * never had a slug (a draft, a fresh copy) is remembered as '', which
     * `wp_untrash_post()` does not restore: the product comes back as
     * `__trashed` and would be published at /product/__trashed/. A draft
     * gets its slug back empty (WordPress derives one when it is
     * published); a published product a unique one from its title.
     */
    public static function restoreSlug(int $id, string $status): void
    {
        $post = get_post($id);

        if ($post === null || ! preg_match('/__trashed(-\d+)?$/', (string) $post->post_name)) {
            return;
        }

        $slug = '';

        if (! in_array($status, ['draft', 'pending', 'auto-draft'], true)) {
            $base = preg_replace('/__trashed(-\d+)?$/', '', (string) $post->post_name);
            $base = $base !== '' && $base !== null ? $base : sanitize_title((string) $post->post_title);
            $slug = wp_unique_post_slug($base !== '' ? $base : (string) $id, $id, $status, (string) $post->post_type, (int) $post->post_parent);
        }

        global $wpdb;

        // Directly: wp_update_post() would run every save hook of the product again for one column.
        $wpdb->update($wpdb->posts, ['post_name' => $slug], ['ID' => $id]);
        clean_post_cache($id);
    }
}
