/**
 * Copy and clear a language from inside the editor's language tab, the way
 * the rest of the editing works (inline, no dialog): an extension action in
 * group `G` with a `lang` select (gds-woo-i18n's `i18n_copy`/`i18n_clear`)
 * becomes a tool of the tabs `G:<lang>`, with the language fixed to the
 * tab's and the other arguments as inline controls. Such actions leave the
 * action menu (actions/index.ts): the editor is where they run.
 *
 * Prices are only offered for copying between languages that sell in the
 * same currency: copying 79 € into the Swedish price would sell for 79 kr.
 *
 * Each language tab has its own tool settings (a tool is mounted per tab),
 * and a tool can be added to the Update more than once (an SEO title
 * template and an SEO description template): adding resets the form, and
 * changing the form never touches what was added. What was typed into a tab's
 * tools shows again when the tab is revisited (the editor keeps it, `drafts`). "Adjust market prices"
 * runs on the variations of the selected variable parents when "Apply price
 * and sale fields to all variations" is ticked (`parentVariations`).
 */
import { Button, SelectControl, TextControl } from '@wordpress/components';
import { CheckboxControl } from '../ui/checkbox-control';
import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { KeyboardEvent } from 'react';
import type { DeclarativeAction, DeclarativeActionArg, ProductField, ProductListItem, Settings } from '../types';
import { formatMoney, getPath } from '../extensions/declarative';
import type { FieldCurrency } from '../extensions/declarative';
import { isVariableParent, isVariation, parentIdOf, readFieldValue, readReference } from './field-value';
import { itemLabel } from './item-label';
import { ServerPreview, serverPreviewPath, useServerPreview } from './server-preview';

import { isEditorHostedAction, LANG_ARG } from './hosted-actions';

export { isEditorHostedAction };

/** The hosted actions for a tab id like `i18n:se`. */
export function languageToolsFor( actions: DeclarativeAction[], tabId: string ): DeclarativeAction[] {
	const colon = tabId.indexOf( ':' );

	if ( colon <= 0 ) {
		return [];
	}

	const group = tabId.slice( 0, colon );
	const lang = tabId.slice( colon + 1 );

	return actions.filter( ( def ) => isEditorHostedAction( def ) && def.group === group && ( def.args.find( ( arg ) => arg.id === LANG_ARG )?.options ?? [] ).some( ( option ) => option.value === lang ) );
}

const PRICE_OPTION = /(^|[._:])(regular_price|sale_price|price)$/;

/** gds-woo-i18n's transform arg: leave a template alone on products without their own name in the language. */
export const OWN_NAME_ARG = 'own_name';

/** Whether the action copies values from another language (it has a `source` language argument). */
export function copiesBetweenLanguages( def: Pick< DeclarativeAction, 'args' > ): boolean {
	return def.args.some( ( arg ) => arg.id === 'source' && arg.type === 'select' );
}

/**
 * The options of an argument for this run: when the action copies from
 * another language, price fields only between languages of one currency.
 * An action that works in the tab's own currency (adjust market prices,
 * clear) keeps every option.
 */
/**
 * Whether an option (a field) exists on at least one of the items: options
 * without `applies` exist everywhere; name and SEO fields have
 * `applies.variation: false`, so a selection of variations does not offer them.
 */
export function optionAppliesTo( option: DeclarativeActionArg[ 'options' ][ number ], items: readonly ProductListItem[] | undefined ): boolean {
	const applies = option.applies;

	if ( ! applies || ! items || items.length === 0 ) {
		return true;
	}

	return items.some( ( item ) => {
		if ( isVariation( item ) ) {
			return applies.variation === true;
		}

		return applies.product === true || ( Array.isArray( applies.product ) && applies.product.includes( String( item.type ?? '' ) ) );
	} );
}

/** An option that exists only on items with a price of their own (not on variable parents): a price. */
function isSellableOption( option: DeclarativeActionArg[ 'options' ][ number ] ): boolean {
	return Array.isArray( option.applies?.product );
}

/**
 * A tool whose every field is a price ("Adjust market prices"): with "Apply
 * price and sale fields to all variations" it runs on the variations of the
 * selected variable parents, as the EUR price fields do.
 */
export function isSellableTool( def: Pick< DeclarativeAction, 'args' > ): boolean {
	const fieldsArg = def.args.find( ( arg ) => arg.type === 'array' && arg.options.length > 0 );

	return !! fieldsArg && fieldsArg.options.every( isSellableOption );
}

/**
 * The items a tool works on: the editor's rows, and for a price tool the
 * variations reached through the selected variable parents (passed only
 * while "apply to all variations" is ticked and they are loaded).
 */
export function toolItems( def: Pick< DeclarativeAction, 'args' >, items: readonly ProductListItem[], parentVariations?: readonly ProductListItem[] ): ProductListItem[] {
	if ( ! parentVariations?.length || ! isSellableTool( def ) ) {
		return [ ...items ];
	}

	const known = new Set( items.map( ( item ) => item.id ) );

	// The variable parents themselves have no price: their variations stand in for them.
	return [ ...items.filter( ( item ) => ! isVariableParent( item ) ), ...parentVariations.filter( ( variation ) => ! variation._placeholder && ! known.has( variation.id ) ) ];
}

/** How many items a tool runs on, as words: "12 items", or "606 variations of 28 products". */
export function toolTargetsLabel( def: Pick< DeclarativeAction, 'args' | 'scope' >, items: readonly ProductListItem[], parentVariations?: readonly ProductListItem[] ): string {
	const all = toolItems( def, items, parentVariations );
	const ids = toolIds( def as DeclarativeAction, all );
	const known = new Set( items.map( ( item ) => item.id ) );
	const reached = all.filter( ( item ) => ! known.has( item.id ) );

	if ( reached.length === 0 ) {
		return sprintf(
			/* translators: %d: number of items */
			_n( '%d item', '%d items', ids.length, 'wp-woocommerce-products-list' ),
			ids.length
		);
	}

	const parents = new Set( reached.map( parentIdOf ) ).size;
	// The selected rows the tool also runs on itself (simple products, variations picked directly); variable parents have no price.
	const own = ids.length - reached.length;
	const variations = sprintf(
		/* translators: 1: "N variations", 2: "M products" */
		__( '%1$s of %2$s', 'wp-woocommerce-products-list' ),
		sprintf(
			/* translators: %d: number of variations */
			_n( '%d variation', '%d variations', reached.length, 'wp-woocommerce-products-list' ),
			reached.length
		),
		sprintf(
			/* translators: %d: number of variable products */
			_n( '%d product', '%d products', parents, 'wp-woocommerce-products-list' ),
			parents
		)
	);

	return own > 0
		? sprintf(
				/* translators: 1: "N variations of M products", 2: number of other items */
				_n( '%1$s and %2$d other item', '%1$s and %2$d other items', own, 'wp-woocommerce-products-list' ),
				variations,
				own
		  )
		: variations;
}

