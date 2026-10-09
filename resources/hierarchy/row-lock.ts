/**
 * Keyboard and assistive-technology side of a row lock: while a save in
 * flight has not finished a row, its checkbox, buttons and links leave the
 * tab order and are disabled, and the row says it is busy. The mouse side
 * is CSS (style.scss, `pointer-events: none`); the actions themselves skip
 * locked rows too (actions/context.ts). A UX guard for this tab only.
 */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

interface Touched {
	element: HTMLElement;
	tabindex: string | null;
	disabled?: boolean;
}

/** Lock the row's controls (all but those inside `keep`); returns the unlock. */
export function lockRowControls( row: HTMLElement, keep?: Element | null ): () => void {
	const busy = row.getAttribute( 'aria-busy' );
	const ariaDisabled = row.getAttribute( 'aria-disabled' );
	const touched: Touched[] = [];

	row.setAttribute( 'aria-busy', 'true' );
	row.setAttribute( 'aria-disabled', 'true' );

	row.querySelectorAll< HTMLElement >( FOCUSABLE ).forEach( ( element ) => {
		if ( keep?.contains( element ) ) {
			return;
		}

		const disableable = element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;

		touched.push( { element, tabindex: element.getAttribute( 'tabindex' ), ...( disableable ? { disabled: element.disabled } : {} ) } );
		element.setAttribute( 'tabindex', '-1' );

		if ( disableable ) {
			element.disabled = true;
		}
	} );

	return () => {
		restore( row, 'aria-busy', busy );
		restore( row, 'aria-disabled', ariaDisabled );

		for ( const { element, tabindex, disabled } of touched ) {
			restore( element, 'tabindex', tabindex );

			if ( disabled !== undefined ) {
				( element as HTMLInputElement ).disabled = disabled;
			}
		}
	};
}

function restore( element: HTMLElement, name: string, value: string | null ): void {
	if ( value === null ) {
		element.removeAttribute( name );
	} else {
		element.setAttribute( name, value );
	}
}
