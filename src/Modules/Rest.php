<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Module;

/**
 * REST plumbing: the list-mode query params, row enrichment, save
 * hooks and the wc-products-list/v1 controllers (counts, terms, log). Built
 * by the php-reads / php-writes steps; see docs/contracts.md.
 */
class Rest implements Module
{
    public function register(): void
    {
        // Stub: filled in by the module's builder.
    }
}