export function argOptions( arg: DeclarativeActionArg, args: Record< string, unknown >, lang: string, settings: Pick< Settings, 'languages' | 'currency' >, copies = true, items?: readonly ProductListItem[] ): DeclarativeActionArg[ 'options' ] {
	if ( arg.type !== 'array' ) {
		return arg.options;
	}

	const applicable = items ? arg.options.filter( ( option ) => optionAppliesTo( option, items ) ) : arg.options;

	if ( ! copies ) {
		return applicable;
	}

	const currencies = settings.languages?.currencies ?? {};
	const source = typeof args.source === 'string' && args.source ? args.source : settings.languages?.default ?? '';
	const from = currencies[ source ] ?? settings.currency.code;
	const to = currencies[ lang ] ?? settings.currency.code;

	return from === to ? applicable : applicable.filter( ( option ) => ! PRICE_OPTION.test( option.value ) );
}

function defaultsOf( def: DeclarativeAction, lang: string ): Record< string, unknown > {
	const data: Record< string, unknown > = {};

	for ( const arg of def.args ) {
		if ( arg.id === LANG_ARG ) {
			continue;
		}

		if ( arg.default !== undefined && arg.default !== null ) {
			data[ arg.id ] = arg.default;
		} else if ( arg.type === 'boolean' ) {
			data[ arg.id ] = false;
		} else if ( arg.type === 'array' ) {
			data[ arg.id ] = [];
		} else if ( arg.type === 'select' && arg.required ) {
			data[ arg.id ] = arg.options.find( ( option ) => option.value !== lang )?.value ?? arg.options[ 0 ]?.value ?? '';
		} else if ( arg.type === 'text' || arg.type === 'number' || arg.type === 'integer' ) {
			data[ arg.id ] = '';
		}
	}

	return data;
}

/**
 * The text-and-amount arguments that only mean something for some values of
 * the action's `operation` select (the convention gds-woo-i18n's "Edit
 * translated text" and "Adjust market prices" follow): find and replace for
 * find & replace, the prefix/suffix/template text for the others, no amount
 * for "round only". An action without such an operation shows every argument.
 */
export function argShown( arg: DeclarativeActionArg, def: Pick< DeclarativeAction, 'args' >, data: Record< string, unknown > ): boolean {
	const operation = def.args.find( ( entry ) => entry.id === 'operation' && entry.type === 'select' );

	if ( ! operation ) {
		return true;
	}

	const values = new Set( operation.options.map( ( option ) => option.value ) );
	const chosen = String( data.operation ?? '' );

	if ( values.has( 'replace' ) && [ 'find', 'replace', 'case_insensitive' ].includes( arg.id ) ) {
		return chosen === 'replace';
	}

	if ( values.has( 'replace' ) && arg.id === 'text' ) {
		return chosen !== 'replace';
	}

	if ( values.has( 'round' ) && arg.id === 'amount' ) {
		return chosen !== 'round';
	}

	// "Skip products without their own name" is about the template's {name}.
	if ( values.has( 'template' ) && arg.id === OWN_NAME_ARG ) {
		return chosen === 'template';
	}

	return true;
}

/** A required value the run cannot go without, among the arguments shown. */
function isEmptyArg( value: unknown ): boolean {
	return value === undefined || value === null || ( typeof value === 'string' && value.trim() === '' ) || ( Array.isArray( value ) && value.length === 0 );
}

/** What the run is missing before it can go: the text to find, the prefix, the amount. */
export function missingArg( def: DeclarativeAction, data: Record< string, unknown > ): DeclarativeActionArg | null {
	const operation = def.args.find( ( entry ) => entry.id === 'operation' && entry.type === 'select' );

	for ( const arg of def.args ) {
		if ( arg.id === LANG_ARG || ! argShown( arg, def, data ) ) {
			continue;
		}

		// The free-text and amount inputs an operation needs (the server rejects them empty).
		const neededByOperation = operation !== undefined && ( arg.id === 'find' || arg.id === 'text' || arg.id === 'amount' );

		if ( ( arg.required || neededByOperation ) && isEmptyArg( data[ arg.id ] ) ) {
			return arg;
		}
	}

	return null;
}

/** One before → after line of the preview. */
export interface PreviewLine {
	id: number;
	label: string;
	field: string;
	before: string;
	after: string;
	/** What the line is made of that the editor cannot vouch for: {name} from another language, or not loaded. */
	note?: string;
}

/** The name a template's {name} is filled with for one item, the way the server does it (gds-woo-i18n fillTemplate). */
interface TemplateName {
	/** Null: the editor has not loaded the item's name in this language; the server fills it in. */
	text: string | null;
	/** The item has no name of its own in the language: {name} is another language's. */
	fallback: boolean;
	/** The language it comes from, when known. */
	from?: string;
}

function templateName( item: ProductListItem, lang: string, nameField: ProductField | undefined, defaultLang: string ): TemplateName {
	const own = nameField ? readFieldValue( nameField, item ) : undefined;

	if ( typeof own === 'string' && own !== '' ) {
		return { text: own, fallback: false };
	}

	// What the shop shows in the language without a name of its own: a fallback language's (gds_woo_i18n/fallbacks), else the default one.
	const entry = getPath( item, `i18n.${ lang }.name` ) as { effective?: unknown; effectiveLang?: unknown } | undefined;

	if ( entry && typeof entry.effective === 'string' && entry.effective !== '' ) {
		return { text: entry.effective, fallback: true, ...( typeof entry.effectiveLang === 'string' ? { from: entry.effectiveLang } : {} ) };
	}

	const reference = nameField ? readReference( nameField, item ) : undefined;

	if ( typeof reference === 'string' && reference !== '' ) {
		return { text: reference, fallback: true, from: defaultLang };
	}

	if ( own === undefined && reference === undefined ) {
		return { text: null, fallback: false };
	}

	return { text: String( ( item as { name?: unknown } ).name ?? '' ), fallback: true, from: defaultLang };
}

const PREVIEW_SHOWN = 3;

function plainText( value: unknown ): string {
	const text = typeof value === 'string' ? value : typeof value === 'number' ? String( value ) : '';

	return text.includes( '<' ) ? text.replace( /<[^>]*>/g, ' ' ).replace( /\s+/g, ' ' ).trim() : text;
}

