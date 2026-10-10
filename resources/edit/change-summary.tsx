/**
 * "What will change": one line per pending edit with the operation, how
 * many rows it reaches and one projected example, driven by the same
 * projection the save uses, so a 100-row write can be trusted before the
 * Save button is pressed.
 */
import { dateI18n } from '@wordpress/date';
import { __, _n, sprintf } from '@wordpress/i18n';
import { formatMoney } from '../extensions/declarative';
import type { FieldCurrency } from '../extensions/declarative';
import { formatPrice } from '../fields/currency';
import { termLabel } from '../fields/terms';
import type { Option } from '../dataviews';
import type { ProductField, ProductListItem, Settings } from '../types';
import { applyArrayOp, arrayOpFieldId, describeArrayOperation, hasArrayOp, isArrayOpFieldId, isArrayOperation } from './bulk-array';
import { describeRounding, editsForItem, isNumericOp, numericKindOf, parseNumeric, projectEdits } from './bulk-numeric';
import type { NumericOp } from './bulk-numeric';
import { currentSellingPrice } from './row-rules';
import type { RowEditOptions } from './row-rules';
import { isVariableParent, readFieldValue } from './field-value';
import { itemLabel } from './item-label';
import { SCHEDULE_SALE_FIELD_ID } from './payload';
import { isInvalidDate } from './sale-schedule';
import { fieldAppliesTo, isParentDerivedField, isSellableField, leafOf } from './visibility';

export interface ChangeLine {
	field: string;
	label: string;
	/** The operation in words: "+ 5 %", "→ Draft". */
	change: string;
	/** Rows the edit reaches. */
	count: number;
	/** "Name: 120,00 € → 126,00 €" for the first row the edit changes. */
	example?: string;
	/** The rows counted (each once), so the heading counts every row once across the lines. */
	rowIds: number[];
	/**
	 * A numeric edit's direction per row: how many rows go up and down (a
	 * sale price against what the row sells at now), the lowest and highest
	 * result, and a row that goes up when the edit is meant to lower prices.
	 */
	direction?: { higher: number; lower: number; same: number; min: string; max: string; higherExample?: string; againstSelling: boolean };
}

/** The currency a price field is in: a language's market currency (SEK) for its prices, else the shop's. */
export function currencyOf( field: ProductField ): FieldCurrency | undefined {
	return ( field as { currency?: FieldCurrency } ).currency;
}

function money( value: unknown, settings: Settings, currency?: FieldCurrency ): string {
	const text = currency && currency.code !== settings.currency.code ? formatMoney( value, currency, settings ) : formatPrice( value as string | number | null | undefined, settings );

	return text || String( value ?? '' );
}

function roundingNote( op: NumericOp, settings: Settings ): string {
	return op.round ? ` (${ describeRounding( op.round, settings, op.roundMode ?? 'nearest' ) })` : '';
}

function amount( op: NumericOp, kind: 'money' | 'integer', settings: Settings, currency?: FieldCurrency ): string {
	if ( op.percent ) {
		return `${ op.value } %`;
	}

	return kind === 'money' ? money( op.value.replace( settings.currency.decimalSeparator, '.' ), settings, currency ) : op.value;
}

export function describeOp( op: NumericOp, kind: 'money' | 'integer', settings: Settings, currency?: FieldCurrency ): string {
	switch ( op.operation ) {
		case 'set':
			return `→ ${ amount( op, kind, settings, currency ) }`;
		case 'increase':
			return `+ ${ amount( op, kind, settings, currency ) }${ roundingNote( op, settings ) }`;
		case 'decrease':
			return `− ${ amount( op, kind, settings, currency ) }${ roundingNote( op, settings ) }`;
		case 'regular_minus':
			/* translators: %s: an amount or percent, e.g. "20 %" */
			return sprintf( __( 'regular price − %s', 'wp-woocommerce-products-list' ), amount( op, kind, settings, currency ) ) + roundingNote( op, settings );
		default:
			return '';
	}
}

/** Each row once (a variation selected and reached through its parent too), placeholders left out. */
export function uniqueRows( targets: ProductListItem[] ): ProductListItem[] {
	const seen = new Set< number >();

	return targets.filter( ( item ) => {
		if ( item._placeholder || seen.has( item.id ) ) {
			return false;
		}

		seen.add( item.id );

		return true;
	} );
}

/**
 * The schedule line: what the sale will run from and to, so a sale with
 * no dates reads "starts now, no end date", never just "on".
 */
