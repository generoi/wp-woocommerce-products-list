<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Module;
use GeneroWP\ProductsList\Rest\CountsController;
use GeneroWP\ProductsList\Rest\ListQuery;
use GeneroWP\ProductsList\Rest\Rows;
use GeneroWP\ProductsList\Rest\TermsController;

/**
 * The read side of the REST plumbing: the list-mode query parameters, the
 * row enrichment and the wc-products-list/v1 counts and terms routes. The
 * write side (the save hook and the change log, the actions route) is
 * registered by the Log and Actions modules.
 */
class Rest implements Module
{
    private ListQuery $listQuery;

    private Rows $rows;

    public function register(): void
    {
        $this->listQuery = new ListQuery;
        $this->listQuery->register();

        $this->rows = new Rows;
        $this->rows->register();

        add_action('rest_api_init', [$this, 'registerRoutes']);
    }

    public function registerRoutes(): void
    {
        (new CountsController)->register_routes();
        (new TermsController)->register_routes();
    }

    public function listQuery(): ListQuery
    {
        return $this->listQuery;
    }

    public function rows(): Rows
    {
        return $this->rows;
    }
}