function escapeRegExp( text: string ): string {
	return text.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

/**
 * What a text transform (find & replace, prefix, suffix, template) does to
 * the rows, worked out from the values the tab loaded, the way the server
 * does it: rows without their own translation are left alone unless the
 * run edits what they show. A template's {brand} and {category} are filled
 * in by the server; the preview shows them as typed.
 */
export function previewTransform(
	def: DeclarativeAction,
	data: Record< string, unknown >,
	tabId: string,
	items: ProductListItem[],
	fields: ProductField[],
	settings?: Pick< Settings, 'languages' >
): { lines: PreviewLine[]; changes: number; unloaded: number; emptyTemplate: number; fallbackName: number; skippedNoName: number } | null {
	const operation = String( data.operation ?? '' );

	if ( ! [ 'replace', 'prefix', 'suffix', 'template' ].includes( operation ) || ! def.args.some( ( arg ) => arg.id === 'text' ) || missingArg( def, data ) ) {
		return null;
	}

	const chosen = Array.isArray( data.fields ) ? ( data.fields as string[] ) : [];
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const find = String( data.find ?? '' );
	const replace = String( data.replace ?? '' );
	const text = String( data.text ?? '' );
	const ignoreCase = data.case_insensitive !== false;
	const shown = data.base === 'shown';
	const lines: PreviewLine[] = [];
	let changes = 0;
	// Values the editor has not loaded (SEO texts are no bulk field): the preview cannot say what they become.
	let unloaded = 0;
	// Rows where every token of the template is empty: the server refuses them (gds_woo_i18n_empty_template).
	let emptyTemplate = 0;
	// Values whose {name} is another language's (no name of their own in this one), and those left out for it.
	let fallbackName = 0;
	let skippedNoName = 0;
	const lang = tabId.slice( tabId.indexOf( ':' ) + 1 );
	const defaultLang = settings?.languages?.default ?? '';
	const labelOf = ( code: string ): string => settings?.languages?.labels?.[ code ] ?? code;
	const nameField = byId.get( `${ tabId }.name` );
	const tokens = operation === 'template' ? Array.from( new Set( text.match( /\{(name|default_name|brand|category|sku)\}/g ) ?? [] ) ) : [];
	const usesName = tokens.includes( '{name}' );
	const ownNameOnly = data[ OWN_NAME_ARG ] === true;

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		for ( const name of chosen ) {
			const field = byId.get( `${ tabId }.${ name }` );

			if ( ! field ) {
				continue;
			}

			const raw = readFieldValue( field, item );
			const reference = readReference( field, item );

			// Neither the translation nor the value it falls back to is loaded: unknown, not "(not translated)".
			// A template does not need them (its {name} is the item's name).
			if ( raw === undefined && reference === undefined && operation !== 'template' ) {
				unloaded += 1;
				continue;
			}

			const old = typeof raw === 'string' ? raw : '';
			const base = old !== '' || ! shown ? old : typeof reference === 'string' ? reference : '';
			let next = base;
			let note: string | undefined;

			if ( operation === 'replace' ) {
				next = base === '' ? '' : base.replace( new RegExp( escapeRegExp( find ), ignoreCase ? 'gi' : 'g' ), () => replace );
			} else if ( operation === 'prefix' ) {
				next = base === '' || base.startsWith( text ) ? base : text + base;
			} else if ( operation === 'suffix' ) {
				next = base === '' || base.endsWith( text ) ? base : base + text;
			} else {
				const named = usesName ? templateName( item, lang, nameField, defaultLang ) : { text: '', fallback: false };

				if ( usesName && ownNameOnly && named.fallback ) {
					skippedNoName += 1;
					continue;
				}

				const values: Record< string, string | null > = {
					// Not loaded: shown as the token itself, and noted.
					'{name}': named.text,
					'{default_name}': String( ( item as { name?: unknown } ).name ?? '' ),
					'{sku}': String( ( item as { sku?: unknown } ).sku ?? '' ),
					// Filled in by the server: unknown here.
					'{brand}': null,
					'{category}': null,
				};

				if ( tokens.length && tokens.every( ( token ) => values[ token ] === '' ) ) {
					emptyTemplate += 1;
					continue;
				}

				next = text
					.replace( /\{name\}/g, values[ '{name}' ] ?? '{name}' )
					.replace( /\{default_name\}/g, values[ '{default_name}' ] ?? '' )
					.replace( /\{sku\}/g, values[ '{sku}' ] ?? '' );

				if ( usesName && named.fallback ) {
					fallbackName += 1;
					note = named.from
						? sprintf(
								/* translators: 1: language the name comes from, 2: the tab's language */
								__( '{name} is the %1$s name: no %2$s name', 'wp-woocommerce-products-list' ),
								labelOf( named.from ),
								labelOf( lang )
						  )
						: sprintf(
								/* translators: %s: the tab's language */
								__( '{name} is another language\'s name: no %s name', 'wp-woocommerce-products-list' ),
								labelOf( lang )
						  );
				} else if ( usesName && named.text === null ) {
					note = __( '{name} is filled in on save: the name is not loaded here', 'wp-woocommerce-products-list' );
				}
			}

			if ( next.trim() === '' || next === old || ( operation !== 'template' && next === base && old === '' ) ) {
				continue;
			}

			changes += 1;

			if ( lines.length < PREVIEW_SHOWN ) {
				lines.push( {
					id: item.id,
					label: itemLabel( item ),
					field: field.label ?? name,
					before: plainText( old ) || __( '(not translated)', 'wp-woocommerce-products-list' ),
					after: plainText( next ),
					...( note ? { note } : {} ),
				} );
			}
		}
	}

	return { lines, changes, unloaded, emptyTemplate, fallbackName, skippedNoName };
}

/** Price points as [step, offset] in cents (gds-woo-i18n ProductsList::PRICE_POINTS). */
const PRICE_POINTS: Record< string, [ number, number ] > = {
	whole: [ 100, 0 ],
	x9: [ 1000, 900 ],
	x99: [ 10000, 9900 ],
	x95: [ 100, 95 ],
	x90: [ 100, 90 ],
	tens: [ 1000, 0 ],
};

/** The price point nearest to a price in cents (a tie goes up), never zero or below. */
export function pricePoint( cents: number, step: number, offset: number ): number {
	const lower = Math.floor( ( cents - offset ) / step ) * step + offset;
	const upper = lower + step;

	if ( lower <= 0 ) {
		return upper;
	}

	return cents - lower < upper - cents ? lower : upper;
}

/** One price operation in integer cents, as the server does it; null when there is nothing to change. */
export function priceOperation( cents: number | null, operation: string, amount: number | null, rounding: string ): number | null {
	const by = amount ?? 0;
	const amountCents = Math.round( by * 100 );
	let result: number;

	if ( operation === 'set' ) {
		result = amountCents;
	} else if ( cents === null ) {
		return null;
	} else if ( operation === 'increase_percent' ) {
		result = Math.round( ( cents * ( 100 + by ) ) / 100 );
	} else if ( operation === 'decrease_percent' ) {
		result = Math.round( ( cents * ( 100 - by ) ) / 100 );
	} else if ( operation === 'increase_amount' ) {
		result = cents + amountCents;
	} else if ( operation === 'decrease_amount' ) {
		result = cents - amountCents;
	} else {
		result = cents;
	}

	if ( result <= 0 ) {
		return null;
	}

	const point = PRICE_POINTS[ rounding ];

	return point ? pricePoint( result, point[ 0 ], point[ 1 ] ) : result;
}

type MarketPrices = { regular_price: string; sale_price: string };

