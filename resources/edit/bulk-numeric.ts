/**
 * Numeric bulk operations: set / increase / decrease (± percent for money),
 * clamped at zero, rounded to the store's currency precision or to an
 * integer for stock. A pending op is resolved per row at save time because
 * "increase by 10 %" depends on each row's current value.
 */
import { applyFilters } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';
import { FILTERS } from '../extensions/hooks';
import type { ProductField, ProductListItem, Settings } from '../types';
import { readFieldValue } from './field-value';
import { leafOf } from './visibility';

export type NumericOperation = 'dont_change' | 'set' | 'increase' | 'decrease';

export type NumericOp = {
	operation: NumericOperation;
	value: string;
	/** `increase`/`decrease` by percent of the current value (money only). */
	percent?: boolean;
};

export type NumericKind = 'money' | 'integer';

export const DONT_CHANGE: NumericOp = { operation: 'dont_change', value: '' };

export const NUMERIC_OPERATIONS: readonly NumericOperation[] = [ 'dont_change', 'set', 'increase', 'decrease' ];

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

	let text = input.trim();

	if ( text === '' ) {
		return undefined;
	}

	const thousand = settings?.currency.thousandSeparator ?? '';
	const decimal = settings?.currency.decimalSeparator ?? '.';

	if ( thousand && thousand !== '.' && thousand !== ',' ) {
		text = text.split( thousand ).join( '' );
	}

	if ( decimal !== '.' && text.includes( decimal ) && ! text.includes( '.' ) ) {
		text = text.replace( decimal, '.' );
	} else if ( decimal !== '.' && thousand && text.includes( thousand ) ) {
		text = text.split( thousand ).join( '' );
	}

	text = text.replace( /\s+/g, '' );

	if ( ! /^-?\d*(\.\d*)?$/.test( text ) || text === '-' || text === '.' ) {
		return undefined;
	}

	const number = Number( text );

	return Number.isFinite( number ) ? number : undefined;
}

export function roundTo( value: number, decimals: number ): string {
	const factor = Math.pow( 10, Math.max( 0, decimals ) );
	const rounded = Math.round( ( value + Number.EPSILON ) * factor ) / factor;

	return rounded.toFixed( Math.max( 0, decimals ) );
}

/** A finished value as wc/v3 wants it: `"12.50"` for money, `"7"` for integers. */
export function formatNumeric( value: number, kind: NumericKind, settings: Settings ): string {
	const clamped = Math.max( 0, value );

	if ( kind === 'integer' ) {
		return String( Math.round( clamped ) );
	}

	return roundTo( clamped, settings.currency.decimals );
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

/**
 * The value `op` produces from `current`; null when nothing changes (not
 * pending, unparsable input, or a relative op on an empty value).
 */
export function applyNumericOp( current: string | number | null | undefined, op: NumericOp, kind: NumericKind, settings: Settings ): string | null {
	if ( ! isPendingOp( op ) ) {
		return null;
	}

	const amount = parseNumeric( op.value, settings );

	if ( amount === undefined ) {
		return null;
	}

	if ( op.operation === 'set' ) {
		return formatNumeric( amount, kind, settings );
	}

	const base = parseNumeric( current, settings );

	if ( base === undefined ) {
		return null;
	}

	const delta = op.percent ? base * ( amount / 100 ) : amount;
	const next = op.operation === 'increase' ? base + delta : base - delta;

	return formatNumeric( next, kind, settings );
}

/**
 * Resolve every edit for one row: numeric ops become concrete values,
 * everything else passes through. Ops that produce no change are dropped.
 */
export function projectEdits( item: ProductListItem, edits: Record< string, unknown >, fields: ProductField[], settings: Settings ): Record< string, unknown > {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const projected: Record< string, unknown > = {};

	for ( const [ id, value ] of Object.entries( edits ) ) {
		if ( value === undefined ) {
			continue;
		}

		if ( isNumericOp( value ) ) {
			const field = byId.get( id );
			const kind = field ? numericKindOf( field ) : null;

			if ( ! field || ! kind ) {
				continue;
			}

			const current = readFieldValue( field, item ) as string | number | null | undefined;
			const next = applyNumericOp( current, value, kind, settings );

			if ( next !== null ) {
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

function regularIdFor( saleId: string ): string {
	return saleId.replace( /sale_price$/, 'regular_price' );
}

/**
 * Project the edits onto every row and check the result: prices parse and are
 * not negative, stock is an integer, and every sale price stays below its
 * regular price. Empty errors means the save can go ahead.
 */
export function validateBulkNumericEdits( items: ProductListItem[], edits: Record< string, unknown >, fields: ProductField[], settings: Settings ): ProjectedError[] {
	const errors: ProjectedError[] = [];
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		const projected = projectEdits( item, edits, fields, settings );
		const valueOf = ( id: string ): unknown => {
			if ( id in projected ) {
				return projected[ id ];
			}

			const field = byId.get( id );

			return field ? readFieldValue( field, item ) : undefined;
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
			const regular = parseNumeric( valueOf( regularIdFor( saleId ) ), settings );

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
	}

	return errors;
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
