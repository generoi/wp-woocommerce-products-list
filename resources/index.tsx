import domReady from '@wordpress/dom-ready';
import { createRoot } from '@wordpress/element';
import { App } from './app';
import './style.scss';

/**
 * Boot order (see docs/contracts.md): the extension API is created and
 * `wcProductsList.ready` fired before the app mounts, so extension scripts
 * that depend on the `wc-products-list` handle can register fields first.
 * The scaffold only mounts.
 */
domReady( () => {
	const root = document.getElementById( 'wc-products-list-root' );

	if ( ! root ) {
		return;
	}

	createRoot( root ).render( <App /> );
} );
