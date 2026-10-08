/**
 * The bulk control for a money or integer field: an operation select
 * (don't change / set / increase / decrease, ± percent for money) and the
 * value input. The form value for the field is a NumericOp; the real number
 * for each row is only computed at save time.
 */
import { BaseControl, SelectControl, TextControl, __experimentalHStack as HStack, __experimentalText as Text } from '@wordpress/components';
import { useMemo } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { Settings } from '../types';
import { DONT_CHANGE, isNumericOp, validateNumericOp } from './bulk-numeric';
import type { NumericKind, NumericOp } from './bulk-numeric';

export type FormData = Record< string, unknown >;

type OpChoice = { value: string; label: string; operation: NumericOp[ 'operation' ]; percent: boolean };

function choices( kind: NumericKind, settings: Settings ): OpChoice[] {
	const symbol = settings.currency.symbol;
	const list: OpChoice[] = [
		{ value: 'dont_change', label: __( '— No change —', 'wp-woocommerce-products-list' ), operation: 'dont_change', percent: false },
		{ value: 'set', label: __( 'Change to:', 'wp-woocommerce-products-list' ), operation: 'set', percent: false },
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
		},
	];

	if ( kind === 'money' ) {
		list.push(
			{ value: 'increase_percent', label: `${ __( 'Increase by', 'wp-woocommerce-products-list' ) } (%)`, operation: 'increase', percent: true },
			{ value: 'decrease_percent', label: `${ __( 'Decrease by', 'wp-woocommerce-products-list' ) } (%)`, operation: 'decrease', percent: true }
		);
	}

	return list;
}

function choiceValue( op: NumericOp ): string {
	if ( op.operation === 'dont_change' || op.operation === 'set' ) {
		return op.operation;
	}

	return op.percent ? `${ op.operation }_percent` : op.operation;
}

export interface BulkNumericControlOptions {
	kind: NumericKind;
	settings: Settings;
	/** Shown in the value input while the op is idle: "Mixed" or the shared current value. */
	placeholder?: string;
	/** A read-only companion value (the default-language price). */
	reference?: string | null;
}

export function createBulkNumericControl( options: BulkNumericControlOptions ): ComponentType< DataFormControlProps< FormData > > {
	const { kind, settings } = options;

	function BulkNumericControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const raw = data[ field.id ];
		const op: NumericOp = isNumericOp( raw ) ? raw : DONT_CHANGE;
		const list = useMemo( () => choices( kind, settings ), [] );
		const idle = op.operation === 'dont_change';
		const error = validateNumericOp( op, kind, settings );
		const help = options.reference ? `${ __( 'Default:', 'wp-woocommerce-products-list' ) } ${ options.reference }` : undefined;

		const update = ( next: NumericOp ) => onChange( { [ field.id ]: next } );

		return (
			<BaseControl
				__nextHasNoMarginBottom
				id={ `wc-pl-bulk-${ field.id }` }
				label={ field.label }
				hideLabelFromVision={ hideLabelFromVision }
				help={ error ?? help }
				className={ `wc-pl-bulk-numeric${ error ? ' wc-pl-bulk-numeric--invalid' : '' }` }
			>
				<HStack alignment="top" spacing={ 2 } className="wc-pl-bulk-numeric__row">
					<SelectControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
						aria-label={ `${ field.label }: ${ __( 'operation', 'wp-woocommerce-products-list' ) }` }
						value={ choiceValue( op ) }
						options={ list.map( ( choice ) => ( { value: choice.value, label: choice.label } ) ) }
						onChange={ ( value: string ) => {
							const choice = list.find( ( entry ) => entry.value === value ) ?? list[ 0 ]!;

							update( { operation: choice.operation, value: op.value, percent: choice.percent } );
						} }
					/>
					<TextControl
						__nextHasNoMarginBottom
						__next40pxDefaultSize
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
				{ ! idle && op.percent ? <Text variant="muted">{ __( 'Percent of each row’s current value, rounded to the store’s price decimals.', 'wp-woocommerce-products-list' ) }</Text> : null }
			</BaseControl>
		);
	}

	return BulkNumericControl;
}
