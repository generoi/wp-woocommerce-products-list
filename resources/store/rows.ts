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

export function setCurrentRows( rows: ProductListItem[] ): void {
	current = rows;
}

/** The real rows on screen, in display order (no placeholder rows). */
export function getCurrentRows(): ProductListItem[] {
	return current.filter( ( row ) => ! isPlaceholderRow( row ) );
}

/** Tests. */
export function resetCurrentRows(): void {
	current = EMPTY;
	visibleFieldIds = [];
}

/** The ids of the fields the view shows (columns, title, media), published by the screen for the saves. */
export function setVisibleFieldIds( ids: string[] ): void {
	visibleFieldIds = ids;
}

export function getVisibleFieldIds(): string[] {
	return visibleFieldIds;
}
