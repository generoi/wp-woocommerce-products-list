/**
 * Numeric bulk operations: set / increase / decrease (± percent for money) /
 * regular price minus (sale prices), clamped at zero, rounded to the store's
 * currency precision or to an integer for stock. A pending op is resolved
 * per row at save time because "increase by 10 %" depends on each row's
 * current value.
 *
 * The arithmetic runs in integer minor units (cents) with half-up rounding,
 * so a −10 % campaign writes the same prices WooCommerce's classic bulk
 * edit (PHP `round()`) would: 4.35 + 10 % is 4.79, not 4.78.
 */
import { applyFilters } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, ProductListItem, Settings } from '../types';
import { splitParentEdits } from './apply-to-variations';
import { applyArrayOp, arrayOpFieldId, hasArrayOp, isArrayOpFieldId, isArrayOperation } from './bulk-array';
import { isVariableParent, readFieldValue, readReference } from './field-value';
import { resolveRowEdits } from './row-rules';
import type { RowEditOptions } from './row-rules';
import { leafOf } from './visibility';

export type NumericOperation = 'dont_change' | 'set' | 'increase' | 'decrease' | 'regular_minus';

export type NumericOp = {
	operation: NumericOperation;
	value: string;
	/** `increase`/`decrease` by percent of the current value, `regular_minus` by percent of the regular price (money only). */
	percent?: boolean;
};

export type NumericKind = 'money' | 'integer';

export const DONT_CHANGE: NumericOp = { operation: 'dont_change', value: '' };

export const NUMERIC_OPERATIONS: readonly NumericOperation[] = [ 'dont_change', 'set', 'increase', 'decrease', 'regular_minus' ];

export function isNumericOp( value: unknown ): value is NumericOp {
	return (
		typeof value === 'object' &&
		value !== null &&
		'operation' in value &&
		NUMERIC_OPERATIONS.includes( ( value as { operation: NumericOperation } ).operation )
	);
}

export function isPendingOp( op: NumericOp | undefined ): boolean {
	return op !== undefined && op.operation !== 'dont_change';
}

/** Whether a field is a sale price (core or an extension's `…sale_price`), which `regular_minus` projects from the regular price. */
export function isSalePriceField( fieldOrId: ProductField | string ): boolean {
	return leafOf( typeof fieldOrId === 'string' ? fieldOrId : fieldOrId.id ) === 'sale_price';
}

/**
 * The bulk kind of a field: from `edit.bulk`, or `money`/`integer` for ids the
 * `wcProductsList.bulkNumericFields` filter adds (`regular_price`, `sale_price`,
 * `stock_quantity`, `cost_of_goods_sold` by default).
 */
export function numericKindOf( field: ProductField ): NumericKind | null {
	if ( field.edit === false || field.edit === undefined ) {
		return null;
	}

	if ( field.edit.bulk === 'money' || field.edit.bulk === 'integer' ) {
		return field.edit.bulk;
	}

	if ( field.edit.bulk === false ) {
		return null;
	}

	const extra = applyFilters( FILTERS.bulkNumericFields, [ 'regular_price', 'sale_price', 'stock_quantity', 'cost_of_goods_sold' ] );
	const ids = Array.isArray( extra ) ? ( extra as string[] ) : [];

	if ( ids.includes( field.id ) || ids.includes( leafOf( field.id ) ) ) {
		return leafOf( field.id ) === 'stock_quantity' ? 'integer' : 'money';
	}

	return null;
}

/**
 * Parse a user-entered or stored number. Accepts the store's decimal
 * separator and a plain dot; thousand separators are stripped.
 */
