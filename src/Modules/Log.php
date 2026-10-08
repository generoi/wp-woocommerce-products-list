<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Module;

/**
 * The change log: table install on `wc_products_list/activate` and on
 * version change, the recorder that diffs old → new per field, the daily
 * prune and the revert. See docs/contracts.md.
 */
class Log implements Module
{
    public function register(): void
    {
        // Stub: filled in by the module's builder.
    }
}
