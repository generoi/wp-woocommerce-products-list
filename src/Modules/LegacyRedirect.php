<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Module;

/**
 * Phase 2: optionally redirect edit.php?post_type=product to the Catalog
 * screen (`legacy=1` escapes), mapping post_status/s/product_cat. Off by
 * default; see docs/contracts.md.
 */
class LegacyRedirect implements Module
{
    public function register(): void
    {
        // Stub: filled in by the module's builder.
    }
}