/** One operation on one of a row's market prices, in cents; a sale from the regular price starts from the regular one. */
export function fieldPriceOperation( current: MarketPrices, field: keyof MarketPrices, operation: string, amount: number | null, rounding: string ): number | null {
	if ( operation === 'sale_from_regular' ) {
		if ( field !== 'sale_price' || current.regular_price === '' ) {
			return null;
		}

		return priceOperation( Math.round( Number( current.regular_price ) * 100 ), 'decrease_percent', amount, rounding );
	}

	const cents = current[ field ] === '' ? null : Math.round( Number( current[ field ] ) * 100 );

	return priceOperation( cents, operation, amount, rounding );
}

/** Whether the action is gds-woo-i18n's "Adjust market prices" (price operations with a rounding). */
export function isPriceTool( def: Pick< DeclarativeAction, 'args' > ): boolean {
	return def.args.some( ( arg ) => arg.id === 'operation' && arg.options.some( ( option ) => option.value === 'increase_percent' ) ) && def.args.some( ( arg ) => arg.id === 'rounding' );
}

export interface PricePreview {
	lines: PreviewLine[];
	changes: number;
	/** Rows whose market prices the editor has not loaded (variations reached through their parent): not previewed. */
	unloaded: number;
	/** Rows the server refuses: the sale price would not be below the regular price. */
	invalid: number;
	lowest: string | null;
	highest: string | null;
}

function priceText( value: number | string, field: ProductField | undefined, settings: Pick< Settings, 'currency' > ): string {
	const currency = ( field as { currency?: FieldCurrency } | undefined )?.currency;

	return currency ? formatMoney( value, currency, settings as Settings ) : String( value );
}

/**
 * What "Adjust market prices" does to the rows, worked out from the market
 * prices the tab loaded (`i18n.{lang}.{price}`: the row's own price, else
 * the converted one the shop sells at, which is where the server starts),
 * with its rounding: "e.g. Collonil Organic Care: 159 kr → 169 kr", the
 * lowest and the highest result, and the rows the server will refuse.
 */
export function previewPrices( def: DeclarativeAction, data: Record< string, unknown >, tabId: string, items: ProductListItem[], fields: ProductField[], settings: Pick< Settings, 'currency' > ): PricePreview | null {
	if ( ! isPriceTool( def ) || missingArg( def, data ) ) {
		return null;
	}

	const operation = String( data.operation ?? '' );
	const rounding = String( data.rounding ?? 'none' );
	const raw = String( data.amount ?? '' ).trim().replace( ',', '.' );
	const amount = operation === 'round' ? null : Number( raw );

	if ( operation !== 'round' && ( raw === '' || ! Number.isFinite( amount ) ) ) {
		return null;
	}

	if ( operation === 'round' && rounding === 'none' ) {
		return null;
	}

	const chosen = ( Array.isArray( data.fields ) ? ( data.fields as string[] ) : [] ).map( ( value ) => ( value.endsWith( '_price' ) ? value : `${ value }_price` ) ) as Array< keyof MarketPrices >;
	const wanted: Array< keyof MarketPrices > = operation === 'sale_from_regular' ? [ 'sale_price' ] : chosen.filter( ( field ) => field === 'regular_price' || field === 'sale_price' );
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const regularField = byId.get( `${ tabId }.regular_price` );
	const saleField = byId.get( `${ tabId }.sale_price` );
	const lines: PreviewLine[] = [];
	let changes = 0;
	let unloaded = 0;
	let invalid = 0;
	let lowest: number | null = null;
	let highest: number | null = null;

	const read = ( field: ProductField | undefined, item: ProductListItem ): { own: string; shown: string } | null => {
		if ( ! field ) {
			return null;
		}

		const own = readFieldValue( field, item );
		const reference = readReference( field, item );

		if ( own === undefined && reference === undefined ) {
			return null;
		}

		const ownText = own === null || own === undefined ? '' : String( own );

		return { own: ownText, shown: ownText !== '' ? ownText : reference === null || reference === undefined ? '' : String( reference ) };
	};

	for ( const item of items ) {
		// Only rows with a price of their own: simple products and variations.
		if ( item._placeholder || isVariableParent( item ) || ! ( isVariation( item ) || [ 'simple', 'external' ].includes( String( item.type ?? '' ) ) ) ) {
			continue;
		}

		const regular = read( regularField, item );
		const sale = read( saleField, item );

		if ( ! regular || ( wanted.includes( 'sale_price' ) && ! sale ) ) {
			unloaded += 1;
			continue;
		}

		const current: MarketPrices = { regular_price: regular.shown, sale_price: sale?.shown ?? '' };
		const next: Partial< MarketPrices > = {};

		for ( const field of wanted ) {
			const result = fieldPriceOperation( current, field, operation, amount, rounding );

			if ( result !== null ) {
				next[ field ] = ( result / 100 ).toFixed( 2 );
			}
		}

		const newRegular = next.regular_price ?? current.regular_price;

		if ( next.sale_price !== undefined && newRegular !== '' && Number( next.sale_price ) >= Number( newRegular ) ) {
			invalid += 1;
			continue;
		}

		for ( const field of wanted ) {
			const value = next[ field ];

			if ( value === undefined ) {
				continue;
			}

			const own = field === 'regular_price' ? regular.own : sale?.own ?? '';

			// Unchanged, or what the shop shows anyway without a price of its own: the server writes nothing.
			if ( own !== '' ? Number( own ) === Number( value ) : Number( current[ field ] ) === Number( value ) ) {
				continue;
			}

			changes += 1;
			lowest = lowest === null ? Number( value ) : Math.min( lowest, Number( value ) );
			highest = highest === null ? Number( value ) : Math.max( highest, Number( value ) );

			if ( lines.length < PREVIEW_SHOWN ) {
				const priceField = field === 'regular_price' ? regularField : saleField;

				lines.push( {
					id: item.id,
					label: itemLabel( item ),
					field: priceField?.label ?? field,
					before: current[ field ] !== '' ? priceText( current[ field ], priceField, settings ) : __( '(no sale)', 'wp-woocommerce-products-list' ),
					after: priceText( value, priceField, settings ),
				} );
			}
		}
	}

	const shownField = wanted.includes( 'regular_price' ) ? regularField : saleField;

	return {
		lines,
		changes,
		unloaded,
		invalid,
		lowest: lowest === null ? null : priceText( lowest, shownField, settings ),
		highest: highest === null ? null : priceText( highest, shownField, settings ),
	};
}

/** The ids an action runs on: variations only when its scope takes them. */
export function toolIds( def: DeclarativeAction, items: ProductListItem[] ): number[] {
	return items
		.filter( ( item ) => ! item._placeholder )
		.filter( ( item ) => ( def.scope === 'product' ? ! isVariation( item ) : def.scope === 'variation' ? isVariation( item ) : true ) )
		.map( ( item ) => item.id );
}

/**
 * A tool run waiting for the editor's Update: in the editor the tools do
 * not save on their own button, they add their run to the same Update (one
 * History batch, one Undo with the field edits).
 */
