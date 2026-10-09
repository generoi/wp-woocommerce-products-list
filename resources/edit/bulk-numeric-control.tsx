/**
 * The bulk control for a money or integer field: an operation select
 * (don't change / set / increase / decrease, ± percent for money, "regular
 * price minus" for sale prices) and the value input. The form value for the
 * field is a NumericOp; the real number for each row is only computed at
 * save time.
 */
import { BaseControl, SelectControl, TextControl, __experimentalHStack as HStack, __experimentalText as Text } from '@wordpress/components';
import { useId, useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { Settings } from '../types';
import type { FieldCurrency } from '../extensions/declarative';
import { DONT_CHANGE, isNumericOp, ROUNDING_ENDINGS, validateNumericOp, WHOLE_UNIT_ENDINGS } from './bulk-numeric';
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
			? __( 'Each row’s regular price minus this percent, rounded to the store’s price decimals. Rows without a regular price are skipped.', 'wp-woocommerce-products-list' )
			: __( 'Each row’s regular price minus this amount. Rows without a regular price are skipped.', 'wp-woocommerce-products-list' );
	}

	if ( op.percent ) {
		return salePrice
			? __( 'Percent of each row’s current sale price. Rows without a sale price are skipped; use “Regular price minus” to start a sale.', 'wp-woocommerce-products-list' )
			: __( 'Percent of each row’s current value, rounded to the store’s price decimals.', 'wp-woocommerce-products-list' );
	}

	return salePrice ? __( 'Relative to each row’s current sale price. Rows without a sale price are skipped; use “Regular price minus” to start a sale.', 'wp-woocommerce-products-list' ) : null;
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
		const list = useMemo( () => choices( kind, settings, salePrice, currency ), [] );
		const idle = op.operation === 'dont_change';
		const error = validateNumericOp( op, kind, settings );
		const help = options.reference ? `${ __( 'Default:', 'wp-woocommerce-products-list' ) } ${ options.reference }` : undefined;
		// React's own ids: the two @wordpress/components runtimes (dataviews' inlined one
		// and core's) each count `inspector-*-control-N` from zero and collide.
		const baseId = `wc-pl-bulk-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ useId().replace( /:/g, '' ) }`;
		const note = hint( op, salePrice );

		const update = ( next: NumericOp ) => onChange( { [ field.id ]: next } );

		return (
			<BaseControl
				__nextHasNoMarginBottom
				id={ `${ baseId }-op` }
				label={ field.label }
				hideLabelFromVision={ hideLabelFromVision }
				help={ error ?? help }
				className={ `wc-pl-bulk-numeric${ error ? ' wc-pl-bulk-numeric--invalid' : '' }` }
			>
				<HStack alignment="top" spacing={ 2 } className="wc-pl-bulk-numeric__row">
					<SelectControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						id={ `${ baseId }-op` }
						aria-label={ `${ field.label }: ${ __( 'operation', 'wp-woocommerce-products-list' ) }` }
						value={ choiceValue( op ) }
						options={ list.map( ( choice ) => ( { value: choice.value, label: choice.label } ) ) }
						onChange={ ( value: string ) => {
							const choice = list.find( ( entry ) => entry.value === value ) ?? list[ 0 ]!;

							update( {
								operation: choice.operation,
								value: op.value,
								percent: choice.percent,
								...( op.round && choice.operation !== 'set' ? { round: op.round, ...( op.roundMode ? { roundMode: op.roundMode } : {} ) } : {} ),
							} );
						} }
					/>
					<TextControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						id={ `${ baseId }-value` }
						aria-label={ `${ field.label }: ${ __( 'value', 'wp-woocommerce-products-list' ) }` }
						className="wc-pl-bulk-numeric__value"
						type="text"
						inputMode="decimal"
						disabled={ idle }
						placeholder={ idle ? options.placeholder ?? '' : '' }
						value={ idle ? '' : op.value }
						onChange={ ( value: string ) => update( { ...op, value } ) }
					/>
				</HStack>
				{ rounding.length > 0 && ! idle && op.operation !== 'set' ? (
					<SelectControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						id={ `${ baseId }-round` }
						className="wc-pl-bulk-numeric__round"
						aria-label={ `${ field.label }: ${ __( 'rounding', 'wp-woocommerce-products-list' ) }` }
						value={ op.round ?? '' }
						options={ rounding }
						onChange={ ( value: string ) => update( value ? { ...op, round: value } : { operation: op.operation, value: op.value, ...( op.percent ? { percent: true } : {} ) } ) }
					/>
				) : null }
				{ rounding.length > 0 && ! idle && op.operation !== 'set' && op.round ? (
					<SelectControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						id={ `${ baseId }-round-mode` }
						className="wc-pl-bulk-numeric__round"
						aria-label={ `${ field.label }: ${ __( 'rounding direction', 'wp-woocommerce-products-list' ) }` }
						value={ op.roundMode ?? 'nearest' }
						options={ modes }
						onChange={ ( value: string ) => {
							const { roundMode: _previous, ...rest } = op;

							update( value === 'nearest' ? rest : { ...rest, roundMode: value as RoundMode } );
						} }
					/>
				) : null }
				{ note ? <Text variant="muted">{ note }</Text> : null }
			</BaseControl>
		);
	}

	return BulkNumericControl;
}