export function parseNumeric( input: unknown, settings?: Settings ): number | undefined {
	if ( input === '' || input === null || input === undefined ) {
		return undefined;
	}

	if ( typeof input === 'number' ) {
		return Number.isFinite( input ) ? input : undefined;
	}

	if ( typeof input !== 'string' ) {
		return undefined;
	}

	let text = input.trim().replace( /\s+/g, '' );

	if ( text === '' ) {
		return undefined;
	}

	const thousand = settings?.currency.thousandSeparator?.trim() ?? '';
	const decimal = settings?.currency.decimalSeparator ?? '.';

	// The store's own notation first: thousands out, then its decimal mark to a dot.
	// A lone "." or "," on a store that groups thousands with it is a thousands
	// mark only when it groups three digits ("1.234"); "12.5" / "12,5" are decimals.
	const grouped = thousand === '.' || thousand === ',' ? new RegExp( `^-?\\d{1,3}(\\${ thousand }\\d{3})+$` ) : null;

	if ( thousand && thousand !== decimal && text.includes( thousand ) && ( ! grouped || text.includes( decimal ) || grouped.test( text ) ) ) {
		text = text.split( thousand ).join( '' );
	}

	if ( decimal !== '.' && text.includes( decimal ) ) {
		text = text.replace( decimal, '.' );
	} else if ( decimal === '.' && text.includes( ',' ) && ! text.includes( '.' ) ) {
		// A comma typed on a dot-decimal store: a decimal mark, not a thousands group.
		text = text.replace( ',', '.' );
	}

	if ( ! /^-?\d*(\.\d*)?$/.test( text ) || text === '-' || text === '.' ) {
		return undefined;
	}

	const number = Number( text );

	return Number.isFinite( number ) ? number : undefined;
}

function scaleOf( decimals: number ): number {
	return 10 ** Math.max( 0, decimals );
}

/**
 * A value in integer minor units (cents for two decimals), rounded half-up.
 * `toPrecision( 15 )` strips the binary noise first, so 1.005 × 100 is 100.5
 * and not 100.49999999999999.
 */
export function toUnits( value: number, decimals: number ): number {
	const scaled = Number( ( value * scaleOf( decimals ) ).toPrecision( 15 ) );
	const rounded = Math.round( scaled );

	return Object.is( rounded, -0 ) ? 0 : rounded;
}

/** Integer minor units back to a decimal string with exactly `decimals` places. */
export function fromUnits( units: number, decimals: number ): string {
	const places = Math.max( 0, decimals );
	const factor = scaleOf( places );
	const abs = Math.abs( units );
	const whole = Math.floor( abs / factor );
	const fraction = abs - whole * factor;
	const sign = units < 0 ? '-' : '';

	return places > 0 ? `${ sign }${ whole }.${ String( fraction ).padStart( places, '0' ) }` : `${ sign }${ whole }`;
}

/** Integer division rounded half away from zero, exact for |n| < 2^53. */
function divideHalfUp( n: number, d: number ): number {
	const sign = n < 0 ? -1 : 1;
	const abs = Math.abs( n );
	const remainder = abs % d;
	const quotient = ( abs - remainder ) / d;

	return sign * ( remainder * 2 >= d ? quotient + 1 : quotient );
}

/** Percent amounts are scaled to a millionth, so "12.5 %" and "33.333 %" stay exact. */
const PERCENT_DECIMALS = 6;
const PERCENT_SCALE = 100 * scaleOf( PERCENT_DECIMALS );

export function roundTo( value: number, decimals: number ): string {
	return fromUnits( toUnits( value, decimals ), decimals );
}

/** A finished value as wc/v3 wants it: `"12.50"` for money, `"7"` for integers. */
export function formatNumeric( value: number, kind: NumericKind, settings: Settings ): string {
	const decimals = kind === 'integer' ? 0 : settings.currency.decimals;

	return fromUnits( Math.max( 0, toUnits( value, decimals ) ), decimals );
}

export function validateNumericOp( op: NumericOp | undefined, kind: NumericKind, settings?: Settings ): string | null {
	if ( ! isPendingOp( op ) || ! op ) {
		return null;
	}

	const value = parseNumeric( op.value, settings );

	if ( value === undefined ) {
		return __( 'Enter a number.', 'wp-woocommerce-products-list' );
	}

	if ( value < 0 ) {
		return __( 'The value cannot be negative.', 'wp-woocommerce-products-list' );
	}

	if ( kind === 'integer' && ! Number.isInteger( value ) ) {
		return __( 'Stock quantities are whole numbers.', 'wp-woocommerce-products-list' );
	}

	return null;
}

export interface NumericContext {
	/** The row's regular price (stored, projected or reference), for `regular_minus`. */
	regular?: string | number | null;
}

/**
 * The number `op` produces from `current`, before clamping: negative when a
 * decrease goes below zero. null when nothing changes (not pending,
 * unparsable input, or a relative op on an empty value).
 */
