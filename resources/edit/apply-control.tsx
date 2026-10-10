/**
 * The "apply to variations" checkbox as the first row of the Pricing card
 * (and of a language tab's Prices card): a form-only DataForm field that
 * reads its state from the editor through a context and never calls
 * DataForm's `onChange`, so it never touches the form data, the pending
 * edits, the dirty state or the payload. Defined at module level so a
 * re-render never remounts it (and takes its focus away).
 */
import { createContext, useContext, useId } from '@wordpress/element';
import type { ReactNode } from 'react';
import type { DataFormControlProps, Field } from '../dataviews';
import { CheckboxControl } from '../ui/checkbox-control';
import type { FormData } from './bulk-numeric-control';
import { APPLY_TO_VARIATIONS_FIELD_ID, sectionNoteFieldId } from './form-layouts';

export interface ApplyControlState {
	checked: boolean;
	label: string;
	/** What ticking does, or what it will do once ticked (the loading progress). */
	note: ReactNode;
	disabled: boolean;
	onToggle: ( checked: boolean ) => void;
}

export const ApplyControlContext = createContext< ApplyControlState | null >( null );

function ApplyToVariationsControl( _props: DataFormControlProps< FormData > ) {
	const state = useContext( ApplyControlContext );
	const noteId = `wc-pl-apply-note-${ useId().replace( /:/g, '' ) }`;

	if ( ! state ) {
		return null;
	}

	return (
		<div className="wc-pl-edit__apply">
			<CheckboxControl
				__nextHasNoMarginBottom
				label={ state.label }
				checked={ state.checked }
				disabled={ state.disabled }
				aria-describedby={ state.note ? noteId : undefined }
				onChange={ state.onToggle }
			/>
			{ state.note ? (
				<div id={ noteId } className="wc-pl-edit__apply-note">
					{ state.note }
				</div>
			) : null }
		</div>
	);
}

/** The control's DataForm field (its label is the checkbox's own). */
export function applyControlField( label: string ): Field< FormData > {
	return {
		id: APPLY_TO_VARIATIONS_FIELD_ID,
		label,
		Edit: ApplyToVariationsControl,
		getValue: () => undefined,
		setValue: () => ( {} ),
	};
}

/**
 * Notes that end a section (why a stock edit is skipped and what to do instead, in Inventory), by section: shown
 * next to the fields they are about rather than below the form. Form-only, like the apply control.
 */
export const SectionNotesContext = createContext< Record< string, ReactNode > >( {} );

function sectionNoteControl( group: string ) {
	return function SectionNote( _props: DataFormControlProps< FormData > ) {
		const notes = useContext( SectionNotesContext );
		const note = notes[ group ];

		return note ? <div className="wc-pl-edit__section-note">{ note }</div> : null;
	};
}

const noteControls = new Map< string, ReturnType< typeof sectionNoteControl > >();

/** The note's DataForm field: no label of its own (the note says what it is about). */
export function sectionNoteField( group: string ): Field< FormData > {
	let Edit = noteControls.get( group );

	// One component per section for the module's life: a re-render never remounts the note (and drops focus in it).
	if ( ! Edit ) {
		Edit = sectionNoteControl( group );
		noteControls.set( group, Edit );
	}

	return {
		id: sectionNoteFieldId( group ),
		label: '',
		Edit,
		getValue: () => undefined,
		setValue: () => ( {} ),
	};
}