export interface StagedTool {
	/** `<tab id>:<action id>:<n>`: a tool can be added more than once per language (two templates on two fields). */
	key: string;
	def: DeclarativeAction;
	tabId: string;
	tabLabel: string;
	/** The ids it runs on (resolved again from the editor's rows at Update). */
	ids: number[];
	/** What is sent (only the arguments shown, the language fixed to the tab's). */
	args: Record< string, unknown >;
	/** The settings as typed, to show them again when the tab is revisited. */
	data: Record< string, unknown >;
}

let stagedSequence = 0;

/** A new key for a staged run of the tool in this tab (`<tab id>:<action id>:<n>`). */
export function stagedKey( tabId: string, def: Pick< DeclarativeAction, 'id' > ): string {
	stagedSequence += 1;

	return `${ tabId }:${ def.id }:${ stagedSequence }`;
}

/**
 * The ids a staged run goes to at Update: the editor's rows (as they are
 * then), plus for a price tool the variations of the selected variable
 * parents while "apply to all variations" is ticked.
 */
export function stagedToolIds( entry: Pick< StagedTool, 'def' >, rows: readonly ProductListItem[], parentVariations?: readonly ProductListItem[] ): number[] {
	return toolIds( entry.def, toolItems( entry.def, rows, parentVariations ) );
}

/** The settings of a run in words, to tell two runs of one tool apart: "SEO title · Set from template · “{name} | Widetoes”". */
export function describeToolArgs( def: Pick< DeclarativeAction, 'args' >, args: Record< string, unknown > ): string {
	const parts: string[] = [];

	for ( const arg of def.args ) {
		if ( arg.id === LANG_ARG || ! ( arg.id in args ) ) {
			continue;
		}

		const value = args[ arg.id ];

		if ( arg.type === 'boolean' ) {
			if ( value === true ) {
				parts.push( arg.label );
			}
		} else if ( arg.type === 'array' ) {
			const chosen = Array.isArray( value ) ? ( value as unknown[] ).map( String ) : [];
			const labels = arg.options.filter( ( option ) => chosen.includes( option.value ) ).map( ( option ) => option.label );

			if ( labels.length ) {
				parts.push( labels.join( ', ' ) );
			}
		} else if ( arg.type === 'select' ) {
			const option = arg.options.find( ( entry ) => entry.value === String( value ?? '' ) );

			if ( option && ! ( arg.id === 'rounding' && option.value === 'none' ) ) {
				parts.push( option.label );
			}
		} else if ( value !== undefined && value !== null && String( value ).trim() !== '' ) {
			parts.push( arg.type === 'text' ? `“${ String( value ) }”` : String( value ) );
		}
	}

	return parts.join( ' · ' );
}

export interface LanguageToolsProps {
	tabId: string;
	tabLabel: string;
	items: ProductListItem[];
	settings: Settings;
	/** The field registry, for the preview's current values (optional: no preview without it). */
	fields?: ProductField[];
	disabled?: boolean;
	run( def: DeclarativeAction, ids: number[], args: Record< string, unknown > ): Promise< unknown >;
	/** After a run: the tab's values are reloaded. */
	onDone(): void;
	/** How many tools hold settings that were not run yet (the editor counts them as unsaved). */
	onDirtyChange?( count: number ): void;
	/** Start unfolded (bulk edit: the tools are how a language is changed for many items). */
	defaultOpen?: boolean;
	/** Staging instead of running: the tool's button adds its run to the editor's Update (null takes it out again). */
	stage?( key: string, entry: StagedTool | null ): void;
	/** The runs staged so far, by key. */
	staged?: ReadonlyMap< string, StagedTool >;
	/** "Apply price and sale fields to all variations" is ticked (the price tool then runs on the variations). */
	applyToVariations?: boolean;
	/** The variations of the selected variable parents, once loaded, while that option is ticked. */
	parentVariations?: readonly ProductListItem[];
	/** Kept by the editor: what was typed into each tab's tools, so a tool shows it again when its tab is revisited. */
	drafts?: ToolDrafts;
}

/** A tool's typed settings by `<tab id>:<action id>`, and whether they are unsaved. */
export type ToolDrafts = Map< string, { data: Record< string, unknown >; ranWith: Record< string, unknown >; dirty: boolean } >;

function sameData( a: Record< string, unknown >, b: Record< string, unknown > ): boolean {
	return JSON.stringify( a ) === JSON.stringify( b );
}

type ToolProps = Omit< LanguageToolsProps, 'tabId' | 'onDirtyChange' | 'defaultOpen' | 'drafts' > & { draft?: { get(): { data: Record< string, unknown >; ranWith: Record< string, unknown > } | undefined; set( data: Record< string, unknown >, ranWith: Record< string, unknown > ): void } } & { def: DeclarativeAction; lang: string; tabId: string; onDirty( id: string, dirty: boolean ): void };

/** Why a fields list offers nothing for the selection: prices on variable parents, or names and SEO on variations. */
function nothingAppliesText( def: DeclarativeAction, items: readonly ProductListItem[], applyToVariations: boolean | undefined, parentVariations: readonly ProductListItem[] | undefined ): string {
	if ( isSellableTool( def ) && items.some( isVariableParent ) ) {
		if ( ! applyToVariations ) {
			return __( 'Variable products have no prices of their own. Tick "Also apply to the variations" in Prices to change their variations\' prices.', 'wp-woocommerce-products-list' );
		}

		if ( ! parentVariations?.length ) {
			return __( 'Loading the variations of the selected variable products…', 'wp-woocommerce-products-list' );
		}
	}

	if ( isSellableTool( def ) ) {
		return __( 'None of the selected items has a price of its own.', 'wp-woocommerce-products-list' );
	}

	return __( 'None of these fields exists on the selected items (variations have no name or SEO fields of their own).', 'wp-woocommerce-products-list' );
}