export function computeNumericOp( current: string | number | null | undefined, op: NumericOp, kind: NumericKind, settings: Settings, context: NumericContext = {} ): number | null {
	if ( ! isPendingOp( op ) ) {
		return null;
	}

	const amount = parseNumeric( op.value, settings );

	if ( amount === undefined ) {
		return null;
	}

	const decimals = kind === 'integer' ? 0 : settings.currency.decimals;
	const scale = scaleOf( decimals );

	if ( op.operation === 'set' ) {
		return toUnits( amount, decimals ) / scale;
	}

	const base = parseNumeric( op.operation === 'regular_minus' ? context.regular : current, settings );

	if ( base === undefined ) {
		return null;
	}

	const baseUnits = toUnits( base, decimals );
	const increase = op.operation === 'increase';
	let units: number;

	if ( op.percent ) {
		const percentUnits = toUnits( amount, PERCENT_DECIMALS );

		units = divideHalfUp( baseUnits * ( PERCENT_SCALE + ( increase ? percentUnits : -percentUnits ) ), PERCENT_SCALE );
	} else {
		const amountUnits = toUnits( amount, decimals );

		units = increase ? baseUnits + amountUnits : baseUnits - amountUnits;
	}

	return units / scale;
}

/**
 * The value `op` produces from `current`; null when nothing changes (not
 * pending, unparsable input, or a relative op on an empty value).
 */
export function applyNumericOp( current: string | number | null | undefined, op: NumericOp, kind: NumericKind, settings: Settings, context: NumericContext = {} ): string | null {
	const next = computeNumericOp( current, op, kind, settings, context );

	return next === null ? null : formatNumeric( next, kind, settings );
}

function regularIdFor( saleId: string ): string {
	return saleId.replace( /sale_price$/, 'regular_price' );
}

/**
 * The regular price a sale price is checked against: the projected or
 * current value, else the field's reference value. A language price with
 * no stored value sells at its reference (gds-woo-i18n converts the default
 * language's price), so an empty translated regular price is not "no
 * regular price" when the row carries one.
 */
export function effectiveRegularPrice( item: ProductListItem, regularId: string, valueOf: ( id: string ) => unknown, byId: Map< string, ProductField >, settings: Settings ): number | undefined {
	const own = parseNumeric( valueOf( regularId ), settings );

	if ( own !== undefined ) {
		return own;
	}

	const field = byId.get( regularId );

	return field ? parseNumeric( readReference( field, item ), settings ) : undefined;
}

/** The context a numeric op on `id` needs for this row: the regular price (as edited in the same form) for a sale price. */
function contextFor( item: ProductListItem, id: string, edits: Record< string, unknown >, byId: Map< string, ProductField >, settings: Settings ): NumericContext {
	if ( ! isSalePriceField( id ) ) {
		return {};
	}

	const regularId = regularIdFor( id );
	const regularField = byId.get( regularId );
	const edited = edits[ regularId ];
	const current = ( regularField ? readFieldValue( regularField, item ) : ( item as Record< string, unknown > )[ regularId ] ) as string | number | null | undefined;
	const valueOf = ( lookup: string ): unknown => {
		if ( lookup !== regularId ) {
			return undefined;
		}

		if ( isNumericOp( edited ) && regularField ) {
			const kind = numericKindOf( regularField );

			return ( kind ? applyNumericOp( current, edited, kind, settings ) : null ) ?? current;
		}

		return edited !== undefined ? edited : current;
	};

	return { regular: effectiveRegularPrice( item, regularId, valueOf, byId, settings ) ?? null };
}

/**
 * The edits that apply to a row. A variable parent never takes sellable
 * edits itself: with "apply to variations" they go to its variations, and
 * without it the form does not offer them. Then the per-row rules: stock
 * edits only for rows that (will) manage stock, sale edits unless the row
 * is skipped for already having a sale.
 */
export function editsForItem( item: ProductListItem, edits: Record< string, unknown >, fields: ProductField[], options: RowEditOptions = {} ): Record< string, unknown > {
	const own = isVariableParent( item ) ? splitParentEdits( edits, fields ).parent : edits;

	return resolveRowEdits( item, own, options );
}

/**
 * Resolve every edit for one row: numeric ops become concrete values,
 * everything else passes through. Ops that produce no change are dropped.
 */