export function describeSchedule( toggleId: string, edits: Record< string, unknown >, settings: Settings ): string {
	const prefix = toggleId.slice( 0, toggleId.length - SCHEDULE_SALE_FIELD_ID.length );
	const from = edits[ `${ prefix }date_on_sale_from` ];
	const to = edits[ `${ prefix }date_on_sale_to` ];
	const describe = ( value: unknown, empty: string ) => {
		if ( value === undefined ) {
			return __( 'as each row has it', 'wp-woocommerce-products-list' );
		}

		if ( value === '' || value === null ) {
			return empty;
		}

		if ( isInvalidDate( value ) ) {
			return __( 'not a valid date', 'wp-woocommerce-products-list' );
		}

		return describeSiteDateTime( String( value ), settings );
	};

	return sprintf(
		/* translators: 1: when the sale starts ("now" or a date), 2: when it ends ("no end date" or a date) */
		__( 'on: from %1$s, to %2$s', 'wp-woocommerce-products-list' ),
		describe( from, __( 'now (starts immediately)', 'wp-woocommerce-products-list' ) ),
		describe( to, __( 'no end date', 'wp-woocommerce-products-list' ) )
	);
}

const ZONED_DATE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL_DATE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/;

/**
 * A sale date as it will be stored: the control emits site wall-clock time
 * (`2026-11-01T00:00:00`, no zone), and that is what wc/v3 writes. Formatting
 * it as a browser-local instant would show "October 31, 10:00 pm" to a
 * manager in Helsinki for a site on UTC; the zone-less string is formatted
 * as the clock reading it is, and labelled as site time.
 */
export function describeSiteDateTime( value: string, settings: Pick< Settings, 'dateFormat' | 'timeFormat' | 'timezone' > ): string {
	const format = `${ settings.dateFormat } ${ settings.timeFormat }`;
	/* translators: %s: a formatted date and time, shown in the site's timezone */
	const label = ( text: string ) => sprintf( __( '%s (site time)', 'wp-woocommerce-products-list' ), text );

	try {
		if ( ZONED_DATE.test( value ) ) {
			return label( dateI18n( format, value ) );
		}

		const match = LOCAL_DATE.exec( value );

		if ( match ) {
			// The wall-clock reading, formatted as UTC so no zone shifts it.
			return label( dateI18n( format, `${ match[ 1 ] }T${ match[ 2 ] }Z`, 'UTC' ) );
		}

		return label( dateI18n( format, value ) );
	} catch {
		return value;
	}
}

function optionLabel( field: ProductField, value: unknown ): string {
	const elements = Array.isArray( field.elements ) ? ( field.elements as Option[] ) : [];

	const label = elements.find( ( element ) => String( element.value ) === String( value ) )?.label;

	if ( label !== undefined ) {
		return String( label );
	}

	// Terms fields load their options lazily (no `elements`): the edit holds ids, the summary shows the names.
	return termLabel( field.id, value ) ?? String( value ?? '' );
}

/** A field's value as the editor's lines show it ("(empty)", Yes/No, option labels, money, site dates). */
export function describeValue( field: ProductField, value: unknown, settings: Settings ): string {
	if ( value === '' || value === null || value === undefined || ( Array.isArray( value ) && value.length === 0 ) ) {
		return __( '(empty)', 'wp-woocommerce-products-list' );
	}

	if ( value === true ) {
		return __( 'Yes', 'wp-woocommerce-products-list' );
	}

	if ( value === false ) {
		return __( 'No', 'wp-woocommerce-products-list' );
	}

	if ( Array.isArray( value ) ) {
		const labels = value.map( ( entry ) => optionLabel( field, entry ) );

		return labels.length > 5 ? `${ labels.slice( 0, 5 ).join( ', ' ) } …` : labels.join( ', ' );
	}

	if ( ( field.type === 'datetime' || field.type === 'date' ) && typeof value === 'string' ) {
		return describeSiteDateTime( value, settings );
	}

	if ( numericKindOf( field ) === 'money' ) {
		return money( value, settings, currencyOf( field ) );
	}

	if ( Array.isArray( field.elements ) ) {
		return optionLabel( field, value );
	}

	const text = String( value );

	return text.length > 60 ? `${ text.slice( 0, 60 ) }…` : text;
}

/** Does the edit of `field` reach this row? Sellable edits skip variable parents (they go to the variations). */
function reaches( field: ProductField, item: ProductListItem, applyToVariations: boolean ): boolean {
	if ( isVariableParent( item ) && ( isSellableField( field ) || isParentDerivedField( field ) ) ) {
		return false;
	}

	return fieldAppliesTo( field, item, applyToVariations );
}

