/**
 * The rows the images popover loaded (a product's whole gallery, a variation's own image), reused while the list's
 * row is the same object, so opening a row again (or after the hover's prefetch) is instant.
 */
import { hydrateItems } from '../../edit/hydrate';
import type { ProductListItem } from '../../types';

/** How long a row's loaded images are reused (opening the same row again is instant). */
const GALLERY_TTL_MS = 60000;

// Keyed by the list's row object: any change the list knows of (a save, an Undo, a refetch) gives the row a new
// object, so a load made before it is never reused after it.
let galleries = new WeakMap< ProductListItem, { at: number; row: Promise< ProductListItem | undefined > } >();

/**
 * The row as the editor needs it: a product's whole gallery, a variation's own image (edit context, hydrate.ts).
 * Reused for a minute while the list's row is the same; a refused save loads it again (`fresh`).
 */
export function loadImagesRow( item: ProductListItem, fresh = false ): Promise< ProductListItem | undefined > {
	const known = galleries.get( item );

	if ( known && ! fresh && Date.now() - known.at < GALLERY_TTL_MS ) {
		return known.row;
	}

	const row = hydrateItems( [ item ], [ 'id', 'images', 'date_modified_gmt' ] ).then( ( [ loaded ] ) => loaded );

	galleries.set( item, { at: Date.now(), row } );
	row.catch( () => galleries.delete( item ) );

	return row;
}

/** Forgets every loaded row (after a save of images: the row's next load is fresh). */
export function forgetImagesRows(): void {
	galleries = new WeakMap();
}

