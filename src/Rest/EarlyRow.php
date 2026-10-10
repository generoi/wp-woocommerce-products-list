<?php

namespace GeneroWP\ProductsList\Rest;

use GeneroWP\ProductsList\Log\Logger;
use WP_Post;

/**
 * The log row of a row action's status change or delete, written the
 * moment the change happens instead of after the handler returns: from
 * `transition_post_status` and `deleted_post` (first priority), scoped to
 * the one id being acted on. A trash, restore, publish or draft is in the
 * posts table before core and WooCommerce run their hooks for it (terms,
 * comments, transients, lookup tables, revisions); without this a request
 * killed in that time left the product changed and no row (History, Undo).
 * What remains is the time inside `wp_update_post()` between its UPDATE
 * and `transition_post_status`, and inside `wp_delete_post()` between its
 * DELETE and `deleted_post` (docs/contracts.md §3.6).
 *
 * The row is written with `Logger::writeNow()` and, once the handler
 * returns, overwritten with the handler's own row of the field
 * (`finalise()`).
 */
final class EarlyRow
{
    private int $rowId = 0;

    private bool $done = false;

    /** @var (callable(string, string, mixed): void)|null */
    private $onTransition = null;

    /** @var (callable(mixed): void)|null */
    private $onDeleted = null;

    /**
     * @param  array<string, mixed>  $base  the id's row defaults (batch, action, object, context)
     */
    public function __construct(private readonly int $id, private readonly string $status, private readonly array $base) {}

    public function watch(): void
    {
        $this->onTransition = function (string $new, string $old, mixed $post): void {
            if ($post instanceof WP_Post && (int) $post->ID === $this->id && $new !== $old) {
                $this->write($old, $new);
            }
        };
        $this->onDeleted = function (mixed $postId): void {
            if ((int) $postId === $this->id) {
                $this->write($this->status, null);
            }
        };

        add_action('transition_post_status', $this->onTransition, PHP_INT_MIN, 3);
        add_action('deleted_post', $this->onDeleted, PHP_INT_MIN, 1);
    }

    public function unwatch(): void
    {
        if ($this->onTransition !== null) {
            remove_action('transition_post_status', $this->onTransition, PHP_INT_MIN);
        }

        if ($this->onDeleted !== null) {
            remove_action('deleted_post', $this->onDeleted, PHP_INT_MIN);
        }

        $this->onTransition = null;
        $this->onDeleted = null;
    }

    /** Whether a row was written for a change of this id. */
    public function written(): bool
    {
        return $this->done;
    }

    /**
     * The handler's rows minus the one that now overwrites the early row
     * (its `status` row, else none: the early row stays as written).
     *
     * @param  array<int, array<string, mixed>>  $rows
     * @return array<int, array<string, mixed>>
     */
    public function finalise(array $rows): array
    {
        if (! $this->done) {
            return $rows;
        }

        foreach ($rows as $index => $row) {
            if (($row['field'] ?? '') === 'status') {
                if ($this->rowId > 0) {
                    Logger::replace($this->rowId, $row);
                    unset($rows[$index]);
                }

                break;
            }
        }

        return array_values($rows);
    }

    private function write(string $old, ?string $new): void
    {
        if ($this->done) {
            // A second change in the same handler (a restore corrected to
            // its previous status): the handler's row says where it ended.
            return;
        }

        $this->done = true;
        $this->rowId = Logger::writeNow($this->base + [
            'field' => 'status',
            'old_value' => $old,
            'new_value' => $new,
            'status' => Logger::STATUS_OK,
            'message' => '',
        ]);
    }
}