export function describeEdits( edits: Record< string, unknown >, fields: ProductField[], targets: ProductListItem[], settings: Settings, applyToVariations = false, options: RowEditOptions = {} ): ChangeLine[] {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const rows = uniqueRows( targets );
	const lines: ChangeLine[] = [];

	for ( const [ id, value ] of Object.entries( edits ) ) {
		const field = byId.get( id );

		if ( ! field || value === undefined || isArrayOpFieldId( id ) ) {
			continue;
		}

		// A row the per-row rules drop the edit for (no stock management, an existing sale) is not reached.
		const reached = rows.filter( ( item ) => reaches( field, item, applyToVariations ) && id in editsForItem( item, edits, fields, options ) );
		const label = field.label ?? id;

		if ( Array.isArray( value ) && hasArrayOp( fields, id ) ) {
			const chosen = edits[ arrayOpFieldId( id ) ];
			const operation = isArrayOperation( chosen ) ? chosen : 'add';

			// Replacing with nothing is never saved (bulk-numeric.ts projectEdits).
			if ( operation === 'replace' && value.length === 0 ) {
				continue;
			}

			const changed = reached.filter( ( item ) => applyArrayOp( readFieldValue( field, item ), operation, value ).changed );

			lines.push( { field: id, label, change: `${ describeArrayOperation( operation ) } ${ describeValue( field, value, settings ) }`, count: changed.length, rowIds: changed.map( ( item ) => item.id ) } );
			continue;
		}

		if ( leafOf( id ) === SCHEDULE_SALE_FIELD_ID ) {
			lines.push( {
				field: id,
				label,
				change: value === false ? __( 'sale dates cleared', 'wp-woocommerce-products-list' ) : describeSchedule( id, edits, settings ),
				count: reached.length,
				rowIds: reached.map( ( item ) => item.id ),
			} );
			continue;
		}

		if ( isNumericOp( value ) ) {
			const kind = numericKindOf( field );

			if ( ! kind ) {
				continue;
			}

			let example: string | undefined;
			const changed: number[] = [];
			// The core sale price is compared with what the row sells at now: an empty sale price under a 159 € regular price is 159 €, not nothing.
			const againstSelling = id === 'sale_price';
			const direction = { higher: 0, lower: 0, same: 0, min: Infinity, max: -Infinity, higherExample: undefined as string | undefined };

			for ( const item of reached ) {
				const projected = projectEdits( item, editsForItem( item, edits, fields, options ), fields, settings );
				const next = projected[ id ];

				if ( next === undefined ) {
					continue;
				}

				changed.push( item.id );

				const current = readFieldValue( field, item );
				const line = `${ itemLabel( item ) }: ${ describeValue( field, current, settings ) } → ${ describeValue( field, next, settings ) }`;

				if ( ! example ) {
					example = line;
				}

				const after = parseNumeric( next, settings );
				const before = parseNumeric( againstSelling ? currentSellingPrice( item ) : current, settings );

				if ( after === undefined ) {
					continue;
				}

				direction.min = Math.min( direction.min, after );
				direction.max = Math.max( direction.max, after );

				if ( before === undefined || after === before ) {
					direction.same += before === undefined ? 0 : 1;
				} else if ( after > before ) {
					direction.higher += 1;

					if ( ! direction.higherExample ) {
						const shown = againstSelling ? `${ itemLabel( item ) }: ${ describeValue( field, String( before ), settings ) } → ${ describeValue( field, next, settings ) }` : line;

						direction.higherExample = shown;
					}
				} else {
					direction.lower += 1;
				}
			}

			const counted = direction.min <= direction.max;

			lines.push( {
				field: id,
				label,
				change: describeOp( value, kind, settings, currencyOf( field ) ),
				count: changed.length,
				example,
				rowIds: changed,
				...( counted
					? {
							direction: {
								higher: direction.higher,
								lower: direction.lower,
								same: direction.same,
								min: describeValue( field, String( direction.min ), settings ),
								max: describeValue( field, String( direction.max ), settings ),
								higherExample: direction.higherExample,
								againstSelling,
							},
					  }
					: {} ),
			} );
			continue;
		}

		lines.push( { field: id, label, change: `→ ${ describeValue( field, value, settings ) }`, count: reached.length, rowIds: reached.map( ( item ) => item.id ) } );
	}

	return lines;
}

