import { decodeEntities } from '@wordpress/html-entities';
import type { ProductListItem, RawImage } from '../../types';

export function firstImage( item: ProductListItem ): RawImage | undefined {
	const images = ( item as { images?: RawImage[] } ).images;

	if ( Array.isArray( images ) && images.length ) {
		return images[ 0 ];
	}

	const image = ( item as { image?: RawImage | null } ).image;

	return image ?? undefined;
}

/** The media column: the first image as a thumbnail, a grey box without one. */
export function ImageCell( { item }: { item: ProductListItem } ) {
	const image = firstImage( item );

	if ( ! image?.src ) {
		return <span className="wc-products-list__image wc-products-list__image--empty" aria-hidden="true" />;
	}

	return <img className="wc-products-list__image" src={ image.src } alt={ decodeEntities( image.alt ?? '' ) } loading="lazy" decoding="async" />;
}
