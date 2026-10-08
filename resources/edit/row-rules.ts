/**
 * Per-row rules that decide whether an edit reaches a row at all, before
 * any value is projected:
 *
 * - WooCommerce only honours stock quantity, low stock threshold and
 *   backorders on rows that manage stock (the REST controllers reset them
 *   otherwise), so those edits are dropped for rows that do not, unless the
 *   save also turns stock management on;
 * - a campaign may skip the rows that already run a sale, so an open-ended
 *   discount is not silently replaced by a scheduled one.
 *
 * Kept free of React and of the numeric ops so the rules can be tested and
 * reused by the plan, the validation and the save alike.
 */
import type { ProductListItem } from '../types';
import { isVariableParent } from './field-value';
import { leafOf } from './visibility';

/** Edits WooCommerce ignores unless the row manages stock. */
export const STOCK_GATED_LEAVES: ReadonlySet< string > = new Set( [ 'stock_quantity', 'low_stock_amount', 'backorders' ] );

/** The core sale fields (an extension's `i18n:se.sale_price` is a price of its own and is not gated here). */
export const SALE_EDIT_IDS: ReadonlySet< string > = new Set( [ 'sale_price', 'schedule_sale', 'date_on_sale_from', 'date_on_sale_to' ] );

export interface RowEditOptions {
	/** Turn "Manage stock" on for rows that do not manage it (never variable parents: their variations hold the stock). */
	enableManageStock?: boolean;
	/** Leave the sale fields of rows that already have a sale price alone. */
	skipExistingSales?: boolean;
}

export function isStockGatedEdit( id: string ): boolean {
	return STOCK_GATED_LEAVES.has( leafOf( id ) );
}

export function isSaleEdit( id: string ): boolean {
	return SALE_EDIT_IDS.has( id );
}

/** True only when the row manages its own stock (`'parent'` on a variation inherits the parent's). */
export function managesStock( item: ProductListItem ): boolean {
	return ( item as { manage_stock?: unknown } ).manage_stock === true;
}

/** Whether a row can be switched to managing its own stock by the save. */
export function canEnableStock( item: ProductListItem ): boolean {
	return ! isVariableParent( item ) && ! item._placeholder;
}

/** Whether the row will manage stock once the edits land. */
export function willManageStock( item: ProductListItem, edits: Record< string, unknown >, options: RowEditOptions = {} ): boolean {
	if ( edits.manage_stock === true ) {
		return true;
	}

	if ( edits.manage_stock === false ) {
		return false;
	}

	if ( managesStock( item ) ) {
		return true;
	}

	return options.enableManageStock === true && canEnableStock( item );
}

export function hasSale( item: ProductListItem ): boolean {
	const sale = ( item as { sale_price?: unknown } ).sale_price;

	return typeof sale === 'number' || ( typeof sale === 'string' && sale.trim() !== '' );
}

function instant( value: unknown, gmt: unknown ): number | null {
	const text = typeof gmt === 'string' && gmt ? `${ gmt.replace( ' ', 'T' ) }Z` : typeof value === 'string' && value ? value.replace( ' ', 'T' ) : '';
	const time = text ? Date.parse( text ) : NaN;

	return Number.isFinite( time ) ? time : null;
}

/** Whether the row's sale runs right now: wc/v3's `on_sale` when fetched, else the sale window. */
export function saleIsActive( item: ProductListItem, now: number = Date.now() ): boolean {
	if ( ! hasSale( item ) ) {
		return false;
	}

	const row = item as { on_sale?: unknown; date_on_sale_from?: unknown; date_on_sale_from_gmt?: unknown; date_on_sale_to?: unknown; date_on_sale_to_gmt?: unknown };

	if ( typeof row.on_sale === 'boolean' ) {
		return row.on_sale;
	}

	const from = instant( row.date_on_sale_from, row.date_on_sale_from_gmt );
	const to = instant( row.date_on_sale_to, row.date_on_sale_to_gmt );

	return ( from === null || from <= now ) && ( to === null || to >= now );
}

export function hasSaleEdit( edits: Record< string, unknown > ): boolean {
	return Object.keys( edits ).some( ( id ) => isSaleEdit( id ) && edits[ id ] !== undefined );
}

export function hasStockGatedEdit( edits: Record< string, unknown > ): boolean {
	return Object.keys( edits ).some( ( id ) => isStockGatedEdit( id ) && edits[ id ] !== undefined );
}

/**
 * Rows whose current sale the edits would replace: they carry a sale price
 * and the edits touch the sale fields. Variable parents never sell.
 */
export function rowsWithExistingSale( items: ProductListItem[], edits: Record< string, unknown > ): { rows: ProductListItem[]; active: number } {
	if ( ! hasSaleEdit( edits ) ) {
		return { rows: [], active: 0 };
	}

	const rows = items.filter( ( item ) => ! item._placeholder && ! isVariableParent( item ) && hasSale( item ) );

	return { rows, active: rows.filter( ( item ) => saleIsActive( item ) ).length };
}

/** Rows a stock-gated edit would be dropped for. */
export function stockGatedRows( items: ProductListItem[], edits: Record< string, unknown >, options: RowEditOptions = {} ): ProductListItem[] {
	if ( ! hasStockGatedEdit( edits ) ) {
		return [];
	}

	return items.filter( ( item ) => ! item._placeholder && ! willManageStock( item, edits, options ) );
}

function omit( edits: Record< string, unknown >, drop: ( id: string ) => boolean ): Record< string, unknown > {
	return Object.fromEntries( Object.entries( edits ).filter( ( [ id ] ) => ! drop( id ) ) );
}

/**
 * The edits that reach one row: stock-gated edits only when the row will
 * manage stock (with `manage_stock: true` added when the option turns it
 * on for the row), sale edits unless the row is skipped for having one.
 */
export function resolveRowEdits( item: ProductListItem, edits: Record< string, unknown >, options: RowEditOptions = {} ): Record< string, unknown > {
	let result = edits;

	if ( hasStockGatedEdit( result ) ) {
		if ( ! willManageStock( item, result, options ) ) {
			result = omit( result, isStockGatedEdit );
		} else if ( options.enableManageStock && ! managesStock( item ) && result.manage_stock === undefined && canEnableStock( item ) ) {
			result = { ...result, manage_stock: true };
		}
	}

	if ( options.skipExistingSales && hasSale( item ) && hasSaleEdit( result ) ) {
		result = omit( result, isSaleEdit );
	}

	return result;
}