function Tool( { def, lang, tabId, tabLabel, items, settings, fields, disabled, run, onDone, onDirty, stage, staged, applyToVariations, parentVariations, draft }: ToolProps ) {
	const defaults = useMemo( () => defaultsOf( def, lang ), [ def, lang ] );
	// This tool's runs added to the Update in this language, in the order added.
	const stagedEntries = useMemo( () => Array.from( staged?.values() ?? [] ).filter( ( entry ) => entry.tabId === tabId && entry.def.id === def.id ), [ staged, tabId, def.id ] );
	// What was typed before the tab was left shows again.
	const [ data, setData ] = useState< Record< string, unknown > >( () => draft?.get()?.data ?? defaults );
	// What the last run was made with: settings equal to these are not "unsaved".
	const [ ranWith, setRanWith ] = useState< Record< string, unknown > >( () => draft?.get()?.ranWith ?? defaults );
	const [ running, setRunning ] = useState( false );
	const [ confirming, setConfirming ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );
	// How many items the last run went to, until a setting changes: the preview (made from the values before) is not shown again.
	const [ applied, setApplied ] = useState< number | null >( null );
	const confirmRef = useRef< HTMLDivElement >( null );
	// The rows, and for the price tool the variations reached through the selected variable parents.
	const workItems = useMemo( () => toolItems( def, items, applyToVariations ? parentVariations : undefined ), [ def, items, applyToVariations, parentVariations ] );
	const ids = useMemo( () => toolIds( def, workItems ), [ def, workItems ] );
	const copies = copiesBetweenLanguages( def );
	const args = def.args.filter( ( arg ) => arg.id !== LANG_ARG && argShown( arg, def, data ) );
	const missing = missingArg( def, data );
	const preview = useMemo( () => ( fields ? previewTransform( def, data, tabId, workItems, fields, settings ) : null ), [ def, data, tabId, workItems, fields, settings ] );
	const pricePreview = useMemo( () => ( fields ? previewPrices( def, data, tabId, workItems, fields, settings ) : null ), [ def, data, tabId, workItems, fields, settings ] );
	// Changing the form never touches a run already added: that one keeps its own settings until taken out.
	const set = ( id: string, value: unknown ) => {
		setError( null );
		setApplied( null );
		setConfirming( false );
		setData( ( previous ) => ( { ...previous, [ id ]: value } ) );
	};
	// Settings typed but not added (staging) or not run yet.
	const dirty = ! sameData( data, stage ? defaults : ranWith );
	const onDirtyRef = useRef( onDirty );
	const draftRef = useRef( draft );

	useEffect( () => {
		draftRef.current?.set( data, ranWith );
	}, [ data, ranWith ] );

	useEffect( () => {
		onDirtyRef.current = onDirty;
	} );

	useEffect( () => {
		onDirtyRef.current( def.id, dirty );
	}, [ def.id, dirty ] );

	// A tool that leaves (another tab) holds nothing unsaved any more, unless the editor keeps what was typed for the tab's return.
	useEffect( () => () => {
		if ( ! draftRef.current ) {
			onDirtyRef.current( def.id, false );
		}
	}, [ def.id ] );

	// Only the arguments shown are sent; the fields argument only carries what this run may copy (prices dropped across currencies).
	const sentArgs = (): Record< string, unknown > => {
		const sent: Record< string, unknown > = { [ LANG_ARG ]: lang };

		for ( const arg of args ) {
			sent[ arg.id ] = data[ arg.id ];

			if ( arg.type === 'array' && Array.isArray( sent[ arg.id ] ) ) {
				const allowed = new Set( argOptions( arg, data, lang, settings, copies, workItems ).map( ( option ) => option.value ) );

				sent[ arg.id ] = ( sent[ arg.id ] as string[] ).filter( ( value ) => allowed.has( value ) );
			}
		}

		return sent;
	};

	// The server's dry run (tokens resolved, the language {name} comes from), when the integration offers one.
	const serverPath = missing ? null : serverPreviewPath( def, data, settings );
	const serverPreview = useServerPreview( serverPath, ids, serverPath ? sentArgs() : null );
	const serverFieldLabel = ( name: string ): string => fields?.find( ( field ) => field.id === `${ tabId }.${ name }` )?.label ?? name;

	const go = () => {
		setRunning( true );
		setError( null );

		const sent = sentArgs();

		const snapshot = data;
		const count = ids.length;

		run( def, ids, sent )
			.then( () => {
				setRanWith( snapshot );
				setApplied( count );
				onDone();
			} )
			.catch( ( reason: unknown ) => setError( reason instanceof Error ? reason.message : __( 'The action failed.', 'wp-woocommerce-products-list' ) ) )
			.finally( () => setRunning( false ) );
	};

	// A fields list where none of the fields exists on the selection (e.g. names on variations only, prices on variable parents).
	const nothingApplies = args.some( ( arg ) => arg.type === 'array' && arg.options.length > 0 && argOptions( arg, data, lang, settings, copies, workItems ).length === 0 );
	const blocked = disabled || running || ids.length === 0 || nothingApplies;

	const start = () => {
		if ( blocked ) {
			return;
		}

		if ( missing ) {
			/* translators: %s: the label of an input, e.g. "Amount" */
			setError( sprintf( __( 'Fill in "%s" first.', 'wp-woocommerce-products-list' ), missing.label ) );

			return;
		}

		// In the editor the run joins the Update: no question, Update (and Cancel) decide.
		if ( stage ) {
			const sent = sentArgs();

			if ( stagedEntries.some( ( entry ) => sameData( entry.args, sent ) ) ) {
				setError( __( 'This run is already added to Update.', 'wp-woocommerce-products-list' ) );

				return;
			}

			const key = stagedKey( tabId, def );

			stage( key, { key, def, tabId, tabLabel, ids, args: sent, data } );
			// The form is free for the next run (another field, another template); the one added is listed above it.
			setData( defaults );
			setError( null );

			return;
		}

		// A tool saves at once, outside the editor's Update / Cancel: it always asks first, inline (no dialog), and the
		// yes is a press of its own button: an Enter in the tool's inputs only gets here.
		setConfirming( true );
		setTimeout( () => confirmRef.current?.focus(), 0 );
	};

	// Enter in one of the tool's inputs asks to run the tool (never the editor's Update, never the confirm's yes).
	const onKeyDown = ( event: KeyboardEvent< HTMLDivElement > ) => {
		if ( event.key === 'Escape' && confirming ) {
			event.preventDefault();
			event.stopPropagation();
			setConfirming( false );

			return;
		}

		if ( event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox' ) {
			event.preventDefault();
			event.stopPropagation();

			if ( ! confirming ) {
				start();
			}
		}
	};

	const itemsCount = toolTargetsLabel( def, items, applyToVariations ? parentVariations : undefined );

	return (
		<div className="wc-pl-language-tools__tool" onKeyDown={ onKeyDown }>
			<strong className="wc-pl-language-tools__label">{ def.label }</strong>
			{ def.description ? <p className="wc-pl-language-tools__description">{ def.description }</p> : null }
			{ stage && stagedEntries.length ? (
				<ul className="wc-pl-language-tools__staged" role="status">
					{ stagedEntries.map( ( entry ) => (
						<li key={ entry.key }>
							<span>
								{ sprintf(
									/* translators: 1: action label, 2: language, 3: the run's settings, 4: "N items" */
									__( '%1$s (%2$s): %3$s, runs on %4$s with Update.', 'wp-woocommerce-products-list' ),
									def.label,
									tabLabel,
									describeToolArgs( def, entry.args ),
									itemsCount
								) }
							</span>{ ' ' }
							<Button variant="link" onClick={ () => stage( entry.key, null ) }>
								{ __( 'Take it out', 'wp-woocommerce-products-list' ) }
							</Button>
						</li>
					) ) }
				</ul>
			) : null }
			<div className="wc-pl-language-tools__args">
				{ args.map( ( arg ) => {
					if ( arg.type === 'boolean' ) {
						return <CheckboxControl key={ arg.id } __nextHasNoMarginBottom label={ arg.label } checked={ data[ arg.id ] === true } onChange={ ( checked ) => set( arg.id, checked ) } />;
					}

					if ( arg.type === 'select' ) {
						return (
							<SelectControl
								key={ arg.id }
								__nextHasNoMarginBottom
								__next40pxDefaultSize
								label={ arg.label }
								value={ String( data[ arg.id ] ?? '' ) }
								options={ [ ...( arg.required ? [] : [ { value: '', label: '—' } ] ), ...arg.options.filter( ( option ) => option.value !== lang ) ] }
								onChange={ ( value: string ) => set( arg.id, value ) }
							/>
						);
					}

					if ( arg.type === 'array' ) {
						const options = argOptions( arg, data, lang, settings, copies, workItems );
						const inapplicable = arg.options.length - argOptions( arg, data, lang, settings, false, workItems ).length;
						const chosen = Array.isArray( data[ arg.id ] ) ? ( data[ arg.id ] as string[] ) : [];

						return (
							<fieldset key={ arg.id } className="wc-pl-language-tools__fields">
								<legend>{ arg.label }</legend>
								{ options.map( ( option ) => (
									<CheckboxControl
										key={ option.value }
										__nextHasNoMarginBottom
										label={ option.label }
										checked={ chosen.includes( option.value ) }
										onChange={ ( checked ) => set( arg.id, checked ? [ ...chosen, option.value ] : chosen.filter( ( value ) => value !== option.value ) ) }
									/>
								) ) }
								{ options.length === 0 && inapplicable > 0 ? (
									<p className="wc-pl-language-tools__description">{ nothingAppliesText( def, items, applyToVariations, parentVariations ) }</p>
								) : inapplicable > 0 ? (
									<p className="wc-pl-language-tools__description">
										{ sprintf(
											/* translators: %d: number of fields hidden */
											_n( '%d field is hidden: the selected items do not have it.', '%d fields are hidden: the selected items do not have them.', inapplicable, 'wp-woocommerce-products-list' ),
											inapplicable
										) }
									</p>
								) : null }
								{ options.length < arg.options.length - inapplicable ? (
									<p className="wc-pl-language-tools__description">{ __( 'Prices are not copied between languages that sell in different currencies.', 'wp-woocommerce-products-list' ) }</p>
								) : null }
							</fieldset>
						);
					}

					if ( arg.type === 'text' || arg.type === 'number' || arg.type === 'integer' ) {
						const numeric = arg.type !== 'text';

						return (
							<TextControl
								key={ arg.id }
								className={ `wc-pl-language-tools__input${ numeric ? ' is-numeric' : '' }` }
								__nextHasNoMarginBottom
								__next40pxDefaultSize
								label={ arg.label }
								// A decimal amount may be typed with a comma ("12,5"): a text input with a decimal keypad, not type=number.
								type="text"
								inputMode={ arg.type === 'integer' ? 'numeric' : numeric ? 'decimal' : undefined }
								value={ String( data[ arg.id ] ?? '' ) }
								onChange={ ( value: string ) => set( arg.id, value ) }
							/>
						);
					}

					return null;
				} ) }
			</div>
			{ applied !== null && ! dirty ? (
				<p className="wc-pl-language-tools__applied" role="status">
					{ sprintf(
						/* translators: 1: action label, 2: number of items */
						_n( '%1$s applied to %2$d item. Undo it from the notice; Cancel does not undo it.', '%1$s applied to %2$d items. Undo it from the notice; Cancel does not undo it.', applied, 'wp-woocommerce-products-list' ),
						def.label,
						applied
					) }
				</p>
			) : pricePreview ? (
				<div className="wc-pl-language-tools__preview" aria-live="polite">
					{ pricePreview.invalid > 0 ? (
						<p className="wc-pl-language-tools__warning">
							{ sprintf(
								/* translators: %d: number of items */
								_n( '%d item is skipped: its sale price would not be below its regular price.', '%d items are skipped: their sale price would not be below their regular price.', pricePreview.invalid, 'wp-woocommerce-products-list' ),
								pricePreview.invalid
							) }
						</p>
					) : null }
					{ pricePreview.changes === 0 ? (
						<p className="wc-pl-language-tools__description">
							{ pricePreview.unloaded > 0 ? __( 'No preview: the market prices of these items are not loaded in this editor.', 'wp-woocommerce-products-list' ) : __( 'Preview: this changes none of the loaded prices.', 'wp-woocommerce-products-list' ) }
						</p>
					) : (
						<>
							<p className="wc-pl-language-tools__description">
								{ sprintf(
									/* translators: 1: number of prices that change, 2: lowest new price, 3: highest new price */
									_n( 'Preview: %1$d price changes (new prices %2$s – %3$s).', 'Preview: %1$d prices change (new prices %2$s – %3$s).', pricePreview.changes, 'wp-woocommerce-products-list' ),
									pricePreview.changes,
									pricePreview.lowest ?? '',
									pricePreview.highest ?? ''
								) }
								{ pricePreview.unloaded > 0
									? ` ${ sprintf(
											/* translators: %d: number of items */
											_n( '%d item not previewed: its prices are not loaded here.', '%d items not previewed: their prices are not loaded here.', pricePreview.unloaded, 'wp-woocommerce-products-list' ),
											pricePreview.unloaded
									  ) }`
									: '' }
							</p>
							<ul>
								{ pricePreview.lines.map( ( line ) => (
									<li key={ `${ line.id }:${ line.field }` }>
										<span className="wc-pl-language-tools__preview-name">{ line.label }</span> ({ line.field }) <del>{ line.before }</del> → <ins>{ line.after }</ins>
									</li>
								) ) }
							</ul>
						</>
					) }
				</div>
			) : serverPath && serverPreview.result ? (
				<ServerPreview state={ { ...serverPreview, result: serverPreview.result } } fieldLabel={ serverFieldLabel } langLabel={ tabLabel } />
			) : preview ? (
				<div className="wc-pl-language-tools__preview" aria-live="polite">
					{ preview.emptyTemplate > 0 ? (
						<p className="wc-pl-language-tools__warning">
							{ sprintf(
								/* translators: %d: number of values whose template tokens are all empty */
								_n(
									'%d value is skipped: every token in the template is empty for it.',
									'%d values are skipped: every token in the template is empty for them.',
									preview.emptyTemplate,
									'wp-woocommerce-products-list'
								),
								preview.emptyTemplate
							) }
						</p>
					) : null }
					{ preview.fallbackName > 0 ? (
						<p className="wc-pl-language-tools__warning">
							{ sprintf(
								/* translators: 1: number of values, 2: language */
								_n(
									'%1$d value uses another language\'s name for {name}: the product has no %2$s name. Tick "Skip products without their own name" to leave it out.',
									'%1$d values use another language\'s name for {name}: those products have no %2$s name. Tick "Skip products without their own name" to leave them out.',
									preview.fallbackName,
									'wp-woocommerce-products-list'
								),
								preview.fallbackName,
								tabLabel
							) }
						</p>
					) : null }
					{ preview.skippedNoName > 0 ? (
						<p className="wc-pl-language-tools__description">
							{ sprintf(
								/* translators: 1: number of values, 2: language */
								_n( '%1$d value is left as it is: no %2$s name.', '%1$d values are left as they are: no %2$s name.', preview.skippedNoName, 'wp-woocommerce-products-list' ),
								preview.skippedNoName,
								tabLabel
							) }
						</p>
					) : null }
					{ preview.changes === 0 && preview.unloaded > 0 ? (
						<p className="wc-pl-language-tools__description">{ __( 'No preview: the current values of these fields are not loaded in this editor.', 'wp-woocommerce-products-list' ) }</p>
					) : preview.changes === 0 ? (
						<p className="wc-pl-language-tools__description">{ __( 'Preview: this changes none of the loaded values.', 'wp-woocommerce-products-list' ) }</p>
					) : (
						<>
							<p className="wc-pl-language-tools__description">
								{ sprintf(
									/* translators: %d: number of values that change */
									_n( 'Preview: %d value changes.', 'Preview: %d values change.', preview.changes, 'wp-woocommerce-products-list' ),
									preview.changes
								) }
							</p>
							<ul>
								{ preview.lines.map( ( line ) => (
									<li key={ `${ line.id }:${ line.field }` }>
										<span className="wc-pl-language-tools__preview-name">{ line.label }</span> <del>{ line.before }</del> → <ins>{ line.after }</ins>
										{ line.note ? <span className="wc-pl-language-tools__preview-note"> ({ line.note })</span> : null }
									</li>
								) ) }
							</ul>
						</>
					) }
				</div>
			) : null }
			{ error ? (
				<p className="wc-pl-language-tools__error" role="alert">
					{ error }
				</p>
			) : null }
			{ confirming ? (
				<div className="wc-pl-language-tools__confirm" ref={ confirmRef } tabIndex={ -1 } role="group" aria-label={ sprintf( /* translators: %s: action label */ __( 'Confirm %s', 'wp-woocommerce-products-list' ), def.label ) }>
					<p>
						{ def.confirm ? `${ def.confirm } ` : '' }
						{ sprintf(
							/* translators: 1: action label, 2: language, 3: "N items" */
							__( '%1$s (%2$s) saves now to %3$s, separately from Update: Cancel will not undo it (the notice that follows has Undo).', 'wp-woocommerce-products-list' ),
							def.label,
							tabLabel,
							itemsCount
						) }
					</p>
					<div className="wc-pl-language-tools__confirm-buttons">
						<Button
							variant="primary"
							isDestructive={ def.destructive }
							onClick={ () => {
								setConfirming( false );
								go();
							} }
							__next40pxDefaultSize
						>
							{ sprintf(
								/* translators: %s: "N items" */
								__( 'Apply now to %s', 'wp-woocommerce-products-list' ),
								itemsCount
							) }
						</Button>
						<Button variant="tertiary" onClick={ () => setConfirming( false ) } __next40pxDefaultSize>
							{ __( 'Back', 'wp-woocommerce-products-list' ) }
						</Button>
					</div>
				</div>
			) : stage ? (
				<Button variant="secondary" isDestructive={ def.destructive } aria-disabled={ blocked } onClick={ start } __next40pxDefaultSize>
					{ sprintf(
						/* translators: 1: action label, 2: language, 3: "N items" */
						stagedEntries.length ? __( '%1$s: %2$s, add another run to Update (%3$s)', 'wp-woocommerce-products-list' ) : __( '%1$s: %2$s, add to Update (%3$s)', 'wp-woocommerce-products-list' ),
						def.label,
						tabLabel,
						itemsCount
					) }
				</Button>
			) : (
				<Button variant="secondary" isDestructive={ def.destructive } isBusy={ running } aria-disabled={ blocked } onClick={ start } __next40pxDefaultSize>
					{ sprintf(
						/* translators: 1: action label, 2: language, 3: "N items" */
						__( '%1$s: %2$s, apply now to %3$s…', 'wp-woocommerce-products-list' ),
						def.label,
						tabLabel,
						itemsCount
					) }
				</Button>
			) }
		</div>
	);
}

