/**
 * Keyboard focus around dialogs and snackbars. The core Modal returns focus
 * to the element that had it when the dialog opened, but the list re-renders
 * its rows while a dialog is up (a save patches them), so that element is
 * often gone from the document by the time the dialog closes and focus
 * lands on <body>: the next Tab walks the whole admin menu. These helpers
 * remember *where* the opener was (its row and its label) and put focus on
 * the element now at that place, else on the table itself.
 */
import { useEffect, useRef } from '@wordpress/element';

export interface FocusOrigin {
	element: Element | null;
	/** The row the opener sat in (a row action), by index in its table body. */
	rowIndex: number | null;
	label: string | null;
}

const TABLE_SELECTOR = '.dataviews-view-table, .dataviews-view-grid, .dataviews-view-list, .wc-products-list, .wc-pl-history';

function labelOf( element: Element ): string | null {
	return element.getAttribute( 'aria-label' ) || ( element as HTMLElement ).textContent?.trim() || null;
}

/** Where keyboard focus is right now, in a form that survives a re-render. */
export function captureFocusOrigin( doc: Document = document ): FocusOrigin {
	const element = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
	const row = element?.closest( 'tr' ) ?? null;
	const body = row?.parentElement;
	const rowIndex = row && body ? Array.from( body.children ).indexOf( row ) : null;

	return { element, rowIndex: rowIndex !== null && rowIndex >= 0 ? rowIndex : null, label: element ? labelOf( element ) : null };
}

function isFocusable( element: Element | null ): element is HTMLElement {
	return element instanceof HTMLElement && element.isConnected && ! ( element as HTMLButtonElement ).disabled;
}

function focusTable( doc: Document ): boolean {
	const table = doc.querySelector< HTMLElement >( TABLE_SELECTOR );

	if ( ! table ) {
		return false;
	}

	if ( ! table.hasAttribute( 'tabindex' ) ) {
		table.setAttribute( 'tabindex', '-1' );
	}

	table.focus();

	return doc.activeElement === table;
}

/**
 * Put focus back where it came from: the opener if it is still in the
 * document, else the same control in the same row (the row re-rendered),
 * else the table. Does nothing when focus already sits somewhere real.
 */
export function restoreFocus( origin: FocusOrigin | null, doc: Document = document ): boolean {
	const active = doc.activeElement;

	if ( active && active !== doc.body && ! active.closest( '.components-modal__screen-overlay' ) ) {
		return true;
	}

	if ( origin && isFocusable( origin.element ) ) {
		origin.element.focus();

		if ( doc.activeElement === origin.element ) {
			return true;
		}
	}

	if ( origin && origin.rowIndex !== null ) {
		const table = doc.querySelector( TABLE_SELECTOR );
		const row = table?.querySelector( 'tbody' )?.children[ origin.rowIndex ] ?? null;

		if ( row ) {
			const candidates = Array.from( row.querySelectorAll< HTMLElement >( 'button, a[href], input, [tabindex="0"]' ) );
			const same = origin.label ? candidates.find( ( candidate ) => labelOf( candidate ) === origin.label ) : undefined;
			const target = same ?? candidates[ candidates.length - 1 ];

			if ( target && isFocusable( target ) ) {
				target.focus();

				if ( doc.activeElement === target ) {
					return true;
				}
			}
		}
	}

	return focusTable( doc );
}

/**
 * Remember where focus was when the component mounted and put it back when
 * the component unmounts (the dialog closed), after the core Modal has had
 * its own try. For a dialog rendered by DataViews or the selection bar.
 */
export function useReturnFocus(): void {
	const originRef = useRef< FocusOrigin | null >( null );

	useEffect( () => {
		originRef.current = captureFocusOrigin();

		return () => {
			const origin = originRef.current;

			// After the Modal's own focus return (also in a cleanup) and the list's re-render.
			setTimeout( () => restoreFocus( origin ), 0 );
		};
	}, [] );
}

/**
 * Focus the first element matching `selector` under `root` (a notice, an
 * error list), giving it `tabindex=-1` so it can take focus.
 */
export function focusWithin( root: HTMLElement | null, selector: string ): boolean {
	const target = root?.querySelector< HTMLElement >( selector );

	if ( ! target ) {
		return false;
	}

	if ( ! target.hasAttribute( 'tabindex' ) ) {
		target.setAttribute( 'tabindex', '-1' );
	}

	target.focus();

	return document.activeElement === target;
}
