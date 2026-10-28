/**
 * "Edit in table": whether the table's cells are inputs. Off by default (the
 * list reads, and its links work, as before); the choice is remembered per
 * browser. Turning it off drops what was typed and did not save (a cell the
 * save refused): a change is never kept out of sight. The thumbnail's images
 * editor is not part of the mode: it opens from the thumbnail in every
 * layout, as it changes nothing until its own Save.
 */
import { createContext, useSyncExternalStore } from '@wordpress/element';
import type { ProductField, Settings } from '../../types';
import { clearAllDrafts, reportDropped } from './drafts';

const STORAGE_KEY = 'wc-products-list:inline-editing';

const listeners = new Set< () => void >();

function read(): boolean {
	try {
		return window.localStorage.getItem( STORAGE_KEY ) === '1';
	} catch {
		return false;
	}
}

let enabled: boolean | null = null;

export function isInlineEditing(): boolean {
	enabled ??= read();

	return enabled;
}

export function setInlineEditing( next: boolean ): void {
	enabled = next;

	if ( ! next ) {
		reportDropped( clearAllDrafts() );
	}

	try {
		window.localStorage.setItem( STORAGE_KEY, next ? '1' : '0' );
	} catch {
		// Private windows and blocked storage: the choice lasts for this page.
	}

	listeners.forEach( ( listener ) => listener() );
}

function subscribe( listener: () => void ): () => void {
	listeners.add( listener );

	return () => listeners.delete( listener );
}

export function useInlineEditing(): boolean {
	return useSyncExternalStore( subscribe, isInlineEditing, () => false );
}

/** For tests. */
export function resetInlineEditing(): void {
	enabled = null;
}

/** What the table's cells need to edit and save: every field (a cell may write one that is not a column) and the settings. */
export interface InlineEditValue {
	/** Edit in table is on (the cells are inputs); the thumbnail's images editor works either way. */
	enabled: boolean;
	fields: ProductField[];
	byId: ReadonlyMap< string, ProductField >;
	settings: Settings;
}

export const InlineEditContext = createContext< InlineEditValue | null >( null );
