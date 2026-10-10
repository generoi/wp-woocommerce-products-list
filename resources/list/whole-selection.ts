/**
 * DataViews hands a bulk action the selected rows it can see: the current
 * page. The Catalog's selection spans pages, so bulk actions started from
 * DataViews (the footer's "Bulk edit", a row menu on a selected row) get
 * the whole selection instead: the page's selected rows DataViews passed
 * plus the rows selected on other pages. A single-row action on a row that
 * is not the page's whole selection is left alone.
 *
 * DataViews passes only the selected rows the action is eligible for (a
 * product already featured is not handed to "Mark as featured"), so the
 * page's whole selection is compared with its eligible rows when the
 * action has an `isEligible`.
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
	/** The selected rows on the current page (the rows behind `onPage`), to tell which of them an action is eligible for. */
	onPageRows?: ProductListItem[];
}

/** `items` is the page's whole selection (the part of it `isEligible` keeps): extend it with the rows from other pages. */
export function extendToWholeSelection( items: ProductListItem[], whole: WholeSelection, isEligible?: ( item: ProductListItem ) => boolean ): ProductListItem[] {
	const pageIds = isEligible && whole.onPageRows ? whole.onPageRows.filter( ( row ) => isEligible( row ) ).map( getItemId ) : whole.onPage;

	if ( ! whole.offPage.length || items.length === 0 || items.length !== pageIds.length ) {
		return items;
	}

	const page = new Set( pageIds );

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
	return actions.map( ( action ) => {
		if ( ! action.supportsBulk ) {
			return action;
		}

		const extend = ( items: ProductListItem[] ) => extendToWholeSelection( items, getWhole(), action.isEligible );

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
