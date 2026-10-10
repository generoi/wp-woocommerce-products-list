/**
 * The rows the Catalog currently renders (parents and expanded variations,
 * placeholders excluded), published by the screen for
 * `window.wcProductsList.getItems()`. Module state, not React state: the
 * extension API exists before the screen mounts and outlives it.
 */
import { isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';

const EMPTY: ProductListItem[] = [];

let current: ProductListItem[] = EMPTY;
let visibleFieldIds: string[] = [];
const listeners = new Set< () => void >();

export function setCurrentRows( rows: ProductListItem[] ): void {
	if ( rows === current ) {
		return;
	}

	current = rows;
	listeners.forEach( ( listener ) => listener() );
}

/**
 * Be told when the rows on screen change (a parent expanded or collapsed, a
 * page loaded), for `useSyncExternalStore` with `getCurrentRowsSnapshot`.
 */
export function subscribeCurrentRows( listener: () => void ): () => void {
	listeners.add( listener );

	return () => {
		listeners.delete( listener );
	};
}

/** The rows as last published, unfiltered and stable between changes (a `useSyncExternalStore` snapshot). */
export function getCurrentRowsSnapshot(): ProductListItem[] {
	return current;
}

/** The real rows on screen, in display order (no placeholder rows). */
export function getCurrentRows(): ProductListItem[] {
	return current.filter( ( row ) => ! isPlaceholderRow( row ) );
}

/** Tests. */
export function resetCurrentRows(): void {
	setCurrentRows( EMPTY );
	visibleFieldIds = [];
}

/** The ids of the fields the view shows (columns, title, media), published by the screen for the saves. */
export function setVisibleFieldIds( ids: string[] ): void {
	visibleFieldIds = ids;
}

export function getVisibleFieldIds(): string[] {
	return visibleFieldIds;
}
