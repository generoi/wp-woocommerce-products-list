/**
 * DataViews hands a bulk action the selected rows it can see: the current
 * page. The Catalog's selection spans pages, so bulk actions started from
 * DataViews (the footer's "Bulk edit", a row menu on a selected row) get
 * the whole selection instead: the page's selected rows DataViews passed
 * plus the rows selected on other pages. A single-row action on a row that
 * is not the page's whole selection is left alone.
 */
import { createElement } from '@wordpress/element';
import type { RenderModalProps } from '../dataviews';
import { getItemId } from '../types';
import type { ProductAction, ProductListItem } from '../types';

export interface WholeSelection {
	/** Ids selected on the current page, in page order. */
	onPage: string[];
	/** Rows selected on other pages. */
	offPage: ProductListItem[];
}

/** `items` is the page's whole selection: extend it with the rows from other pages. */
export function extendToWholeSelection( items: ProductListItem[], whole: WholeSelection ): ProductListItem[] {
	if ( ! whole.offPage.length || items.length !== whole.onPage.length ) {
		return items;
	}

	const page = new Set( whole.onPage );

	if ( ! items.every( ( item ) => page.has( getItemId( item ) ) ) ) {
		return items;
	}

	const have = new Set( items.map( getItemId ) );

	return [ ...items, ...whole.offPage.filter( ( row ) => ! have.has( getItemId( row ) ) ) ];
}

type Labelled = string | ( ( items: ProductListItem[] ) => string );

function extendLabel( label: Labelled | undefined, extend: ( items: ProductListItem[] ) => ProductListItem[] ): Labelled | undefined {
	return typeof label === 'function' ? ( items ) => label( extend( items ) ) : label;
}

/** Wrap the bulk actions so their callback, modal and labels see the whole selection. `getWhole` is read at call time. */
export function withWholeSelection( actions: ProductAction[], getWhole: () => WholeSelection ): ProductAction[] {
	const extend = ( items: ProductListItem[] ) => extendToWholeSelection( items, getWhole() );

	return actions.map( ( action ) => {
		if ( ! action.supportsBulk ) {
			return action;
		}

		// An action whose label depends on the count (Quick edit / Bulk edit)
		// stays on its one row when called with one: DataViews' memoised
		// table rows do not re-render when the selection elsewhere changes,
		// so a widened row label would go stale, and label and result must
		// agree. The selection bar's Bulk edit covers the whole selection.
		const countLabelled = typeof action.label === 'function';
		const widen = ( items: ProductListItem[] ) => ( countLabelled && items.length === 1 ? items : extend( items ) );
		const label = extendLabel( action.label, widen ) as ProductAction[ 'label' ];

		if ( 'RenderModal' in action && action.RenderModal ) {
			const Inner = action.RenderModal;
			const RenderModal = ( props: RenderModalProps< ProductListItem > ) => createElement( Inner, { ...props, items: widen( props.items ) } );

			return {
				...action,
				label,
				modalHeader: extendLabel( action.modalHeader, widen ) as typeof action.modalHeader,
				RenderModal,
			};
		}

		if ( 'callback' in action && typeof action.callback === 'function' ) {
			const callback = action.callback;

			return {
				...action,
				label,
				callback: ( items, context ) => callback( widen( items ), context ),
			};
		}

		return action;
	} );
}
