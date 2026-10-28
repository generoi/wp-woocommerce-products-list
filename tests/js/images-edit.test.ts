import { describe, expect, it, vi } from 'vitest';
import { describeValue } from '../../resources/edit/change-summary';
import { expectedValues } from '../../resources/edit/expect';
import { hydrateSelection } from '../../resources/edit/hydrate';
import type { HydrateDeps } from '../../resources/edit/hydrate';
import { visibleEditFields } from '../../resources/edit/visibility';
import { addImages, moveImage, replaceImage } from '../../resources/fields/components/images-editor';
import { ownImages, writeImages } from '../../resources/fields/images';
import { createCoreFields } from '../../resources/fields/registry';
import { toRawImage } from '../../resources/media/media-frame';
import type { ProductListItem, RawImage } from '../../resources/types';
import { editSettings, simple, variation } from './edit-fixtures';

const img = ( id: number ): RawImage => ( { id, src: `https://example.test/${ id }.jpg`, alt: '', name: `Image ${ id }` } );
const ids = ( list: RawImage[] ) => list.map( ( image ) => image.id );

describe( 'images editor list operations', () => {
	it( 'moves an image, the first place being the main image', () => {
		expect( ids( moveImage( [ img( 1 ), img( 2 ), img( 3 ) ], 2, 0 ) ) ).toEqual( [ 3, 1, 2 ] );
		expect( ids( moveImage( [ img( 1 ), img( 2 ), img( 3 ) ], 0, 2 ) ) ).toEqual( [ 2, 3, 1 ] );
		// Out of range or in place: the same list.
		const list = [ img( 1 ), img( 2 ) ];

		expect( moveImage( list, 1, 1 ) ).toBe( list );
		expect( moveImage( list, 0, 5 ) ).toBe( list );
	} );

	it( 'adds images once, in the order picked', () => {
		expect( ids( addImages( [ img( 1 ), img( 2 ) ], [ img( 3 ), img( 2 ), img( 4 ), img( 3 ) ] ) ) ).toEqual( [ 1, 2, 3, 4 ] );
	} );

	it( 'replaces an image in its place, a replacement already elsewhere moving there', () => {
		expect( ids( replaceImage( [ img( 1 ), img( 2 ), img( 3 ) ], 1, img( 9 ) ) ) ).toEqual( [ 1, 9, 3 ] );
		expect( ids( replaceImage( [ img( 1 ), img( 2 ), img( 3 ) ], 0, img( 3 ) ) ) ).toEqual( [ 3, 2 ] );
	} );
} );

describe( 'the images field', () => {
	it( 'reads a product’s main image and gallery, a variation’s own image only', () => {
		expect( ids( ownImages( simple( 1, { images: [ img( 5 ), img( 6 ) ] } ) ) ) ).toEqual( [ 5, 6 ] );
		// A variation row's `images` may be its parent's image; its own is `image`.
		expect( ownImages( variation( 2, 1, { image: null, images: [ img( 5 ) ] } ) ) ).toEqual( [] );
		expect( ids( ownImages( variation( 2, 1, { image: img( 7 ), images: [ img( 7 ) ] } ) ) ) ).toEqual( [ 7 ] );
	} );

	it( 'writes ids only: a product’s `images`, a variation’s `image` (id 0 removes it)', () => {
		expect( writeImages( [ img( 5 ), img( 6 ) ], simple( 1 ) ) ).toEqual( { images: [ { id: 5 }, { id: 6 } ] } );
		expect( writeImages( [], simple( 1 ) ) ).toEqual( { images: [] } );
		expect( writeImages( [ img( 7 ) ], variation( 2, 1 ) ) ).toEqual( { image: { id: 7 } } );
		expect( writeImages( [], variation( 2, 1 ) ) ).toEqual( { image: { id: 0 } } );
	} );

	it( 'is a quick-edit field for products and variations, not a bulk one', () => {
		const fields = createCoreFields( editSettings() );
		const quick = ( item: ProductListItem ) => visibleEditFields( fields, [ item ], { mode: 'quick', applyToVariations: false } ).map( ( field ) => field.id );

		expect( quick( simple( 1 ) ) ).toContain( 'images' );
		expect( quick( variation( 2, 1 ) ) ).toContain( 'images' );
		expect( visibleEditFields( fields, [ simple( 1 ), simple( 3 ) ], { mode: 'bulk', applyToVariations: false } ).map( ( field ) => field.id ) ).not.toContain( 'images' );
	} );

	it( 'is described by its count in the change summary', () => {
		const field = createCoreFields( editSettings() ).find( ( entry ) => entry.id === 'images' )!;

		expect( describeValue( field, [ img( 1 ), img( 2 ) ], editSettings() ) ).toBe( '2 images' );
		expect( describeValue( field, [], editSettings() ) ).toBe( '(empty)' );
	} );

	it( 'sends a variation’s own image as the expected value, null without one', () => {
		expect( expectedValues( variation( 2, 1, { image: img( 7 ) } ), { image: { id: 0 } } ) ).toEqual( { image: { id: 7 } } );
		expect( expectedValues( variation( 2, 1, { image: null } ), { image: { id: 9 } } ) ).toEqual( { image: null } );
	} );

	it( 'maps an attachment of the media library to the thumbnail the list shows', () => {
		expect( toRawImage( { id: 3, url: 'full.jpg', alt: 'A', title: 'T', sizes: { thumbnail: { url: 'thumb.jpg' } } } ) ).toEqual( { id: 3, src: 'thumb.jpg', alt: 'A', name: 'T' } );
		expect( toRawImage( { id: 3, url: 'full.jpg' } ).src ).toBe( 'full.jpg' );
	} );
} );

describe( 'loading images for the editor', () => {
	it( 'asks for the whole gallery of a product', async () => {
		const listProducts = vi.fn( async () => ( { items: [ simple( 1, { images: [ img( 5 ), img( 6 ) ] } ) ], total: 1, totalPages: 1 } ) );
		const deps = { listProducts, getVariations: vi.fn() } as unknown as HydrateDeps;

		await hydrateSelection( [ simple( 1, { images: [ img( 5 ) ] } ) ], [ 'id', 'images' ], deps );

		expect( ( listProducts.mock.calls as unknown[][] )[ 0 ]?.[ 0 ] ).toMatchObject( { wcpl_gallery: 1 } );
	} );

	it( 'reads a variation’s image in the edit context, its own image or none (not the parent’s)', async () => {
		const getVariationsByIds = vi.fn( async ( list: number[] ) => list.map( ( id ) => ( { id, parent_id: 1, image: null } ) ) );
		const deps = { listProducts: vi.fn(), getVariations: vi.fn(), getVariationsByIds } as unknown as HydrateDeps;
		// The list row shows the parent's image (view context).
		const row = variation( 2, 1, { image: img( 5 ), images: [ img( 5 ) ] } );

		const { items } = await hydrateSelection( [ row ], [ 'id', 'images' ], deps );

		expect( ( getVariationsByIds.mock.calls as unknown[][] )[ 0 ]?.[ 2 ] ).toMatchObject( { context: 'edit', fields: expect.arrayContaining( [ 'image' ] ) } );
		expect( ( items[ 0 ] as { image?: unknown } ).image ).toBeNull();
		expect( ownImages( items[ 0 ] as ProductListItem ) ).toEqual( [] );
	} );
} );
