/**
 * The flat list DataViews renders: every parent, and under the expanded
 * ones their variations in server order, or a placeholder row while they
 * load, when loading failed, or for the ones beyond the cap.
 *
 * Pure: the same inputs give the same rows. Placeholder rows get a negative
 * id (the parent's, negated) so nothing keyed by post id can mistake them
 * for the parent; `getItemId` keys them as "<parent>:<kind>".
 */
import { __, _n, sprintf } from '@wordpress/i18n';
import type { PlaceholderKind, ProductListItem, ProductRow, VariationRow } from '../types/product';

export interface ChildrenState {
	status: 'idle' | 'loading' | 'loaded' | 'error';
	/** The variations loaded so far, in server order (menu_order, id). */
	items: VariationRow[];
	/** `X-WP-Total` of the first page; 0 until known. */
	total: number;
	error?: string;
}

export const EMPTY_CHILDREN: ChildrenState = Object.freeze( { status: 'idle', items: [], total: 0 } ) as ChildrenState;

export function placeholderRow( parentId: number, kind: PlaceholderKind, message: string ): ProductListItem {
	return {
		id: -parentId,
		type: 'variation',
		name: message,
		parent_id: parentId,
		_kind: 'variation',
		_level: 1,
		_parentId: parentId,
		_hasChildren: false,
		_childCount: 0,
		_placeholder: kind,
		_placeholderMessage: message,
	};
}

export function placeholderMessage( kind: PlaceholderKind, detail?: string | number ): string {
	switch ( kind ) {
		case 'loading':
			return __( 'Loading variations…', 'wp-woocommerce-products-list' );
		case 'error':
			return detail ? String( detail ) : __( 'The variations could not be loaded.', 'wp-woocommerce-products-list' );
		case 'more': {
			const count = Number( detail ) || 0;

			return sprintf(
				/* translators: %d: number of variations not shown */
				_n( '%d more variation is not shown.', '%d more variations are not shown.', count, 'wp-woocommerce-products-list' ),
				count
			);
		}
	}
}

/**
 * @param parents     The page's products, level 0, in list order.
 * @param expanded    Ids whose variations are shown.
 * @param children    Loading state per parent id; missing = not requested yet.
 * @param maxChildren `limits.maxChildrenPerParent`; the rest become one "more" row.
 */
export function flattenHierarchy(
	parents: ProductRow[],
	expanded: ReadonlySet< number >,
	children: ReadonlyMap< number, ChildrenState >,
	maxChildren: number
): ProductListItem[] {
	const rows: ProductListItem[] = [];
	const cap = maxChildren > 0 ? maxChildren : Infinity;

	for ( const parent of parents ) {
		rows.push( parent );

		if ( ! parent._hasChildren || ! expanded.has( parent.id ) ) {
			continue;
		}

		const state = children.get( parent.id ) ?? EMPTY_CHILDREN;
		const shown = state.items.length > cap ? state.items.slice( 0, cap ) : state.items;

		for ( const item of shown ) {
			rows.push( item );
		}

		switch ( state.status ) {
			case 'idle':
			case 'loading':
				rows.push( placeholderRow( parent.id, 'loading', placeholderMessage( 'loading' ) ) );
				break;
			case 'error':
				rows.push( placeholderRow( parent.id, 'error', placeholderMessage( 'error', state.error ) ) );
				break;
			case 'loaded': {
				const hidden = Math.max( state.total, state.items.length ) - shown.length;

				if ( hidden > 0 ) {
					rows.push( placeholderRow( parent.id, 'more', placeholderMessage( 'more', hidden ) ) );
				}
			}
		}
	}

	return rows;
}

/** How many rows expanding `parents` would add, for the "expand all" warning. */
export function projectedChildRows( parents: ProductRow[], children: ReadonlyMap< number, ChildrenState >, maxChildren: number ): number {
	const cap = maxChildren > 0 ? maxChildren : Infinity;
	let rows = 0;

	for ( const parent of parents ) {
		if ( ! parent._hasChildren ) {
			continue;
		}

		const state = children.get( parent.id );
		const count = state?.status === 'loaded' ? Math.max( state.total, state.items.length ) : parent._childCount;

		rows += Math.min( count, cap );
	}

	return rows;
}
