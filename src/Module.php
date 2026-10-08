<?php

namespace GeneroWP\ProductsList;

interface Module
{
    /**
     * Register this module's hooks. Called once on `plugins_loaded`, after
     * WooCommerce is known to be present.
     */
    public function register(): void;
}
