<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Actions\Action;
use GeneroWP\ProductsList\Actions\Delete;
use GeneroWP\ProductsList\Actions\Duplicate;
use GeneroWP\ProductsList\Actions\Feature;
use GeneroWP\ProductsList\Actions\Restore;
use GeneroWP\ProductsList\Actions\SetStatus;
use GeneroWP\ProductsList\Actions\Trash;
use GeneroWP\ProductsList\Module;
use GeneroWP\ProductsList\Rest\ActionsController;
use GeneroWP\ProductsList\Rest\Saves;

/**
 * Writes: the save hooks (recorder + `wc_products_list/save`), the
 * built-in row actions and the actions REST route. See docs/contracts.md.
 */
class Actions implements Module
{
    public function register(): void
    {
        Saves::register();

        // Early, so a site can replace a built-in by id at the default priority.
        add_filter(ActionsController::FILTER_HANDLERS, [$this, 'builtIns'], 5);
        add_action('rest_api_init', [$this, 'registerRoutes']);
    }

    /**
     * @param  array<string, Action>  $handlers
     * @return array<string, Action>
     */
    public function builtIns(array $handlers): array
    {
        foreach ([
            new Trash,
            new Restore,
            new Delete,
            new Duplicate,
            new SetStatus('publish'),
            new SetStatus('draft'),
            new Feature,
        ] as $action) {
            $handlers[$action->id()] = $action;
        }

        return $handlers;
    }

    public function registerRoutes(): void
    {
        (new ActionsController)->register();
    }
}
