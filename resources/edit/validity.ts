/**
 * Reading DataForm's validity tree: which fields are invalid and why, so the
 * modal can name them (and their tab) instead of "fix the highlighted
 * fields" when nothing is highlighted, and reveal the browser-level
 * messages the validated controls keep hidden until an `invalid` event.
 */
import { __ } from '@wordpress/i18n';

type Rule = { type?: string; message?: string } | undefined;

/** DataForm's `FormValidity`: field id → rules, groups nest under `children`. */
export type ValidityTree = Record< string, Record< string, unknown > | undefined > | undefined;

export interface InvalidField {
	field: string;
	message: string;
}

function ruleMessage( key: string, rule: Rule ): string {
	if ( rule?.message ) {
		return rule.message;
	}

	switch ( key ) {
		case 'required':
			return __( 'This field is required.', 'wp-woocommerce-products-list' );
		case 'elements':
			return __( 'Pick one of the options.', 'wp-woocommerce-products-list' );
		default:
			return __( 'This value is not valid.', 'wp-woocommerce-products-list' );
	}
}

/** The subset of a DataForm field a synchronous check reads. */
export interface ValidatedField {
	id: string;
	label?: string;
	isValid?: {
		required?: boolean;
		elements?: boolean;
		custom?: ( item: Record< string, unknown >, field: unknown ) => unknown;
	};
	elements?: Array< { value: unknown } >;
	getElements?: unknown;
	isVisible?: ( item: Record< string, unknown > ) => boolean;
	getValue?: ( args: { item: Record< string, unknown > } ) => unknown;
}

function isEmpty( value: unknown ): boolean {
	return value === undefined || value === null || value === '' || ( Array.isArray( value ) && value.length === 0 );
}

/**
 * The form's rules applied to the record *now*: DataForm validates in an
 * effect after each change and only the fields that changed, so at the
 * moment Save is pressed its tree can still name a field that was just
 * fixed and miss one that was just broken. This runs the same `required`,
 * `elements` and (synchronous) `custom` rules against the current values.
 */
export function validateFormData( data: Record< string, unknown >, fields: ValidatedField[] ): InvalidField[] {
	const result: InvalidField[] = [];

	for ( const field of fields ) {
		if ( ! field.isValid ) {
			continue;
		}

		if ( typeof field.isVisible === 'function' && ! field.isVisible( data ) ) {
			continue;
		}

		const value = field.getValue ? field.getValue( { item: data } ) : data[ field.id ];

		if ( field.isValid.required && isEmpty( value ) ) {
			result.push( { field: field.id, message: ruleMessage( 'required', undefined ) } );
			continue;
		}

		if ( field.isValid.elements && Array.isArray( field.elements ) && ! isEmpty( value ) && ! field.elements.some( ( element ) => element.value === value ) ) {
			result.push( { field: field.id, message: ruleMessage( 'elements', undefined ) } );
			continue;
		}

		if ( typeof field.isValid.custom === 'function' ) {
			let message: unknown;

			try {
				message = field.isValid.custom( data, field );
			} catch {
				message = null;
			}

			// A promise is an async rule DataForm resolves on its own; only a settled message counts here.
			if ( typeof message === 'string' && message !== '' ) {
				result.push( { field: field.id, message } );
			}
		}
	}

	return result;
}

/** Every invalid field in the tree, outermost first; `validating` entries are skipped. */
export function collectInvalidFields( validity: ValidityTree ): InvalidField[] {
	const result: InvalidField[] = [];

	if ( ! validity ) {
		return result;
	}

	for ( const [ id, entry ] of Object.entries( validity ) ) {
		if ( ! entry ) {
			continue;
		}

		const children = entry.children as ValidityTree;

		if ( children && typeof children === 'object' ) {
			result.push( ...collectInvalidFields( children ) );
		}

		for ( const [ key, rule ] of Object.entries( entry ) ) {
			if ( key === 'children' ) {
				continue;
			}

			const typed = rule as Rule;

			if ( typed?.type === 'invalid' ) {
				result.push( { field: id, message: ruleMessage( key, typed ) } );
				break;
			}
		}
	}

	return result;
}

/**
 * Fire `invalid` on every control the browser considers invalid, which is
 * what DataForm's validated controls listen for to show their message.
 * Returns how many were revealed.
 */
export function revealInvalidControls( root: HTMLElement | null ): number {
	if ( ! root ) {
		return 0;
	}

	let revealed = 0;

	root.querySelectorAll< HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement >( 'input, select, textarea' ).forEach( ( control ) => {
		if ( control.willValidate && ! control.validity.valid ) {
			revealed += 1;
			control.dispatchEvent( new Event( 'invalid', { cancelable: true } ) );
		}
	} );

	return revealed;
}

/**
 * The first control the user has to fix: one flagged invalid by its
 * control (`aria-invalid`, an `is-invalid` wrapper) or by the browser.
 */
export function firstInvalidControl( root: HTMLElement | null ): HTMLElement | null {
	if ( ! root ) {
		return null;
	}

	const flagged = root.querySelector< HTMLElement >( '[aria-invalid="true"], .is-invalid input, .is-invalid select, .is-invalid textarea' );

	if ( flagged ) {
		return flagged;
	}

	for ( const control of Array.from( root.querySelectorAll< HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement >( 'input, select, textarea' ) ) ) {
		if ( control.willValidate && ! control.validity.valid ) {
			return control;
		}
	}

	return null;
}