export function projectEdits( item: ProductListItem, edits: Record< string, unknown >, fields: ProductField[], settings: Settings ): Record< string, unknown > {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const projected: Record< string, unknown > = {};

	for ( const [ id, value ] of Object.entries( edits ) ) {
		if ( value === undefined || isArrayOpFieldId( id ) ) {
			continue;
		}

		if ( isNumericOp( value ) ) {
			const field = byId.get( id );
			const kind = field ? numericKindOf( field ) : null;

			if ( ! field || ! kind ) {
				continue;
			}

			const current = readFieldValue( field, item ) as string | number | null | undefined;
			const next = applyNumericOp( current, value, kind, settings, contextFor( item, id, edits, byId, settings ) );

			if ( next !== null ) {
				projected[ id ] = next;
			}

			continue;
		}

		// A list edit with a bulk op is resolved against the row's own list; rows it leaves as they are are dropped.
		if ( Array.isArray( value ) && hasArrayOp( fields, id ) ) {
			const field = byId.get( id );
			const chosen = edits[ arrayOpFieldId( id ) ];
			const { next, changed } = applyArrayOp( field ? readFieldValue( field, item ) : undefined, isArrayOperation( chosen ) ? chosen : 'add', value );

			if ( changed ) {
				projected[ id ] = next;
			}

			continue;
		}

		projected[ id ] = value;
	}

	return projected;
}


export interface ProjectedError {
	id: number;
	field: string;
	message: string;
}

function hasText( value: unknown ): boolean {
	return typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined && value !== false;
}

/**
 * Project the edits onto every row and check the result: prices parse and are
 * not negative, stock is an integer, every sale price stays below its
 * regular price, and a scheduled sale has a sale price to run with. Empty
 * errors means the save can go ahead.
 */
export function validateBulkNumericEdits( items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: RowEditOptions = {} ): ProjectedError[] {
	const errors: ProjectedError[] = [];
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		const own = editsForItem( item, edits, fields, options );
		const projected = projectEdits( item, own, fields, settings );
		const valueOf = ( id: string ): unknown => {
			if ( id in projected ) {
				return projected[ id ];
			}

			const field = byId.get( id );

			return field ? readFieldValue( field, item ) : ( item as Record< string, unknown > )[ id ];
		};

		for ( const [ id, value ] of Object.entries( projected ) ) {
			const field = byId.get( id );
			const kind = field ? numericKindOf( field ) : null;

			if ( ! field || ! kind ) {
				continue;
			}

			if ( value === '' || value === null ) {
				continue;
			}

			const number = parseNumeric( value, settings );

			if ( number === undefined ) {
				errors.push( { id: item.id, field: id, message: sprintf( /* translators: %s: field label */ __( '%s is not a number.', 'wp-woocommerce-products-list' ), field.label ?? id ) } );
				continue;
			}

			if ( number < 0 ) {
				errors.push( { id: item.id, field: id, message: sprintf( /* translators: %s: field label */ __( '%s cannot be negative.', 'wp-woocommerce-products-list' ), field.label ?? id ) } );
				continue;
			}

			if ( kind === 'integer' && ! Number.isInteger( number ) ) {
				errors.push( { id: item.id, field: id, message: sprintf( /* translators: %s: field label */ __( '%s must be a whole number.', 'wp-woocommerce-products-list' ), field.label ?? id ) } );
			}
		}

		const saleIds = new Set< string >();

		Object.keys( projected ).forEach( ( id ) => {
			if ( leafOf( id ) === 'sale_price' ) {
				saleIds.add( id );
			} else if ( leafOf( id ) === 'regular_price' ) {
				const saleId = id.replace( /regular_price$/, 'sale_price' );

				if ( byId.has( saleId ) ) {
					saleIds.add( saleId );
				}
			}
		} );

		for ( const saleId of saleIds ) {
			const sale = parseNumeric( valueOf( saleId ), settings );
			const regular = effectiveRegularPrice( item, regularIdFor( saleId ), valueOf, byId, settings );

			if ( sale === undefined ) {
				continue;
			}

			if ( regular === undefined || sale >= regular ) {
				errors.push( {
					id: item.id,
					field: saleId,
					message: __( 'The sale price must be lower than the regular price.', 'wp-woocommerce-products-list' ),
				} );
			}
		}

		// A schedule the edit sets up (dates or the toggle) needs a sale price to run
		// with, else the rows get dates and no sale: the campaign silently does nothing.
		const prefixes = new Set< string >();

		Object.keys( own ).forEach( ( id ) => {
			const leaf = leafOf( id );

			if ( leaf === 'date_on_sale_from' || leaf === 'date_on_sale_to' || leaf === 'schedule_sale' ) {
				prefixes.add( id.slice( 0, id.length - leaf.length ) );
			}
		} );

		for ( const prefix of prefixes ) {
			const saleId = `${ prefix }sale_price`;
			const saleField = byId.get( saleId );

			if ( ! saleField || own[ `${ prefix }schedule_sale` ] === false ) {
				continue;
			}

			if ( ! hasText( valueOf( `${ prefix }date_on_sale_from` ) ) && ! hasText( valueOf( `${ prefix }date_on_sale_to` ) ) ) {
				// "Schedule sale" ticked with both dates empty would start the sale right away.
				if ( own[ `${ prefix }schedule_sale` ] === true ) {
					errors.push( {
						id: item.id,
						field: `${ prefix }schedule_sale`,
						message: __( 'Schedule sale is on but no start or end date is set: the sale would start immediately. Set a date or untick Schedule sale.', 'wp-woocommerce-products-list' ),
					} );
				}

				continue;
			}

			if ( parseNumeric( valueOf( saleId ), settings ) === undefined ) {
				errors.push( {
					id: item.id,
					field: saleId,
					message: __( 'A sale is scheduled but there is no sale price: set one, or use "Regular price minus".', 'wp-woocommerce-products-list' ),
				} );
			}
		}
	}

	return errors;
}

