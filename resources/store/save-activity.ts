/**
 * Saves in flight, for the list: a bulk update keeps running when its
 * editor panel is closed, so the list shows the progress itself and marks
 * the rows that are not written yet (they cannot be edited until they are).
 */
import { useSyncExternalStore } from '@wordpress/element';

interface Job {
	done: number;
	total: number;
	startedAt: number;
	/** Rows not written yet: products, variations and the parents of variations being written. */
	pending: Set< number >;
}

export interface SaveActivity {
	done: number;
	total: number;
	startedAt: number;
	jobs: number;
}

const jobs = new Map< number, Job >();
const listeners = new Set< () => void >();
let nextId = 1;
let snapshot: SaveActivity | null = null;

/**
 * The update runs in this tab: leaving the page stops the requests not sent yet. While a save is in flight the
 * browser asks before the page is left (reload, another admin page, closing the tab).
 */
function warnOnLeave( event: BeforeUnloadEvent ): string {
	event.preventDefault();
	// Older browsers show (or require) a return value; modern ones show their own text.
	event.returnValue = '';

	return '';
}

let leaveGuarded = false;

function guardLeaving( active: boolean ): void {
	if ( typeof window === 'undefined' || active === leaveGuarded ) {
		return;
	}

	leaveGuarded = active;

	if ( active ) {
		window.addEventListener( 'beforeunload', warnOnLeave );
	} else {
		window.removeEventListener( 'beforeunload', warnOnLeave );
	}
}

function emit(): void {
	let done = 0;
	let total = 0;
	let startedAt = Number.POSITIVE_INFINITY;

	jobs.forEach( ( job ) => {
		done += job.done;
		total += job.total;
		startedAt = Math.min( startedAt, job.startedAt );
	} );
	snapshot = jobs.size ? { done, total, startedAt, jobs: jobs.size } : null;
	guardLeaving( jobs.size > 0 );
	listeners.forEach( ( listener ) => listener() );
}

function subscribe( listener: () => void ): () => void {
	listeners.add( listener );

	return () => listeners.delete( listener );
}

/** Register a save; returns its id for the updates. */
export function startSaveJob( pendingIds: Iterable< number > ): number {
	const id = nextId++;

	jobs.set( id, { done: 0, total: 0, startedAt: Date.now(), pending: new Set( pendingIds ) } );
	emit();

	return id;
}

export function updateSaveJob( id: number, done: number, total: number ): void {
	const job = jobs.get( id );

	if ( job ) {
		job.done = done;
		job.total = total;
		emit();
	}
}

/** These rows are written: they are editable again. */
export function markRowsSaved( id: number, rowIds: Iterable< number > ): void {
	const job = jobs.get( id );

	if ( ! job ) {
		return;
	}

	let changed = false;

	for ( const rowId of rowIds ) {
		changed = job.pending.delete( rowId ) || changed;
	}

	if ( changed ) {
		emit();
	}
}

export function finishSaveJob( id: number ): void {
	if ( jobs.delete( id ) ) {
		emit();
	}
}

/** Whether a row (or its parent) is still waiting to be written by a save in flight. */
export function isRowPending( rowId: number | undefined | null ): boolean {
	if ( ! rowId ) {
		return false;
	}

	for ( const job of jobs.values() ) {
		if ( job.pending.has( rowId ) ) {
			return true;
		}
	}

	return false;
}

export function useSaveActivity(): SaveActivity | null {
	return useSyncExternalStore( subscribe, () => snapshot, () => null );
}

/** Re-renders only when this row's pending state flips. */
export function useRowPending( rowId: number | undefined | null, parentId?: number | null ): boolean {
	return useSyncExternalStore(
		subscribe,
		() => isRowPending( rowId ) || isRowPending( parentId ),
		() => false
	);
}
