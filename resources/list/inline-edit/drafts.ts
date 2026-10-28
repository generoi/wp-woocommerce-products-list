/**
 * What is typed into the table's cells and not saved yet, per row: a row's
 * changes are saved together (one request, one Undo) when the keyboard
 * leaves the row or Enter is pressed, so a price and its sale price typed
 * one after the other are one change, checked against each other.
 */
import { useSyncExternalStore } from '@wordpress/element';

export interface CellDraft {
	/** The value to save, in the row's stored form ('15.50', 12, 'instock'). */
	value: unknown;
	/** What the cell shows (the typed text). */
	text: string;
	/** Why the value cannot be saved as it is. */
	error?: string;
}

export type RowState = 'idle' | 'saving';

const drafts = new Map< number, Map< string, CellDraft > >();
const saving = new Set< number >();
const listeners = new Map< number, Set< () => void > >();
const anyListeners = new Set< () => void >();
// Snapshots handed to React must be stable between changes.
const versions = new Map< number, number >();
let total = 0;

function emit( rowId: number ): void {
	versions.set( rowId, ( versions.get( rowId ) ?? 0 ) + 1 );
	listeners.get( rowId )?.forEach( ( listener ) => listener() );
	total = Array.from( drafts.values() ).reduce( ( sum, row ) => sum + row.size, 0 );
	anyListeners.forEach( ( listener ) => listener() );
}

export function getDraft( rowId: number, fieldId: string ): CellDraft | undefined {
	return drafts.get( rowId )?.get( fieldId );
}

export function rowDrafts( rowId: number ): ReadonlyMap< string, CellDraft > {
	return drafts.get( rowId ) ?? new Map();
}

export function setDraft( rowId: number, fieldId: string, draft: CellDraft | undefined ): void {
	const row = drafts.get( rowId ) ?? new Map< string, CellDraft >();
	const before = row.get( fieldId );

	if ( draft === undefined ? before === undefined : before && before.value === draft.value && before.text === draft.text && before.error === draft.error ) {
		return;
	}

	if ( draft === undefined ) {
		row.delete( fieldId );
	} else {
		row.set( fieldId, draft );
	}

	if ( row.size ) {
		drafts.set( rowId, row );
	} else {
		drafts.delete( rowId );
	}

	emit( rowId );
}

/** Marks the drafts of `fieldIds` (all when omitted) with an error, or clears their errors (`undefined`). */
export function flagDrafts( rowId: number, error: string | undefined, fieldIds?: string[] ): void {
	const row = drafts.get( rowId );

	if ( ! row ) {
		return;
	}

	for ( const [ fieldId, draft ] of row ) {
		if ( ! fieldIds || fieldIds.includes( fieldId ) ) {
			row.set( fieldId, { ...draft, error } );
		}
	}

	emit( rowId );
}

export function clearDrafts( rowId: number, fieldIds?: string[] ): void {
	const row = drafts.get( rowId );

	if ( ! row ) {
		return;
	}

	if ( fieldIds ) {
		fieldIds.forEach( ( id ) => row.delete( id ) );
	} else {
		row.clear();
	}

	if ( ! row.size ) {
		drafts.delete( rowId );
	}

	emit( rowId );
}

export function isRowSaving( rowId: number ): boolean {
	return saving.has( rowId );
}

export function setRowSaving( rowId: number, value: boolean ): void {
	if ( value ) {
		saving.add( rowId );
	} else {
		saving.delete( rowId );
	}

	emit( rowId );
}

/** Unsaved cells in the whole table (the leave-page guard). */
export function draftCount(): number {
	return total;
}

function subscribeRow( rowId: number, listener: () => void ): () => void {
	const set = listeners.get( rowId ) ?? new Set();

	set.add( listener );
	listeners.set( rowId, set );

	return () => {
		set.delete( listener );

		if ( ! set.size ) {
			listeners.delete( rowId );
		}
	};
}

/** Re-renders when this row's drafts or saving state change. */
export function useRowDrafts( rowId: number ): number {
	return useSyncExternalStore(
		( listener ) => subscribeRow( rowId, listener ),
		() => versions.get( rowId ) ?? 0,
		() => 0
	);
}

export function useDraftCount(): number {
	return useSyncExternalStore(
		( listener ) => {
			anyListeners.add( listener );

			return () => anyListeners.delete( listener );
		},
		draftCount,
		() => 0
	);
}

/** For tests. */
export function resetDrafts(): void {
	drafts.clear();
	saving.clear();
	versions.clear();
	total = 0;
}
