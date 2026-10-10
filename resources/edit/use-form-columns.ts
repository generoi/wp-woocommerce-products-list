/**
 * How many columns the edit form is wide enough for, measured on the form
 * itself (the panel can be a 480 px drawer or 1500 px wide on any screen),
 * not on the viewport: two from 720 px (a 1280-1440 px laptop's default panel), else one. `narrow` (under 560 px)
 * tightens the cards' padding.
 */
import { useEffect, useLayoutEffect, useRef, useState } from '@wordpress/element';
import type { RefObject } from 'react';

export const TWO_COLUMNS_MIN_WIDTH = 720;
export const NARROW_MAX_WIDTH = 560;

export interface FormColumns {
	columns: 1 | 2;
	narrow: boolean;
}

export function formColumnsFor( width: number ): FormColumns {
	return { columns: width >= TWO_COLUMNS_MIN_WIDTH ? 2 : 1, narrow: width > 0 && width < NARROW_MAX_WIDTH };
}

export function useFormColumns( ref: RefObject< HTMLElement | null > ): FormColumns {
	const [ state, setState ] = useState< FormColumns >( { columns: 1, narrow: false } );
	const observedRef = useRef< { element: HTMLElement; observer: ResizeObserver | null } | null >( null );

	// After every render: the form's element can be replaced (a tab change, a reload), and the new one is what is measured.
	useLayoutEffect( () => {
		const element = ref.current;

		if ( observedRef.current?.element === element ) {
			return;
		}

		observedRef.current?.observer?.disconnect();
		observedRef.current = null;

		if ( ! element ) {
			return;
		}

		const update = ( width: number ) => {
			const next = formColumnsFor( width );

			setState( ( previous ) => ( previous.columns === next.columns && previous.narrow === next.narrow ? previous : next ) );
		};

		// Before the first paint, so a wide panel never shows one column first.
		update( element.getBoundingClientRect().width );

		const observer =
			typeof ResizeObserver === 'undefined'
				? null
				: new ResizeObserver( ( entries ) => {
						const entry = entries[ entries.length - 1 ];

						if ( entry ) {
							update( entry.contentRect.width );
						}
				  } );

		observer?.observe( element );
		observedRef.current = { element, observer };
	} );

	useEffect( () => () => observedRef.current?.observer?.disconnect(), [] );

	return state;
}
