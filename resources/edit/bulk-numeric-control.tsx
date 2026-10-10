/**
 * The bulk control for a money or integer field: an operation select
 * (don't change / set / increase / decrease, ± percent for money, "regular
 * price minus" for sale prices) and the value input. The form value for the
 * field is a NumericOp; the real number for each row is only computed at
 * save time.
 */
import { BaseControl, SelectControl, TextControl, __experimentalHStack as HStack, __experimentalText as Text } from '@wordpress/components';
import { useId, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { Settings } from '../types';
import type { FieldCurrency } from '../extensions/declarative';
import { allowsNegative, DONT_CHANGE, isNumericOp, parseShorthand, ROUNDING_ENDINGS, validateNumericOp, WHOLE_UNIT_ENDINGS } from './bulk-numeric';
import type { RoundMode } from './bulk-numeric';
import type { NumericKind, NumericOp } from './bulk-numeric';

export type FormData = Record< string, unknown >;

type OpChoice = { value: string; label: string; operation: NumericOp[ 'operation' ]; percent: boolean };

function choices( kind: NumericKind, settings: Settings, salePrice: boolean, currency?: FieldCurrency ): OpChoice[] {
	// A language's prices are in its market currency (kr), not the shop's (€).
	const symbol = currency?.symbol ?? settings.currency.symbol;
	const list: OpChoice[] = [
		{ value: 'dont_change', label: __( '— No change —', 'wp-woocommerce-products-list' ), operation: 'dont_change', percent: false },
		{ value: 'set', label: __( 'Change to:', 'wp-woocommerce-products-list' ), operation: 'set', percent: false },
	];

	if ( kind === 'money' && salePrice ) {
		list.push(
			{ value: 'regular_minus', label: `${ __( 'Regular price minus', 'wp-woocommerce-products-list' ) } (${ symbol })`, operation: 'regular_minus', percent: false },
			{ value: 'regular_minus_percent', label: `${ __( 'Regular price minus', 'wp-woocommerce-products-list' ) } (%)`, operation: 'regular_minus', percent: true }
		);
	}

	list.push(
		{
			value: 'increase',
			label: kind === 'money' ? `${ __( 'Increase by', 'wp-woocommerce-products-list' ) } (${ symbol })` : __( 'Increase by', 'wp-woocommerce-products-list' ),
			operation: 'increase',
			percent: false,
		},
		{
			value: 'decrease',
			label: kind === 'money' ? `${ __( 'Decrease by', 'wp-woocommerce-products-list' ) } (${ symbol })` : __( 'Decrease by', 'wp-woocommerce-products-list' ),
			operation: 'decrease',
			percent: false,
		}
	);

	if ( kind === 'money' ) {
		list.push(
			{ value: 'increase_percent', label: `${ __( 'Increase by', 'wp-woocommerce-products-list' ) } (%)`, operation: 'increase', percent: true },
			{ value: 'decrease_percent', label: `${ __( 'Decrease by', 'wp-woocommerce-products-list' ) } (%)`, operation: 'decrease', percent: true }
		);
	}

	return list;
}

export function choiceValue( op: NumericOp ): string {
	if ( op.operation === 'dont_change' || op.operation === 'set' ) {
		return op.operation;
	}

	return op.percent ? `${ op.operation }_percent` : op.operation;
}

function hint( op: NumericOp, salePrice: boolean ): string | null {
	if ( op.operation === 'dont_change' || op.operation === 'set' ) {
		return null;
	}

	if ( op.operation === 'regular_minus' ) {
		return op.percent
			? __( 'Rounded to the store’s price decimals. Rows without a regular price are skipped.', 'wp-woocommerce-products-list' )
			: __( 'Rows without a regular price are skipped.', 'wp-woocommerce-products-list' );
	}

	if ( salePrice && op.operation === 'decrease' ) {
		return op.percent
			? __( 'Percent off each row’s current sale price; rows that are not on sale start from their regular price.', 'wp-woocommerce-products-list' )
			: __( 'Taken off each row’s current sale price; rows that are not on sale start from their regular price.', 'wp-woocommerce-products-list' );
	}

	if ( op.percent ) {
		return salePrice
			? __( 'Percent of each row’s current sale price. Rows without a sale price are skipped; use “Regular price minus” to start a sale.', 'wp-woocommerce-products-list' )
			: __( 'Percent of each row’s current value, rounded to the store’s price decimals.', 'wp-woocommerce-products-list' );
	}

	return salePrice ? __( 'Relative to each row’s current sale price. Rows without a sale price are skipped; use “Regular price minus” to start a sale.', 'wp-woocommerce-products-list' ) : null;
}

/**
 * The operation a typed value resolved to, in words ("Decrease by 5 €",
 * "Increase by 10%"), when the value carried its own sign or percent
 * (shorthand) and so picked the operation itself. Null otherwise.
 */
export function resolvedShorthand( text: string, op: NumericOp, kind: NumericKind, salePrice: boolean, symbol: string ): string | null {
	if ( op.operation === 'dont_change' || ! /^\s*(?:r(?:egular)?\s*)?[+\-−=]|%/i.test( text ) || ! parseShorthand( text, kind, salePrice ) ) {
		return null;
	}

	return readsAs( op, kind, symbol );
}

/** "Reads as: Regular price minus 20%": an operation and its value in words. */
function readsAs( op: NumericOp, kind: NumericKind, symbol: string ): string {
	const names: Record< NumericOp[ 'operation' ], string > = {
		dont_change: '',
		set: __( 'Change to', 'wp-woocommerce-products-list' ),
		increase: __( 'Increase by', 'wp-woocommerce-products-list' ),
		decrease: __( 'Decrease by', 'wp-woocommerce-products-list' ),
		regular_minus: __( 'Regular price minus', 'wp-woocommerce-products-list' ),
	};
	const value = op.value === '' ? '…' : op.value;
	const unit = op.percent ? '%' : kind === 'money' ? ` ${ symbol }` : '';

	return `${ __( 'Reads as:', 'wp-woocommerce-products-list' ) } ${ names[ op.operation ] } ${ value }${ unit }`;
}

/**
 * Every text the note can show for this control (the idle hint; each operation read back with its note), each as
 * [bold "Reads as" part, rest]: laid in the note's slot unseen, they make it as tall as the longest at the width it
 * has, so typing "r-20%" or picking an operation never moves the fields below.
 */
export function noteSizers( kind: NumericKind, salePrice: boolean, symbol: string, operations: Array< Pick< NumericOp, 'operation' | 'percent' > > ): Array< [ string, string ] > {
	return [
		[ '', shorthandHint( kind, salePrice ) ],
		...operations
			.filter( ( entry ) => entry.operation !== 'dont_change' )
			.map( ( entry ): [ string, string ] => {
				const sample: NumericOp = { operation: entry.operation, value: kind === 'money' ? '9999.99' : '9999', ...( entry.percent ? { percent: true } : {} ) };

				return [ readsAs( sample, kind, symbol ), hint( sample, salePrice ) ?? '' ];
			} ),
	];
}

/** What the idle note says: the value box takes shorthand. */
export function shorthandHint( kind: NumericKind, salePrice: boolean ): string {
	if ( kind !== 'money' ) {
		return __( 'Type a number to change to it, or +5 / -5 to change each item by that much.', 'wp-woocommerce-products-list' );
	}

	return salePrice
		? __( 'Type a price, +5% / -10% / +2 to change each sale price, or r-20% for the regular price minus 20%.', 'wp-woocommerce-products-list' )
		: __( 'Type a price to change to it, or +5%, -10%, +2 to change each item by that much.', 'wp-woocommerce-products-list' );
}

/**
 * The op a keystroke in the value box makes: shorthand picks the operation
 * (`+5%`, `-2`, `=49.90`, `r-20%`); a bare number goes into the chosen one,
 * or is "change to" when none was chosen; an empty box is "no change"
 * unless the operation was picked in the select.
 */
export function opFromInput( text: string, current: NumericOp, kind: NumericKind, salePrice: boolean, chosen: boolean ): NumericOp {
	const keep = current.round && current.operation !== 'set' ? { round: current.round, ...( current.roundMode ? { roundMode: current.roundMode } : {} ) } : {};

	if ( text.trim() === '' ) {
		return chosen && current.operation !== 'dont_change' ? { ...current, value: '' } : DONT_CHANGE;
	}

	const parsed = parseShorthand( text, kind, salePrice );

	if ( parsed ) {
		return parsed.operation === 'set' ? parsed : { ...parsed, ...keep };
	}

	if ( current.operation === 'dont_change' ) {
		return { operation: 'set', value: text };
	}

	return { ...current, value: text };
}

export interface BulkNumericControlOptions {
	kind: NumericKind;
	settings: Settings;
	/** Shown in the value input while the op is idle: "Mixed" or the shared current value. */
	placeholder?: string;
	/** A read-only companion value (the default-language price). */
	reference?: string | null;
	/** Offer "regular price minus" (sale price fields). */
	salePrice?: boolean;
	/** The currency the field's prices are in, when not the shop's (a language's market). */
	currency?: FieldCurrency;
}

/**
 * Currencies whose shop prices end in whole units (2 149 kr, 499 kr), not
 * in cents: their rounding offers whole-unit price points first, and no
 * öre endings.
 */
export const WHOLE_UNIT_CURRENCIES: ReadonlySet< string > = new Set( [ 'SEK', 'NOK', 'DKK', 'ISK', 'CZK', 'HUF', 'PLN', 'JPY', 'KRW', 'CLP', 'COP', 'IDR', 'HKD', 'TWD', 'CNY' ] );

function wholeLabel( ending: string ): string {
	switch ( ending ) {
		case 'w9':
			return __( 'Round to …9 (2 149, 499)', 'wp-woocommerce-products-list' );
		case 'w49':
			return __( 'Round to …49 or …99', 'wp-woocommerce-products-list' );
		case 'w99':
			return __( 'Round to …99', 'wp-woocommerce-products-list' );
		default:
			return __( 'Round to the nearest 10', 'wp-woocommerce-products-list' );
	}
}

/**
 * The rounding choices next to a relative money op: none, or a price point.
 * A cents currency (€) gets whole units and the ,90 / ,95 / ,99 endings, then
 * the whole-unit points; a kronor currency (SEK, NOK, DKK) whole units and the
 * whole-unit points (…9, …49/…99, …99, nearest 10) only.
 */
export function roundingChoices( settings: Pick< Settings, 'currency' >, decimals: number, currencyCode: string = settings.currency.code ): Array< { value: string; label: string } > {
	if ( decimals !== 2 && decimals !== 0 ) {
		return [];
	}

	const mark = settings.currency.decimalSeparator || '.';
	const whole = WHOLE_UNIT_CURRENCIES.has( currencyCode.toUpperCase() ) || decimals === 0;
	const cents = whole ? [] : ROUNDING_ENDINGS.filter( ( ending ) => ending !== '00' );

	return [
		{ value: '', label: __( 'No rounding', 'wp-woocommerce-products-list' ) },
		...( decimals === 2 ? [ { value: '00', label: __( 'Round to whole units', 'wp-woocommerce-products-list' ) } ] : [] ),
		...cents.map( ( ending ) => ( { value: ending, label: `${ __( 'Round to', 'wp-woocommerce-products-list' ) } …${ mark }${ ending }` } ) ),
		...WHOLE_UNIT_ENDINGS.map( ( ending ) => ( { value: ending, label: wholeLabel( ending ) } ) ),
	];
}

/** Which way the rounding goes. */
export function roundModeChoices(): Array< { value: RoundMode; label: string } > {
	return [
		{ value: 'nearest', label: __( 'Nearest (half up)', 'wp-woocommerce-products-list' ) },
		{ value: 'up', label: __( 'Always up', 'wp-woocommerce-products-list' ) },
		{ value: 'down', label: __( 'Always down', 'wp-woocommerce-products-list' ) },
	];
}

export function createBulkNumericControl( options: BulkNumericControlOptions ): ComponentType< DataFormControlProps< FormData > > {
	const { kind, settings, salePrice = false, currency } = options;
	const rounding = kind === 'money' ? roundingChoices( settings, currency?.decimals ?? settings.currency.decimals, currency?.code ?? settings.currency.code ) : [];
	const modes = roundModeChoices();

	function BulkNumericControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const raw = data[ field.id ];
		const op: NumericOp = isNumericOp( raw ) ? raw : DONT_CHANGE;
		// What was typed ("+5%"), shown while it is what the op came from; the op alone is shown otherwise (a reset, the select).
		const [ draft, setDraft ] = useState< { text: string; op: string } | null >( null );
		const chosenRef = useRef( false );
		const list = useMemo( () => choices( kind, settings, salePrice, currency ), [] );
		const sizers = useMemo( () => noteSizers( kind, salePrice, currency?.symbol ?? settings.currency.symbol, list ), [ list ] );
		const idle = op.operation === 'dont_change';
		const error = validateNumericOp( op, kind, settings, allowsNegative( field.id ) );
		const help = options.reference ? `${ __( 'Default:', 'wp-woocommerce-products-list' ) } ${ options.reference }` : undefined;
		// React's own ids: the two @wordpress/components runtimes (dataviews' inlined one
		// and core's) each count `inspector-*-control-N` from zero and collide.
		const baseId = `wc-pl-bulk-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;
		const note = hint( op, salePrice );
		const roundable = ! idle && op.operation !== 'set';
		// A sign or percent typed in the value picks the operation itself: say which, before anything is saved.
		const resolved = draft && draft.op === JSON.stringify( op ) ? resolvedShorthand( draft.text, op, kind, salePrice, currency?.symbol ?? settings.currency.symbol ) : null;

		const update = ( next: NumericOp ) => onChange( { [ field.id ]: next } );
		const shownValue = draft && draft.op === JSON.stringify( op ) ? draft.text : idle ? '' : op.value;

		return (
			<BaseControl
				__nextHasNoMarginBottom
				id={ `${ baseId }-op` }
				label={ field.label }
				hideLabelFromVision={ hideLabelFromVision }
				help={ help }
				className={ `wc-pl-bulk-numeric${ salePrice ? ' wc-pl-bulk-numeric--sale' : '' }${ error ? ' wc-pl-bulk-numeric--invalid' : '' }` }
			>
				{ /* The operation on a row of its own: "Regular price minus (%)" is read in full, not cut to "Regular pr…". */ }
				<SelectControl
					className="wc-pl-bulk-numeric__op"
					__nextHasNoMarginBottom
					__next40pxDefaultSize
					id={ `${ baseId }-op` }
					aria-label={ `${ field.label }: ${ __( 'operation', 'wp-woocommerce-products-list' ) }` }
					value={ choiceValue( op ) }
					options={ list.map( ( choice ) => ( { value: choice.value, label: choice.label } ) ) }
					onChange={ ( value: string ) => {
						const choice = list.find( ( entry ) => entry.value === value ) ?? list[ 0 ]!;

						chosenRef.current = choice.operation !== 'dont_change';
						setDraft( null );

						update( {
							operation: choice.operation,
							value: op.value,
							percent: choice.percent,
							...( op.round && choice.operation !== 'set' ? { round: op.round, ...( op.roundMode ? { roundMode: op.roundMode } : {} ) } : {} ),
						} );
					} }
				/>
				<HStack alignment="top" spacing={ 2 } className="wc-pl-bulk-numeric__row">
					<TextControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						id={ `${ baseId }-value` }
						aria-label={ `${ field.label }: ${ __( 'value', 'wp-woocommerce-products-list' ) }` }
						className="wc-pl-bulk-numeric__value"
						aria-invalid={ error ? true : undefined }
						aria-describedby={ error ? `${ baseId }-note` : undefined }
						type="text"
						inputMode="decimal"
						placeholder={ idle ? options.placeholder ?? '' : '' }
						value={ shownValue }
						onChange={ ( value: string ) => {
							const next = opFromInput( value, op, kind, salePrice, chosenRef.current );

							setDraft( { text: value, op: JSON.stringify( next ) } );
							update( next );
						} }
					/>
					{ rounding.length > 0 ? (
						// Beside the value and kept in the row (hidden while it does not apply): typing "r-20%" moves nothing
						// below it, and an idle control has no empty band where the rounding would go.
						<div className={ `wc-pl-bulk-numeric__round${ roundable ? '' : ' is-inactive' }` } aria-hidden={ roundable ? undefined : true }>
							<SelectControl
								__nextHasNoMarginBottom
								__next40pxDefaultSize
								id={ `${ baseId }-round` }
								aria-label={ `${ field.label }: ${ __( 'rounding', 'wp-woocommerce-products-list' ) }` }
								value={ op.round ?? '' }
								options={ rounding }
								disabled={ ! roundable }
								tabIndex={ roundable ? undefined : -1 }
								onChange={ ( value: string ) => update( value ? { ...op, round: value } : { operation: op.operation, value: op.value, ...( op.percent ? { percent: true } : {} ) } ) }
							/>
						</div>
					) : null }
				</HStack>
				{ rounding.length > 0 ? (
					// Which way the rounding goes: shown once a rounding is picked (right above it, where the eye already is).
				<div className={ `wc-pl-bulk-numeric__round-mode${ roundable && op.round ? '' : ' is-inactive' }` } aria-hidden={ roundable && op.round ? undefined : true }>
					<SelectControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						id={ `${ baseId }-round-mode` }
						aria-label={ `${ field.label }: ${ __( 'rounding direction', 'wp-woocommerce-products-list' ) }` }
						value={ op.roundMode ?? 'nearest' }
						options={ modes }
						disabled={ ! ( roundable && op.round ) }
						tabIndex={ roundable && op.round ? undefined : -1 }
						onChange={ ( value: string ) => {
							const { roundMode: _previous, ...rest } = op;

							update( value === 'nearest' ? rest : { ...rest, roundMode: value as RoundMode } );
						} }
					/>
				</div>
				) : null }
				{ /* One slot two lines high for what the typed value reads as and the operation's note: neither moves the fields below. */ }
				<Text variant="muted" className="wc-pl-bulk-numeric__note">
					{ /* A half-typed value's problem ("Enter a number.") takes the note's place: it shows at once, and moves nothing. */ }
					<span className={ `wc-pl-bulk-numeric__note-text${ error ? ' is-error' : '' }` } id={ `${ baseId }-note` }>
						<span className="wc-pl-bulk-numeric__resolved" aria-live="polite">
							{ resolved ?? '' }
						</span>
						{ error ?? note ?? ( idle ? shorthandHint( kind, salePrice ) : '' ) }
					</span>
					{ sizers.map( ( [ bold, rest ], index ) => (
						<span key={ index } className="wc-pl-bulk-numeric__note-sizer" aria-hidden="true">
							<span className="wc-pl-bulk-numeric__resolved">{ bold }</span>
							{ rest }
						</span>
					) ) }
				</Text>
			</BaseControl>
		);
	}

	return BulkNumericControl;
}
