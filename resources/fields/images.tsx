import { __ } from '@wordpress/i18n';
import type { ProductField, ProductListItem, RawImage, Settings } from '../types';
import { EditableImageCell } from '../list/inline-edit/image-cell-editor';
import { firstImage } from './components/image-cell';
import { ImagesControl } from './components/images-control';
import { field } from './helpers';

function isVariationRow( item: ProductListItem ): boolean {
	return item._kind === 'variation' || item.type === 'variation';
}

function asImages( value: unknown ): RawImage[] {
	return Array.isArray( value ) ? ( value as RawImage[] ).filter( ( image ) => image && Number( image.id ) > 0 ) : [];
}

/**
 * A row's own images, as the editor works with them: a product's main image
 * then its gallery (`images`; the full gallery once the editor loaded it
 * with `wcpl_gallery`, src/Rest/Rows.php), a variation's own image only
 * (`image`; its `images` may hold the parent's image it falls back to).
 */
export function ownImages( item: ProductListItem ): RawImage[] {
	if ( isVariationRow( item ) ) {
		const image = ( item as { image?: RawImage | null } ).image;

		return image && Number( image.id ) > 0 ? [ image ] : [];
	}

	return asImages( ( item as { images?: unknown } ).images );
}

/** The write: a product's `images` (ids only, so titles and alt texts stay), a variation's `image` (`{id: 0}` removes it). */
export function writeImages( value: unknown, item: ProductListItem ): Record< string, unknown > {
	const images = asImages( value );

	if ( isVariationRow( item ) ) {
		return { image: { id: images[ 0 ]?.id ?? 0 } };
	}

	return { images: images.map( ( image ) => ( { id: image.id } ) ) };
}

export function createImagesField( _settings: Settings ): ProductField {
	return field( {
		id: 'images',
		type: 'media',
		label: __( 'Image', 'wp-woocommerce-products-list' ),
		enableSorting: false,
		filterBy: false,
		// The thumbnail opens the row's images for editing (list/inline-edit/image-cell-editor.tsx).
		render: EditableImageCell,
		getValue: ( { item } ) => firstImage( item )?.src ?? '',
		Edit: ImagesControl,
		rest: { fields: [ 'images' ], applies: { product: true, variation: true }, read: ownImages, write: writeImages },
		edit: { group: 'general', bulk: false, order: 5, label: __( 'Images', 'wp-woocommerce-products-list' ) },
	} );
}