/** "Svenska tools (5): Copy from Suomi, Clear, Find and replace…": what waits inside, by the tools' own names. */
export function toolsSummary( tools: DeclarativeAction[], tabLabel: string ): string {
	const names = tools.map( ( def ) => def.label || def.id ).filter( Boolean );
	const shown = names.slice( 0, 3 ).join( ', ' );

	return sprintf(
		/* translators: 1: language name, 2: number of tools, 3: the first tools' names */
		__( '%1$s tools (%2$d): %3$s', 'wp-woocommerce-products-list' ),
		tabLabel,
		tools.length,
		names.length > 3 ? `${ shown }…` : shown
	);
}

/** The tools of one language tab, folded until opened. */
export function LanguageTools( props: LanguageToolsProps ) {
	const { tabId, settings, onDirtyChange, drafts } = props;
	const tools = languageToolsFor( settings.actions ?? [], tabId );
	const lang = tabId.slice( tabId.indexOf( ':' ) + 1 );
	const dirtyRef = useRef< Set< string > >( new Set() );
	const onDirtyChangeRef = useRef( onDirtyChange );

	useEffect( () => {
		onDirtyChangeRef.current = onDirtyChange;
	} );

	const onDirty = useMemo(
		() => ( id: string, dirty: boolean ) => {
			// With the editor's drafts the count covers every tab's tools, not only the ones on screen.
			if ( drafts ) {
				const key = `${ tabId }:${ id }`;
				const entry = drafts.get( key );

				if ( ( entry?.dirty ?? false ) === dirty ) {
					return;
				}

				drafts.set( key, { data: entry?.data ?? {}, ranWith: entry?.ranWith ?? {}, dirty } );
				onDirtyChangeRef.current?.( Array.from( drafts.values() ).filter( ( value ) => value.dirty ).length );

				return;
			}

			const had = dirtyRef.current.has( id );

			if ( had === dirty ) {
				return;
			}

			if ( dirty ) {
				dirtyRef.current.add( id );
			} else {
				dirtyRef.current.delete( id );
			}

			onDirtyChangeRef.current?.( dirtyRef.current.size );
		},
		[ drafts, tabId ]
	);

	if ( tools.length === 0 ) {
		return null;
	}

	const { defaultOpen: _defaultOpen, onDirtyChange: _onDirtyChange, drafts: _drafts, ...toolProps } = props;
	const draftOf = ( id: string ) =>
		drafts
			? {
					get: () => drafts.get( `${ tabId }:${ id }` ),
					set: ( data: Record< string, unknown >, ranWith: Record< string, unknown > ) => {
						const key = `${ tabId }:${ id }`;

						drafts.set( key, { data, ranWith, dirty: drafts.get( key )?.dirty ?? false } );
					},
				}
			: undefined;

	return (
		<details className="wc-pl-language-tools" open={ props.defaultOpen || undefined }>
			<summary>{ toolsSummary( tools, props.tabLabel ) }</summary>
			{ tools.map( ( def ) => (
				<Tool key={ `${ tabId }:${ def.id }` } { ...toolProps } def={ def } lang={ lang } onDirty={ onDirty } draft={ draftOf( def.id ) } />
			) ) }
		</details>
	);
}
