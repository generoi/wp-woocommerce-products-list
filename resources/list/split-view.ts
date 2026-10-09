/**
 * The table beside the open editor panel (split view): the columns a store
 * manager checks the edited rows by (name, SKU, price, stock and the
 * translation columns) stay readable. The lower-value columns (dates, type,
 * terms, status) are left out while the panel is open, SKU, price and stock
 * move up next to the name, and the name column stops taking half the
 * narrowed table. Only the view handed to DataViews changes; the saved view
 * (and the full column set once the panel closes) does not.
 */
import type { View } from '../dataviews';

/** Columns hidden while the panel is open, when the table is a table. */
export const SPLIT_HIDDEN_FIELDS: readonly string[] = [ 'date_created', 'date_modified', 'type', 'categories', 'tags', 'brands', 'status' ];

/** Columns moved right after the name while the panel is open, in this order. */
export const SPLIT_KEY_FIELDS: readonly string[] = [ 'sku', 'price', 'stock_status' ];

/** The name column's width in split view (it otherwise takes what the other columns leave). */
export const SPLIT_NAME_STYLE = { minWidth: 200, maxWidth: 280 };

/** The visible columns in split view: key columns first, then the rest without the hidden ones. */
export function splitViewFields( fields: readonly string[] ): string[] {
	const key = SPLIT_KEY_FIELDS.filter( ( id ) => fields.includes( id ) );
	const rest = fields.filter( ( id ) => ! SPLIT_KEY_FIELDS.includes( id ) && ! SPLIT_HIDDEN_FIELDS.includes( id ) );

	return [ ...key, ...rest ];
}

/** The view DataViews shows while the panel is open (a table only; grid and list are left as they are). */
export function toSplitView< V extends View >( view: V ): V {
	if ( view.type !== 'table' ) {
		return view;
	}

	const layout = ( view as { layout?: { styles?: Record< string, object > } } ).layout ?? {};

	return {
		...view,
		fields: splitViewFields( view.fields ?? [] ),
		layout: { ...layout, styles: { ...( layout.styles ?? {} ), name: { ...( layout.styles?.name ?? {} ), ...SPLIT_NAME_STYLE } } },
	} as V;
}

/**
 * A view change DataViews made on the split view, applied to the saved view:
 * the columns it left out stay as they were, a column the user hid or added
 * meanwhile is hidden or added, and the column widths stay the saved ones.
 */
export function fromSplitView< V extends View >( next: V, saved: V ): V {
	if ( next.type !== 'table' || saved.type !== 'table' ) {
		return next;
	}

	const shown = splitViewFields( saved.fields ?? [] );
	const nextFields = next.fields ?? [];
	const unchanged = shown.length === nextFields.length && shown.every( ( id, index ) => nextFields[ index ] === id );
	const fields = unchanged
		? saved.fields
		: [ ...( saved.fields ?? [] ).filter( ( id ) => ! shown.includes( id ) || nextFields.includes( id ) ), ...nextFields.filter( ( id ) => ! ( saved.fields ?? [] ).includes( id ) ) ];
	const savedLayout = ( saved as { layout?: { styles?: object } } ).layout;
	const { styles: _shownStyles, ...nextLayout } = ( next as { layout?: { styles?: object } } ).layout ?? {};
	const layout = savedLayout?.styles ? { ...nextLayout, styles: savedLayout.styles } : nextLayout;

	return { ...next, fields, layout: savedLayout || Object.keys( layout ).length ? layout : undefined } as V;
}
