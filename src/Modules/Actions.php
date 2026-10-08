<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Module;

/**
 * Built-in row actions (trash, restore, delete, duplicate) and the
 * registry of extension Action instances behind
 * POST /wc-products-list/v1/actions/{action}. See docs/contracts.md.
 */
class Actions implements Module
{
    public function register(): void
    {
        // Stub: filled in by the module's builder.
    }
}
