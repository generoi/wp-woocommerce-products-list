/**
 * Where the inline editor sits in the table. DataViews 20 renders exactly
 * one `<tr>` per item of `data` and has no row-render override, so the
 * editor is an item like any other: a synthetic row (`_kind: 'editor'`)
 * that the screen splices into the flattened hierarchy rows. A quick edit
 * takes the place of the row it edits (WooCommerce's `tr.inline-edit-row`),
 * the bulk editor goes first. The name field renders the editor into that
 * row's cell, every other field renders nothing for it, and the cell spans
 * the row (editor-context.tsx).
 *
 * Pure: the same rows and session give the same list; the editor item is
 * built once per call so the screen memoises on (rows, session).
 */
import { isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import type { FocusOrigin } from './focus';

/** The editor row's `id`: not a post id, and no post id can be it. */
export const EDITOR_ROW_ID = -2147483647;

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
	return rows.find( ( row ) => row.id === id && ! isPlaceholderRow( row ) && row._kind !== 'editor' );
}

/**
 * The editor item for a session, placed at the edited row's level (a
 * variation's quick edit keeps its indentation), or null for a quick edit
 * whose row is not in `rows` (it paged or filtered away: the screen then
 * closes the session).
 */
export function editorRow( session: EditorSession, rows: ProductListItem[] ): ProductListItem | null {
	if ( session.mode === 'bulk' ) {
		return {
			id: EDITOR_ROW_ID,
			name: '',
			_kind: 'editor',
			_level: 0,
			_parentId: null,
			_hasChildren: false,
			_childCount: 0,
			_editor: { mode: 'bulk', targetId: null },
		};
	}

	const target = findEditedRow( rows, session.id );

	if ( ! target ) {
		return null;
	}

	return {
		id: EDITOR_ROW_ID,
		name: '',
		_kind: 'editor',
		_level: target._level,
		_parentId: target._parentId,
		_hasChildren: false,
		_childCount: 0,
		_editor: { mode: 'quick', targetId: target.id },
	};
}

/** `rows` with the editor row spliced in: in place of the edited row, or first for the bulk editor. */
export function withEditorRow( rows: ProductListItem[], session: EditorSession | null ): ProductListItem[] {
	if ( ! session ) {
		return rows;
	}

	const editor = editorRow( session, rows );

	if ( ! editor ) {
		return rows;
	}

	if ( session.mode === 'bulk' ) {
		return [ editor, ...rows ];
	}

	return rows.map( ( row ) => ( row.id === session.id && ! isPlaceholderRow( row ) ? editor : row ) );
}

/**
 * Whether a view change swaps the rows under an open editor: another page,
 * page size, search, sort or filter set. Column, density and layout changes
 * leave the rows (and the editor) where they are.
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
	page?: number;
	perPage?: number;
	search?: string;
	sort?: { field?: string; direction?: string };
	filters?: unknown[];
}
