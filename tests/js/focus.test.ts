import { afterEach, describe, expect, it } from 'vitest';
import { captureFocusOrigin, focusWithin, restoreFocus } from '../../resources/edit/focus';

function table( rows: number ): HTMLTableElement {
	const element = document.createElement( 'table' );

	element.className = 'dataviews-view-table';
	element.innerHTML = `<tbody>${ Array.from( { length: rows }, ( _, i ) => `<tr><td><input type="checkbox" aria-label="Select ${ i }" /></td><td><button type="button" aria-label="Quick edit">Q</button><button type="button" aria-label="Actions">A</button></td></tr>` ).join( '' ) }</tbody>`;
	document.body.appendChild( element );

	return element;
}

afterEach( () => {
	document.body.innerHTML = '';
} );

describe( 'restoreFocus', () => {
	it( 'puts focus back on the opener when it is still there', () => {
		const grid = table( 2 );
		const button = grid.querySelectorAll< HTMLButtonElement >( '[aria-label="Actions"]' )[ 1 ]!;

		button.focus();

		const origin = captureFocusOrigin();

		expect( origin.rowIndex ).toBe( 1 );
		expect( origin.label ).toBe( 'Actions' );

		( document.activeElement as HTMLElement ).blur();
		expect( document.activeElement ).toBe( document.body );

		expect( restoreFocus( origin ) ).toBe( true );
		expect( document.activeElement ).toBe( button );
	} );

	it( 'falls back to the same control in the same row after the row re-rendered, else to the table', () => {
		const grid = table( 3 );
		const old = grid.querySelectorAll< HTMLButtonElement >( '[aria-label="Actions"]' )[ 2 ]!;

		old.focus();

		const origin = captureFocusOrigin();

		// The list re-rendered: every row is a new element.
		grid.querySelector( 'tbody' )!.innerHTML = grid.querySelector( 'tbody' )!.innerHTML;
		expect( document.activeElement ).toBe( document.body );

		expect( restoreFocus( origin ) ).toBe( true );
		expect( document.activeElement ).not.toBe( old );
		expect( document.activeElement?.getAttribute( 'aria-label' ) ).toBe( 'Actions' );
		expect( document.activeElement?.closest( 'tr' ) ).toBe( grid.querySelector( 'tbody' )!.children[ 2 ] );

		// The row is gone: the table takes focus rather than <body>.
		grid.querySelector( 'tbody' )!.innerHTML = '';
		( document.activeElement as HTMLElement | null )?.blur();
		expect( restoreFocus( origin ) ).toBe( true );
		expect( document.activeElement ).toBe( grid );
	} );

	it( 'leaves focus alone when it already sits somewhere real', () => {
		const grid = table( 1 );
		const checkbox = grid.querySelector< HTMLInputElement >( 'input' )!;

		checkbox.focus();
		expect( restoreFocus( { element: null, rowIndex: null, label: null } ) ).toBe( true );
		expect( document.activeElement ).toBe( checkbox );
	} );
} );

describe( 'focusWithin', () => {
	it( 'makes the target focusable and focuses it', () => {
		const root = document.createElement( 'div' );

		root.innerHTML = '<div class="notice">Problem</div>';
		document.body.appendChild( root );

		expect( focusWithin( root, '.notice' ) ).toBe( true );
		expect( document.activeElement ).toBe( root.firstElementChild );
		expect( focusWithin( root, '.missing' ) ).toBe( false );
	} );

	it( 'after a bulk edit from the selection bar, lands on the first selected row inside the app, not on the app root', () => {
		const app = document.createElement( 'div' );

		app.className = 'wc-products-list';
		document.body.appendChild( app );

		const element = table( 3 );

		app.appendChild( element );
		( element.querySelectorAll( 'input' )[ 1 ] as HTMLInputElement ).checked = true;
		( document.activeElement as HTMLElement | null )?.blur();

		expect( restoreFocus( { element: null, rowIndex: null, label: null } ) ).toBe( true );
		expect( document.activeElement ).toBe( element.querySelectorAll( 'input' )[ 1 ] );

		( element.querySelectorAll( 'input' )[ 1 ] as HTMLInputElement ).checked = false;
		( document.activeElement as HTMLElement | null )?.blur();
		restoreFocus( null );
		expect( document.activeElement ).toBe( element );
		app.remove();
	} );
} );
