/**
 * The editor's host side, in the main bundle: the screen describes the
 * open session as an EditorHost (the session, the rows it edits,
 * close/advance/remove, the leave guard) and `EditorHostProvider` shows
 * the editor for it in the slide-in panel beside the list
 * (editor-panel.tsx). The editor itself (inline-editor.tsx) loads as its
 * own chunk on first use.
 */
import type { ReactNode } from 'react';
import type { ProductField, ProductListItem } from '../types';
import type { EditorSession } from './editor-session';
import { EditorPanel } from './editor-panel';

/** Resolves true when the editor may close (clean, or the user discarded); false to stay. */
export type LeaveGuard = () => Promise< boolean >;

export interface EditorHost {
	session: EditorSession;
	/** The full field registry; the editor picks what applies. */
	fields: ProductField[];
	/** The edited row (quick), or the live selection (bulk). */
	items: ProductListItem[];
	/** Bulk: how many of `items` are on other pages. */
	offPageCount: number;
	/** Bulk: the selection is every product of the current list ("Select all"). */
	wholeList: boolean;
	close(): void;
	/** "Save & next": reopen on another row. */
	advance( row: ProductListItem ): void;
	/** Bulk: untick one row from the editor's list. */
	removeItem( id: number ): void;
	/** The editor installs its discard-confirm here; the screen asks it before paging, sorting, filtering or opening another editor. */
	setGuard( guard: LeaveGuard | null ): void;
	/** The editor reports a running save: the screen keeps it mounted until the save is done. Optional for older hosts. */
	setBusy?( busy: boolean ): void;
	/** Where the editor puts its heading (title, item count, loading line): the panel's pinned header. Inline when absent. */
	headerSlot?: HTMLElement | null;
}

/**
 * The list, and beside it the editor panel while a session is open. The
 * list's rows are not part of the editor: opening, switching and closing
 * it hands DataViews the same `data`, so none of them re-render.
 */
export function EditorHostProvider( { value, children }: { value: EditorHost | null; children?: ReactNode } ) {
	return (
		<>
			{ children }
			{ value ? <EditorPanel host={ value } /> : null }
		</>
	);
}

export { editorRegionLabel } from './editor-panel';
