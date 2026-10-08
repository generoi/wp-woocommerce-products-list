/**
 * Local edit state for the modal: the merged base record plus the edits
 * layered on top. Nothing leaves the component until Save; Cancel discards.
 */
import { useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import type { ProductField, ProductListItem } from '../types';
import { isNumericOp, isPendingOp } from './bulk-numeric';
import { normalizeForCompare } from './field-value';
import { mergeItems, MIXED_VALUE } from './merge';
import type { MixedState } from './merge';

export interface EditState {
	/** The record the form renders: merged values with the edits applied. */
	data: Record< string, unknown >;
	/** Only what the user changed, keyed by field id. */
	edits: Record< string, unknown >;
	mixed: Record< string, MixedState >;
	setField( id: string, value: unknown ): void;
	setFields( partial: Record< string, unknown > ): void;
	reset(): void;
	isDirty: boolean;
	/** The user changed something, even if it equals the current value. */
	hasInput: boolean;
}

/** Drop edits that do not change anything: unset values and idle numeric ops. */
export function effectiveEdits( edits: Record< string, unknown >, base: Record< string, unknown >, mixed: Record< string, MixedState > ): Record< string, unknown > {
	const result: Record< string, unknown > = {};

	for ( const [ id, value ] of Object.entries( edits ) ) {
		if ( value === undefined || value === MIXED_VALUE ) {
			continue;
		}

		if ( isNumericOp( value ) ) {
			if ( isPendingOp( value ) ) {
				result[ id ] = value;
			}

			continue;
		}

		if ( ! mixed[ id ]?.isMixed && normalizeForCompare( base[ id ] ) === normalizeForCompare( value ) ) {
			continue;
		}

		result[ id ] = value;
	}

	return result;
}

const NO_EDITS: Record< string, unknown > = {};

/**
 * @param resetKey Identifies the selection the edits belong to; when it
 *                 changes (the modal is reused for other rows) the edits are
 *                 dropped, so nothing typed for one product reaches another.
 */
export function useEditState( items: ProductListItem[], fields: ProductField[], resetKey = '' ): EditState {
	const merged = useMemo( () => mergeItems( items, fields ), [ items, fields ] );
	const [ rawEdits, setRawEdits ] = useState< Record< string, unknown > >( {} );
	const [ lastKey, setLastKey ] = useState( resetKey );

	useEffect( () => {
		if ( lastKey !== resetKey ) {
			setLastKey( resetKey );
			setRawEdits( {} );
		}
	}, [ resetKey, lastKey ] );

	// Edits typed for another selection are gone on the next render; until then they are not this selection's.
	const current = lastKey === resetKey ? rawEdits : NO_EDITS;
	const edits = useMemo( () => effectiveEdits( current, merged.data, merged.mixed ), [ current, merged ] );
	const data = useMemo( () => ( { ...merged.data, ...current } ), [ merged.data, current ] );

	const setField = useCallback( ( id: string, value: unknown ) => {
		setRawEdits( ( previous ) => ( { ...previous, [ id ]: value } ) );
	}, [] );

	const setFields = useCallback( ( partial: Record< string, unknown > ) => {
		setRawEdits( ( previous ) => ( { ...previous, ...partial } ) );
	}, [] );

	const reset = useCallback( () => setRawEdits( {} ), [] );

	return {
		data,
		edits,
		mixed: merged.mixed,
		setField,
		setFields,
		reset,
		isDirty: Object.keys( edits ).length > 0,
		hasInput: Object.keys( current ).length > 0,
	};
}
