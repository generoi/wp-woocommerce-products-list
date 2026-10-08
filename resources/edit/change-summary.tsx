/**
 * "What will change": one line per pending edit with the operation, how
 * many rows it reaches and one projected example, driven by the same
 * projection the save uses, so a 100-row write can be trusted before the
 * Save button is pressed.
 */
import { dateI18n } from '@wordpress/date';
import { __, _n, sprintf } from '@wordpress/i18n';
import { formatPrice } from '../fields/currency';
import type { Option } from '../dataviews';
import type { ProductField, ProductListItem, Settings } from '../types';
import { applyArrayOp, arrayOpFieldId, describeArrayOperation, hasArrayOp, isArrayOpFieldId, isArrayOperation } from './bulk-array';
import { editsForItem, isNumericOp, numericKindOf, projectEdits } from './bulk-numeric';
import type { NumericOp } from './bulk-numeric';
import type { RowEditOptions } from './row-rules';
import { isVariableParent, readFieldValue } from './field-value';
import { SCHEDULE_SALE_FIELD_ID } from './payload';
import { fieldAppliesTo, isSellableField, leafOf } from './visibility';

export interface ChangeLine {
	field: string;
	label: string;
	/** The operation in words: "+ 5 %", "→ Draft". */
	change: string;
	/** Rows the edit reaches. */
	count: number;
	/** "Name: 120,00 € → 126,00 €" for the first row the edit changes. */
	example?: string;
}

function money( value: unknown, settings: Settings ): string {
	return formatPrice( value as string | number | null | undefined, settings ) || String( value ?? '' );
}

function amount( op: NumericOp, kind: 'money' | 'integer', settings: Settings ): string {
	if ( op.percent ) {
		return `${ op.value } %`;
	}

	return kind === 'money' ? money( op.value.replace( settings.currency.decimalSeparator, '.' ), settings ) : op.value;
}

function describeOp( op: NumericOp, kind: 'money' | 'integer', settings: Settings ): string {
	switch ( op.operation ) {
		case 'set':
			return `→ ${ amount( op, kind, settings ) }`;
		case 'increase':
			return `+ ${ amount( op, kind, settings ) }`;
		case 'decrease':
			return `− ${ amount( op, kind, settings ) }`;
		case 'regular_minus':
			/* translators: %s: an amount or percent, e.g. "20 %" */
			return sprintf( __( 'regular price − %s', 'wp-woocommerce-products-list' ), amount( op, kind, settings ) );
		default:
			return '';
	}
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

	return elements.find( ( element ) => element.value === value )?.label ?? String( value ?? '' );
}

function describeValue( field: ProductField, value: unknown, settings: Settings ): string {
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
		return money( value, settings );
	}

	if ( Array.isArray( field.elements ) ) {
		return optionLabel( field, value );
	}

	const text = String( value );

	return text.length > 60 ? `${ text.slice( 0, 60 ) }…` : text;
}

/** Does the edit of `field` reach this row? Sellable edits skip variable parents (they go to the variations). */
function reaches( field: ProductField, item: ProductListItem, applyToVariations: boolean ): boolean {
	if ( isVariableParent( item ) && isSellableField( field ) ) {
		return false;
	}

	return fieldAppliesTo( field, item, applyToVariations );
}

export function describeEdits( edits: Record< string, unknown >, fields: ProductField[], targets: ProductListItem[], settings: Settings, applyToVariations = false, options: RowEditOptions = {} ): ChangeLine[] {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const rows = targets.filter( ( item ) => ! item._placeholder );
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
			const changed = reached.filter( ( item ) => applyArrayOp( readFieldValue( field, item ), operation, value ).changed ).length;

			lines.push( { field: id, label, change: `${ describeArrayOperation( operation ) } ${ describeValue( field, value, settings ) }`, count: changed } );
			continue;
		}

		if ( leafOf( id ) === SCHEDULE_SALE_FIELD_ID ) {
			lines.push( {
				field: id,
				label,
				change: value === false ? __( 'sale dates cleared', 'wp-woocommerce-products-list' ) : __( 'on', 'wp-woocommerce-products-list' ),
				count: reached.length,
			} );
			continue;
		}

		if ( isNumericOp( value ) ) {
			const kind = numericKindOf( field );

			if ( ! kind ) {
				continue;
			}

			let example: string | undefined;
			let changed = 0;

			for ( const item of reached ) {
				const projected = projectEdits( item, editsForItem( item, edits, fields, options ), fields, settings );
				const next = projected[ id ];

				if ( next === undefined ) {
					continue;
				}

				changed += 1;

				if ( ! example ) {
					const current = readFieldValue( field, item );
					const name = ( item as { name?: string } ).name ?? `#${ item.id }`;

					example = `${ name }: ${ describeValue( field, current, settings ) } → ${ describeValue( field, next, settings ) }`;
				}
			}

			lines.push( { field: id, label, change: describeOp( value, kind, settings ), count: changed, example } );
			continue;
		}

		lines.push( { field: id, label, change: `→ ${ describeValue( field, value, settings ) }`, count: reached.length } );
	}

	return lines;
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

	const rows = targets.filter( ( item ) => ! item._placeholder ).length;

	return (
		<div className="wc-pl-edit__summary-box" aria-live="polite">
			<strong>
				{ sprintf(
					/* translators: 1: number of fields, 2: number of rows */
					_n( '%1$d field will change on %2$d rows:', '%1$d fields will change on %2$d rows:', lines.length, 'wp-woocommerce-products-list' ),
					lines.length,
					rows
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
