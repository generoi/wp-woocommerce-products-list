/**
 * Money is a decimal string in wc/v3 ("189", "12.50"); the shop's
 * separators, symbol position and precision come from the settings payload.
 */
import type { Settings } from '../types';

function toNumber( value: string | number | null | undefined ): number | null {
	if ( value === null || value === undefined || value === '' ) {
		return null;
	}

	const n = typeof value === 'number' ? value : Number( value );

	return Number.isFinite( n ) ? n : null;
}

/** "1 234,50 €" per the shop's settings; '' for empty. */
export function formatPrice( value: string | number | null | undefined, settings: Settings ): string {
	const n = toNumber( value );

	if ( n === null ) {
		return '';
	}

	const { decimals, decimalSeparator, thousandSeparator, symbol, position } = settings.currency;
	const fixed = Math.abs( n ).toFixed( Math.max( 0, decimals ) );
	const [ whole = '0', fraction ] = fixed.split( '.' );
	const grouped = whole.replace( /\B(?=(\d{3})+(?!\d))/g, thousandSeparator );
	const amount = ( n < 0 ? '-' : '' ) + grouped + ( fraction ? decimalSeparator + fraction : '' );

	switch ( position ) {
		case 'left':
			return `${ symbol }${ amount }`;
		case 'left_space':
			return `${ symbol } ${ amount }`;
		case 'right':
			return `${ amount }${ symbol }`;
		case 'right_space':
		default:
			return `${ amount } ${ symbol }`;
	}
}

/**
 * User input → decimal string with a dot ("12,50" → "12.50"); null when
 * empty, undefined when not a number. Accepts both the shop's separators
 * and a plain dot.
 */
export function parsePrice( input: string | number | null | undefined, settings: Settings ): string | null {
	if ( input === null || input === undefined ) {
		return null;
	}

	if ( typeof input === 'number' ) {
		return Number.isFinite( input ) ? roundPrice( input, settings ) : null;
	}

	const { decimalSeparator, thousandSeparator, symbol } = settings.currency;
	let text = input.trim().replace( symbol, '' ).replace( /\s/g, '' );

	if ( text === '' ) {
		return null;
	}

	if ( thousandSeparator && thousandSeparator !== '.' ) {
		text = text.split( thousandSeparator ).join( '' );
	}

	if ( decimalSeparator && decimalSeparator !== '.' ) {
		text = text.replace( decimalSeparator, '.' );
	} else if ( thousandSeparator === '.' && decimalSeparator === ',' ) {
		text = text.split( '.' ).join( '' ).replace( ',', '.' );
	}

	const n = Number( text );

	return Number.isFinite( n ) ? roundPrice( n, settings ) : null;
}

/** Round to the shop's precision; wc/v3 wants a dot and no trailing zeros beyond precision. */
export function roundPrice( value: number, settings: Settings ): string {
	const decimals = Math.max( 0, settings.currency.decimals );
	const factor = 10 ** decimals;
	const rounded = Math.round( ( value + Number.EPSILON ) * factor ) / factor;

	return rounded.toFixed( decimals ).replace( /\.?0+$/, '' ) || '0';
}

export function isValidPrice( value: unknown ): boolean {
	return value === '' || value === null || value === undefined || ( typeof value === 'string' && /^-?\d+(\.\d+)?$/.test( value ) ) || ( typeof value === 'number' && Number.isFinite( value ) );
}
