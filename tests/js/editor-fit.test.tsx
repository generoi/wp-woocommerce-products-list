/**
 * The editor row fits the visible width of the table's scrolling wrapper
 * and the wrapper is back at its start when the editor opens and closes,
 * so the item list, the Name column and the checkboxes stay on screen.
 */
import { render } from '@testing-library/react';
import { useRef } from '@wordpress/element';
import { describe, expect, it } from 'vitest';
import { horizontalScroller, useEditorFitsScroller } from '../../resources/edit/editor-context';

function Host() {
	const ref = useRef< HTMLDivElement >( null );

	useEditorFitsScroller( ref );

	return <div ref={ ref } className="wc-pl-inline-edit-host" />;
}

describe( 'useEditorFitsScroller', () => {
	it( 'sizes the editor to the wrapper and scrolls the wrapper back to the start, on open and on close', () => {
		const wrapper = document.createElement( 'div' );

		wrapper.style.overflowX = 'auto';
		wrapper.innerHTML = '<table><tbody><tr><td style="padding-left: 20px; padding-right: 20px"></td></tr></tbody></table>';
		document.body.appendChild( wrapper );
		Object.defineProperty( wrapper, 'clientWidth', { configurable: true, value: 1200 } );
		wrapper.scrollLeft = 140;

		const cell = wrapper.querySelector( 'td' )!;

		expect( horizontalScroller( cell ) ).toBe( wrapper );

		const view = render( <Host />, { container: cell } );
		const host = cell.querySelector< HTMLElement >( '.wc-pl-inline-edit-host' )!;

		expect( host.style.getPropertyValue( '--wc-pl-editor-width' ) ).toBe( '1160px' );
		expect( host.style.getPropertyValue( '--wc-pl-editor-left' ) ).toBe( '20px' );
		expect( host.classList.contains( 'is-fitted' ) ).toBe( true );
		expect( wrapper.scrollLeft ).toBe( 0 );

		wrapper.scrollLeft = 147;
		view.unmount();
		expect( wrapper.scrollLeft ).toBe( 0 );
		wrapper.remove();
	} );
} );
