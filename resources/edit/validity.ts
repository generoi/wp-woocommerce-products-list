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