/** "Lower on 47 rows, HIGHER on 16 (e.g. …); from 59,00 € to 119,25 €." under a numeric line. */
export function describeDirection( direction: NonNullable< ChangeLine[ 'direction' ] > ): string {
	const parts: string[] = [];

	if ( direction.lower ) {
		/* translators: %d: number of rows */
		parts.push( sprintf( _n( 'lower on %d row', 'lower on %d rows', direction.lower, 'wp-woocommerce-products-list' ), direction.lower ) );
	}

	if ( direction.higher ) {
		parts.push(
			direction.againstSelling
				? /* translators: %d: number of rows */
				  sprintf( _n( 'HIGHER than the current selling price on %d row', 'HIGHER than the current selling price on %d rows', direction.higher, 'wp-woocommerce-products-list' ), direction.higher )
				: /* translators: %d: number of rows */
				  sprintf( _n( 'higher on %d row', 'higher on %d rows', direction.higher, 'wp-woocommerce-products-list' ), direction.higher )
		);
	}

	if ( direction.same ) {
		/* translators: %d: number of rows */
		parts.push( sprintf( _n( 'the same on %d row', 'the same on %d rows', direction.same, 'wp-woocommerce-products-list' ), direction.same ) );
	}

	const range =
		direction.min === direction.max
			? /* translators: %s: a price or number */
			  sprintf( __( 'all %s', 'wp-woocommerce-products-list' ), direction.min )
			: /* translators: 1: lowest result, 2: highest result */
			  sprintf( __( 'from %1$s to %2$s', 'wp-woocommerce-products-list' ), direction.min, direction.max );
	const head = parts.length ? parts.join( ', ' ) : '';
	const example = direction.higher && direction.higherExample ? ` (${ sprintf( /* translators: %s: an example "Name: old → new" */ __( 'e.g. %s', 'wp-woocommerce-products-list' ), direction.higherExample ) })` : '';

	return `${ head ? `${ head.charAt( 0 ).toUpperCase() }${ head.slice( 1 ) }${ example }; ` : '' }${ range }.`;
}

function DirectionNote( { direction }: { direction: NonNullable< ChangeLine[ 'direction' ] > } ) {
	return <span className={ `wc-pl-edit__summary-direction${ direction.higher && direction.againstSelling ? ' is-warning' : '' }` }>{ describeDirection( direction ) }</span>;
}

export interface ChangeSummaryProps {
	edits: Record< string, unknown >;
	fields: ProductField[];
	targets: ProductListItem[];
	settings: Settings;
	applyToVariations: boolean;
	options?: RowEditOptions;
	/** Rows the edits reach whose values already equal the result (from the save plan). */
	unchanged?: number;
}

export function ChangeSummary( { edits, fields, targets, settings, applyToVariations, options, unchanged = 0 }: ChangeSummaryProps ) {
	const lines = describeEdits( edits, fields, targets, settings, applyToVariations, options );

	if ( lines.length === 0 ) {
		return null;
	}

	// Each row once, however many lines reach it; parents an edit skips are not counted.
	const rows = new Set( lines.flatMap( ( line ) => line.rowIds ) ).size;
	// A line that reaches no row (a sale price change on rows that are all skipped) changes no field.
	const changing = lines.filter( ( line ) => line.count > 0 ).length;

	return (
		<div className="wc-pl-edit__summary-box" aria-live="polite">
			<strong>
				{ sprintf(
					/* translators: 1: "N fields", 2: "N rows" */
					__( '%1$s will change on %2$s:', 'wp-woocommerce-products-list' ),
					sprintf(
						/* translators: %d: number of fields */
						_n( '%d field', '%d fields', changing, 'wp-woocommerce-products-list' ),
						changing
					),
					sprintf(
						/* translators: %d: number of rows */
						_n( '%d row', '%d rows', rows, 'wp-woocommerce-products-list' ),
						rows
					)
				) }
			</strong>
			<ul>
				{ lines.map( ( line ) => (
					<li key={ line.field }>
						<span className="wc-pl-edit__summary-field">{ line.label }</span> { line.change }
						{ line.count !== rows ? (
							<span className="wc-pl-edit__summary-count">
								{ ' ' }
								{ sprintf(
									/* translators: %d: number of rows */
									_n( '(%d row)', '(%d rows)', line.count, 'wp-woocommerce-products-list' ),
									line.count
								) }
							</span>
						) : null }
						{ line.example ? <span className="wc-pl-edit__summary-example"> — { sprintf( /* translators: %s: an example "Name: old → new" */ __( 'e.g. %s', 'wp-woocommerce-products-list' ), line.example ) }</span> : null }
						{ line.direction ? <DirectionNote direction={ line.direction } /> : null }
					</li>
				) ) }
				{ unchanged > 0 ? (
					<li className="wc-pl-edit__summary-count">
						{ sprintf(
							/* translators: %d: number of rows */
							_n( '%d row already has these values and is left as it is.', '%d rows already have these values and are left as they are.', unchanged, 'wp-woocommerce-products-list' ),
							unchanged
						) }
					</li>
				) : null }
			</ul>
		</div>
	);
}