export interface ProjectedWarning {
	id: number;
	field: string;
	/** The value before clamping. */
	value: number;
	message: string;
}

/**
 * Rows a relative op pushes below zero: the save clamps them to 0 (a stock
 * of 0 means Out of stock), so the user confirms first.
 */
export function projectWarnings( items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings, options: RowEditOptions = {} ): ProjectedWarning[] {
	const warnings: ProjectedWarning[] = [];
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		const own = editsForItem( item, edits, fields, options );

		for ( const [ id, value ] of Object.entries( own ) ) {
			if ( ! isNumericOp( value ) ) {
				continue;
			}

			const field = byId.get( id );
			const kind = field ? numericKindOf( field ) : null;

			if ( ! field || ! kind ) {
				continue;
			}

			const current = readFieldValue( field, item ) as string | number | null | undefined;
			const next = computeNumericOp( current, value, kind, settings, contextFor( item, id, own, byId, settings ) );

			if ( next === null || next >= 0 ) {
				continue;
			}

			const label = field.label ?? id;
			const was = String( current ?? '' );
			const would = kind === 'integer' ? String( next ) : `-${ formatNumeric( -next, kind, settings ) }`;

			warnings.push( {
				id: item.id,
				field: id,
				value: next,
				message:
					leafOf( id ) === 'stock_quantity'
						? sprintf(
								/* translators: 1: field label, 2: the current value, 3: the value the operation gives */
								__( '%1$s would go from %2$s to %3$s; it will be set to 0 (Out of stock).', 'wp-woocommerce-products-list' ),
								label,
								was,
								would
						  )
						: sprintf(
								/* translators: 1: field label, 2: the current value, 3: the value the operation gives */
								__( '%1$s would go from %2$s to %3$s; it will be set to 0.', 'wp-woocommerce-products-list' ),
								label,
								was,
								would
						  ),
			} );
		}
	}

	return warnings;
}

/** Input-level problems with the ops themselves (before projecting). */
export function validateNumericOps( edits: Record< string, unknown >, fields: ProductField[], settings: Settings ): Array< { field: string; message: string } > {
	const errors: Array< { field: string; message: string } > = [];
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );

	for ( const [ id, value ] of Object.entries( edits ) ) {
		if ( ! isNumericOp( value ) ) {
			continue;
		}

		const field = byId.get( id );
		const kind = field ? numericKindOf( field ) : null;

		if ( ! kind ) {
			continue;
		}

		const message = validateNumericOp( value, kind, settings );

		if ( message ) {
			errors.push( { field: id, message } );
		}
	}

	return errors;
}
