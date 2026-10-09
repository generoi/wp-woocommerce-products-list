/**
 * The editor session the Catalog screen owns: which row a quick edit
 * edits (or that a bulk edit edits the selection), the tab to open on and
 * where keyboard focus returns when it closes. The editor itself shows in
 * the slide-in panel beside the list (editor-panel.tsx); the table's rows
 * are never touched by it.
 */
import { isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import type { FocusOrigin } from './focus';

export type EditorSession =
	| {
			mode: 'quick';
			/** The edited row's id (a product or a variation on screen). */
			id: number;
			/** The tab to open on; the last one used otherwise. */
			initialTab?: string;
			/** Where keyboard focus returns when the editor closes. */
			origin: FocusOrigin | null;
	  }
	| {
			mode: 'bulk';
			initialTab?: string;
			origin: FocusOrigin | null;
	  };

/** The row a quick edit targets, if it is on screen (placeholders never are). */
export function findEditedRow( rows: ProductListItem[], id: number ): ProductListItem | undefined {
	return rows.find( ( row ) => row.id === id && ! isPlaceholderRow( row ) );
}

/**
 * Whether a view change swaps the rows under an open editor: another page,
 * page size, search, sort or filter set. Column, density and layout
 * changes (table, grid, list) leave the rows, and the panel, as they are.
 */
export function viewChangesRows( current: ViewLike, next: ViewLike ): boolean {
	return (
		current.page !== next.page ||
		current.perPage !== next.perPage ||
		( current.search ?? '' ) !== ( next.search ?? '' ) ||
		current.sort?.field !== next.sort?.field ||
		current.sort?.direction !== next.sort?.direction ||
		JSON.stringify( current.filters ?? [] ) !== JSON.stringify( next.filters ?? [] )
	);
}

export interface ViewLike {
	type?: string;
	page?: number;
	perPage?: number;
	search?: string;
	sort?: { field?: string; direction?: string };
	filters?: unknown[];
}
