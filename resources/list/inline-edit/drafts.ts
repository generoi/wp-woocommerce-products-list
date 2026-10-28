/**
 * What is typed into the table's cells and not saved yet, per row: a row's
 * changes are saved together (one request, one Undo) when the keyboard
 * leaves the row or Enter is pressed, so a price and its sale price typed
 * one after the other are one change, checked against each other.
 */
import { useCallback, useSyncExternalStore } from '@wordpress/element';
import { _n, sprintf } from '@wordpress/i18n';
import { notify } from '../../actions/notices';

export interface CellDraft {
	/** The value to save, in the row's stored form ('15.50', 12, 'instock'). */
	value: unknown;
	/** What the cell shows (the typed text). */
	text: string;
	/** Why the typed text is not a value (not a price, not a whole number): it stays until the text changes. */
	error?: string;
	/** Why the last save of the row did not take it (a sale price above the regular price, a taken SKU, a failed request): cleared by the next attempt. */
	problem?: string;
	/** The text the user was asked to confirm (a price ten times the old one): saved as it is on the next attempt. */
	confirmed?: string;
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

	if ( draft === undefined ? before === undefined : before && before.value === draft.value && before.text === draft.text && before.error === draft.error && before.problem === draft.problem ) {
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

/** Marks the drafts of `fieldIds` (all when omitted) with why the save did not take them, or clears that (`undefined`). */
export function flagDrafts( rowId: number, problem: string | undefined, fieldIds?: string[], confirm = false ): void {
	const row = drafts.get( rowId );

	if ( ! row ) {
		return;
	}

	let changed = false;

	for ( const [ fieldId, draft ] of row ) {
		if ( ( ! fieldIds || fieldIds.includes( fieldId ) ) && ( draft.problem !== problem || confirm ) ) {
			row.set( fieldId, { ...draft, problem, ...( confirm ? { confirmed: draft.text } : {} ) } );
			changed = true;
		}
	}

	if ( changed ) {
		emit( rowId );
	}
}

/** Drops the drafts of rows that are not among `rowIds` (they left the list: another page, a search). */
export function pruneDrafts( rowIds: ReadonlySet< number > ): number {
	let dropped = 0;

	for ( const rowId of Array.from( drafts.keys() ) ) {
		if ( ! rowIds.has( rowId ) && ! saving.has( rowId ) ) {
			dropped += drafts.get( rowId )?.size ?? 0;
			drafts.delete( rowId );
			emit( rowId );
		}
	}

	return dropped;
}

/** Drops every draft (Edit in table turned off: a change that did not save is not kept out of sight). */
export function clearAllDrafts(): number {
	let dropped = 0;

	for ( const rowId of Array.from( drafts.keys() ) ) {
		// A row saving now (its cell just left, by the click on the switch) is not dropped: its save reports itself.
		if ( saving.has( rowId ) ) {
			continue;
		}

		dropped += drafts.get( rowId )?.size ?? 0;
		drafts.delete( rowId );
		emit( rowId );
	}

	return dropped;
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

const savedWaiters = new Map< number, Array< () => void > >();

export function setRowSaving( rowId: number, value: boolean ): void {
	if ( value ) {
		saving.add( rowId );
	} else {
		saving.delete( rowId );

		const waiters = savedWaiters.get( rowId ) ?? [];

		savedWaiters.delete( rowId );
		waiters.forEach( ( resolve ) => resolve() );
	}

	emit( rowId );
}

/** Resolves when the row's save from the table is back (at once when none runs). */
export function whenRowSaved( rowId: number ): Promise< void > {
	if ( ! saving.has( rowId ) ) {
		return Promise.resolve();
	}

	return new Promise( ( resolve ) => savedWaiters.set( rowId, [ ...( savedWaiters.get( rowId ) ?? [] ), resolve ] ) );
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
	const subscribe = useCallback( ( listener: () => void ) => subscribeRow( rowId, listener ), [ rowId ] );
	const snapshot = useCallback( () => versions.get( rowId ) ?? 0, [ rowId ] );

	return useSyncExternalStore( subscribe, snapshot, () => 0 );
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

/** Says that changes which did not save were dropped (they are never kept where nothing shows them). */
export function reportDropped( count: number ): void {
	if ( count > 0 ) {
		notify.info(
			sprintf(
				/* translators: %d: number of table cells */
				_n( '%d change in the table did not save and was dropped.', '%d changes in the table did not save and were dropped.', count, 'wp-woocommerce-products-list' ),
				count
			),
			{ id: 'wc-pl-inline-dropped' }
		);
	}
}
