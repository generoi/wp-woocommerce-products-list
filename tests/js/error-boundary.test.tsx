import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, guardCell, isChunkLoadError } from '../../resources/ui/error-boundary';

let shouldThrow = true;

function Boom( { error }: { error: Error } ): null {
	if ( shouldThrow ) {
		throw error;
	}

	return null;
}

describe( 'ErrorBoundary', () => {
	let consoleError: ReturnType< typeof vi.spyOn >;

	beforeEach( () => {
		shouldThrow = true;
		consoleError = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
	} );

	afterEach( () => {
		consoleError.mockRestore();
	} );

	it( 'recognises webpack chunk load errors', () => {
		expect( isChunkLoadError( Object.assign( new Error( 'Loading chunk 739 failed.' ), { name: 'ChunkLoadError' } ) ) ).toBe( true );
		expect( isChunkLoadError( new Error( 'Loading chunk edit failed. (timeout: x)' ) ) ).toBe( true );
		expect( isChunkLoadError( new Error( 'nope' ) ) ).toBe( false );
		expect( isChunkLoadError( 'Loading chunk 1 failed' ) ).toBe( false );
	} );

	it( 'keeps siblings rendered, logs with the prefix and retries a render error', () => {
		render(
			<div>
				<p>The list</p>
				<ErrorBoundary context="editor">
					<Boom error={ new Error( 'render failed' ) } />
				</ErrorBoundary>
			</div>
		);

		expect( screen.getByText( 'The list' ) ).toBeTruthy();
		expect( document.querySelector( '.wc-products-list__boundary' )?.textContent ).toMatch( /Something went wrong/ );
		expect( consoleError ).toHaveBeenCalledWith( '[wc-products-list] editor', expect.any( Error ) );

		shouldThrow = false;
		fireEvent.click( screen.getByRole( 'button', { name: 'Try again' } ) );
		expect( document.querySelector( '.wc-products-list__boundary' ) ).toBeNull();
	} );

	it( 'offers a reload for a chunk that did not load', () => {
		render(
			<ErrorBoundary context="history">
				<Boom error={ Object.assign( new Error( 'Loading chunk 739 failed.' ), { name: 'ChunkLoadError' } ) } />
			</ErrorBoundary>
		);

		expect( screen.getByRole( 'button', { name: 'Reload the page' } ) ).toBeTruthy();
	} );

	it( 'guardCell turns a throwing cell into a dash and is stable per renderer', () => {
		const Cell = () => {
			throw new Error( 'extension bug' );
		};
		const Guarded = guardCell( Cell, 'field x' );

		expect( guardCell( Cell, 'field x' ) ).toBe( Guarded );

		const { container } = render(
			<div>
				<Guarded />
				<span>other cell</span>
			</div>
		);

		expect( container.querySelector( '.wc-products-list-field--error' )?.textContent ).toBe( '—' );
		expect( screen.getByText( 'other cell' ) ).toBeTruthy();
	} );
} );