/** Move keyboard focus to the first invalid control; true when one was found. */
export function focusFirstInvalidControl( root: HTMLElement | null ): boolean {
	const control = firstInvalidControl( root );

	if ( ! control ) {
		return false;
	}

	focusControl( control );

	return true;
}

const CONTROL_SELECTOR = 'input:not([type="hidden"]), select, textarea';

function normalizeLabel( text: string | null | undefined ): string {
	return ( text ?? '' ).replace( /\s*\((?:required|optional)\)\s*$/i, '' ).replace( /\s*\*\s*$/, '' ).replace( /\s+/g, ' ' ).trim().toLowerCase();
}

/**
 * The control a field renders, found by its label: DataForm generates the
 * ids, so the label is the stable handle. A `<label for>` first, then a
 * control named by `aria-label` ("Regular price: operation" for the bulk
 * numeric control).
 */
export function controlForField( root: HTMLElement | null, label: string ): HTMLElement | null {
	if ( ! root || ! label ) {
		return null;
	}

	const wanted = normalizeLabel( label );

	for ( const element of Array.from( root.querySelectorAll< HTMLLabelElement >( 'label' ) ) ) {
		if ( normalizeLabel( element.textContent ) !== wanted ) {
			continue;
		}

		const target = element.htmlFor ? root.ownerDocument.getElementById( element.htmlFor ) : element.querySelector< HTMLElement >( CONTROL_SELECTOR );

		if ( target && root.contains( target ) ) {
			return target.matches( CONTROL_SELECTOR ) ? target : target.querySelector< HTMLElement >( CONTROL_SELECTOR ) ?? target;
		}
	}

	for ( const element of Array.from( root.querySelectorAll< HTMLElement >( CONTROL_SELECTOR ) ) ) {
		const name = normalizeLabel( element.getAttribute( 'aria-label' ) );

		if ( name === wanted || name.startsWith( `${ wanted }:` ) ) {
			return element;
		}
	}

	return null;
}

/** The marker the editor puts on controls it flagged itself (removed again on the next change). */
export const FLAGGED_ATTRIBUTE = 'data-wc-pl-invalid';

const OWN_INVALID_ATTRIBUTE = 'data-wc-pl-own-invalid';

/** The id of the (visually hidden) message the editor renders for an invalid field. */
export function invalidMessageId( fieldId: string ): string {
	return `wc-pl-invalid-${ fieldId.replace( /[^a-z0-9_-]+/gi, '-' ) }`;
}

/**
 * Flag the controls of `fields` as invalid for assistive technology
 * (`aria-invalid`, described by the editor's message for the field),
 * whatever the control itself does; returns the controls in the order given.
 */
export function flagInvalidControls( root: HTMLElement | null, fields: Array< { field: string; label: string } > ): HTMLElement[] {
	clearFlaggedControls( root );

	const controls: HTMLElement[] = [];

	for ( const entry of fields ) {
		const control = controlForField( root, entry.label );

		if ( ! control ) {
			continue;
		}

		const messageId = invalidMessageId( entry.field );
		const described = ( control.getAttribute( 'aria-describedby' ) ?? '' ).split( /\s+/ ).filter( Boolean );

		// A control that flags itself keeps doing so; only ours is taken off again.
		if ( control.getAttribute( 'aria-invalid' ) === 'true' && ! control.hasAttribute( FLAGGED_ATTRIBUTE ) ) {
			control.setAttribute( OWN_INVALID_ATTRIBUTE, 'true' );
		}

		control.setAttribute( 'aria-invalid', 'true' );
		control.setAttribute( FLAGGED_ATTRIBUTE, messageId );

		if ( ! described.includes( messageId ) ) {
			control.setAttribute( 'aria-describedby', [ ...described, messageId ].join( ' ' ) );
		}

		controls.push( control );
	}

	return controls;
}

/** Undo `flagInvalidControls`. */
export function clearFlaggedControls( root: HTMLElement | null ): void {
	root?.querySelectorAll( `[${ FLAGGED_ATTRIBUTE }]` ).forEach( ( control ) => {
		const messageId = control.getAttribute( FLAGGED_ATTRIBUTE );
		const rest = ( control.getAttribute( 'aria-describedby' ) ?? '' ).split( /\s+/ ).filter( ( id ) => id && id !== messageId );

		if ( rest.length ) {
			control.setAttribute( 'aria-describedby', rest.join( ' ' ) );
		} else {
			control.removeAttribute( 'aria-describedby' );
		}

		control.removeAttribute( FLAGGED_ATTRIBUTE );

		if ( control.hasAttribute( OWN_INVALID_ATTRIBUTE ) ) {
			control.removeAttribute( OWN_INVALID_ATTRIBUTE );
		} else {
			control.removeAttribute( 'aria-invalid' );
		}
	} );
}

/** Focus a control and bring it into view without scrolling the table sideways. */
export function focusControl( control: HTMLElement | null ): boolean {
	if ( ! control ) {
		return false;
	}

	control.focus( { preventScroll: true } );

	if ( typeof control.scrollIntoView === 'function' ) {
		control.scrollIntoView( { block: 'center', inline: 'nearest' } );
	}

	return control.ownerDocument.activeElement === control;
}
