import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from '@wordpress/element';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImagesEditor } from '../../resources/fields/components/images-editor';
import { setSettings } from '../../resources/settings';
import type { RawImage } from '../../resources/types';
import { sampleSettings } from './settings.test';

const img = ( id: number ): RawImage => ( { id, src: `https://example.test/${ id }.jpg`, alt: '', name: `Image ${ id }` } );

function Harness( { initial, single = false }: { initial: RawImage[]; single?: boolean } ) {
	const [ images, setImages ] = useState( initial );

	return (
		<>
			<ImagesEditor value={ images } onChange={ setImages } single={ single } />
			<output data-testid="ids">{ images.map( ( image ) => image.id ).join( ',' ) }</output>
		</>
	);
}

const ids = () => screen.getByTestId( 'ids' ).textContent;

describe( 'ImagesEditor', () => {
	beforeEach( () => setSettings( sampleSettings() ) );
	afterEach( () => setSettings( undefined ) );

	it( 'has Replace and Remove on the main image, the options menu and × on the gallery’s', () => {
		render( <Harness initial={ [ img( 1 ), img( 2 ), img( 3 ) ] } /> );

		expect( screen.getByRole( 'button', { name: 'Replace Main image: Image 1' } ) ).toHaveTextContent( 'Replace' );
		expect( screen.getByRole( 'button', { name: 'Remove Main image: Image 1' } ) ).toHaveTextContent( 'Remove' );
		expect( screen.queryByRole( 'button', { name: /^Options for Main image/ } ) ).toBeNull();
		expect( screen.getByRole( 'button', { name: 'Options for Gallery image 1: Image 2' } ) ).toBeInTheDocument();
		expect( screen.getByRole( 'button', { name: 'Remove Gallery image 2: Image 3' } ) ).toBeInTheDocument();
	} );

	it( 'offers Remove only where the user may not upload (no media library to replace from)', () => {
		const settings = sampleSettings();

		setSettings( { ...settings, caps: { ...settings.caps, upload: false } } );
		render( <Harness initial={ [ img( 1 ), img( 2 ) ] } /> );

		expect( screen.queryByRole( 'button', { name: /^Replace/ } ) ).toBeNull();
		expect( screen.getByRole( 'button', { name: 'Remove Main image: Image 1' } ) ).toBeInTheDocument();
	} );

	it( 'makes the next image the main one when the main one is removed, the focus on its first button', async () => {
		render( <Harness initial={ [ img( 1 ), img( 2 ), img( 3 ) ] } /> );

		fireEvent.click( screen.getByRole( 'button', { name: 'Remove Main image: Image 1' } ) );

		expect( ids() ).toBe( '2,3' );
		await waitFor( () => expect( document.activeElement ).toBe( screen.getByRole( 'button', { name: 'Replace Main image: Image 2' } ) ) );
	} );

	it( 'gives a variation’s one image the same Replace and Remove', () => {
		render( <Harness initial={ [ img( 7 ) ] } single /> );

		expect( screen.getByRole( 'button', { name: 'Replace Main image: Image 7' } ) ).toBeInTheDocument();
		fireEvent.click( screen.getByRole( 'button', { name: 'Remove Main image: Image 7' } ) );
		expect( ids() ).toBe( '' );
		expect( screen.getByRole( 'button', { name: 'Set image' } ) ).toBeInTheDocument();
	} );
} );
