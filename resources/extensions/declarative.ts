/**
 * Declarative definitions (PHP `wc_products_list/fields|filters|actions`,
 * serialised by src/Registry.php into `window.wcProductsListSettings`) turned
 * into the field and action objects the list renders. gds-woo-i18n ships no
 * JavaScript: every language column, filter and action comes through here.
 */
import { createElement, memo, useState } from '@wordpress/element';
import { doAction } from '@wordpress/hooks';
import { __, sprintf } from '@wordpress/i18n';
import { DataForm } from '../dataviews';
import { ACTIONS } from './hooks';
import type {
	DataViewRenderFieldProps,
	EditConfig,
	Field,
	FieldTypeName,
	NormalizedField,
	Operator,
	RenderModalProps,
} from '../dataviews';
import type {
	DeclarativeAction,
	DeclarativeActionArg,
	DeclarativeField,
	DeclarativeFieldType,
	DeclarativeFilter,
	DeclarativeOption,
	ProductAction,
	ProductField,
	ProductListItem,
	QueryParams,
	Settings,
} from '../types';

/*
 * Keys src/Registry.php may add beyond the contract's DeclarativeField
 * (they are optional, so an older PHP side keeps working):
 *
 * - currency:       ISO code the price field is in (a translation column's
 *                   market currency); defaults to the language's currency
 *                   from `settings.languages.currencies`, then the site's.
 * - precision:      decimals of the price; defaults to the site's.
 * - referenceLabel: what the muted companion value is ("Finnish").
 * - filter.toParams: per option value the query params to send instead of
 *                   `{ [param]: value }`.
 */
export interface DeclarativeFieldExtras {
	currency?: string;
	precision?: number;
	referenceLabel?: string;
	filter?: ( NonNullable< DeclarativeField[ 'filter' ] > & { toParams?: Record< string, Record< string, unknown > > } ) | null;
}

export type DeclarativeFieldInput = DeclarativeField & DeclarativeFieldExtras;

/**
 * Turns a filter's value into wc/v3 list params. The query builder calls it
 * when present, else sends `{ [rest.param]: value }`.
 */
export type ToParams = ( value: unknown, operator: Operator ) => QueryParams;

/** What `fieldFromDeclarative` / `filterFromDeclarative` return: a ProductField plus the filter mapping. */
export type DeclarativeProductField = ProductField & {
	rest: ProductField[ 'rest' ] & { toParams?: ToParams };
	/** Set on `price` fields: the currency the column and its reference value are in (a language's market currency). */
	currency?: FieldCurrency;
};

export interface ActionResult {
	id: number;
	ok: boolean;
	data?: Record< string, unknown >;
	code?: string;
	message?: string;
}

/** `POST /wc-products-list/v1/actions/{action}` response (docs/contracts.md §3.4). */
export interface ActionResponse {
	batch_id: string;
	results: ActionResult[];
	items: ProductListItem[];
}

export type ActionRunner = ( ids: number[], args: Record< string, unknown > ) => Promise< ActionResponse >;

/* -------------------------------------------------------------------------- */
/* Paths                                                                        */
/* -------------------------------------------------------------------------- */

export function getPath( object: unknown, path: string ): unknown {
	let current: unknown = object;

	for ( const segment of path.split( '.' ) ) {
		if ( current === null || typeof current !== 'object' ) {
			return undefined;
		}

		current = ( current as Record< string, unknown > )[ segment ];
	}

	return current;
}

/** `{ a: { b: value } }` for `a.b`, the shape DataForm's `onChange` and the wc/v3 body use. */
export function setPath( path: string, value: unknown ): Record< string, unknown > {
	const result: Record< string, unknown > = {};
	const segments = path.split( '.' );
	let current = result;

	segments.slice( 0, -1 ).forEach( ( segment ) => {
		const next: Record< string, unknown > = {};
		current[ segment ] = next;
		current = next;
	} );

	current[ segments[ segments.length - 1 ] as string ] = value;

	return result;
}

export function isEmptyValue( value: unknown ): boolean {
	return value === null || value === undefined || value === '' || ( Array.isArray( value ) && value.length === 0 );
}

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

const CURRENCY_SYMBOLS: Record< string, string > = {
	EUR: '€',
	USD: '$',
	GBP: '£',
	SEK: 'kr',
	NOK: 'kr',
	DKK: 'kr',
	ISK: 'kr',
	CHF: 'CHF',
	PLN: 'zł',
	CZK: 'Kč',
	JPY: '¥',
	CAD: '$',
	AUD: '$',
};

export interface FieldCurrency {
	code: string;
	symbol: string;
	decimals: number;
}

/** The currency a declarative price field is in: its own, its language's, or the site's. */
export function currencyForField( input: DeclarativeField, settings: Settings ): FieldCurrency {
	const def = input as DeclarativeFieldInput;
	const decimals = typeof def.precision === 'number' ? def.precision : settings.currency.decimals;
	let code = def.currency;

	if ( ! code && def.group && def.group.startsWith( 'i18n:' ) ) {
		code = settings.languages?.currencies?.[ def.group.slice( 'i18n:'.length ) ];
	}

	if ( ! code || code === settings.currency.code ) {
		return { code: settings.currency.code, symbol: settings.currency.symbol, decimals };
	}

	return { code, symbol: CURRENCY_SYMBOLS[ code ] ?? code, decimals };
}

/**
 * Accepts what a user types in the site's locale ("12,50", "1 250") and
 * returns the wc/v3 decimal string ("12.50"), '' for an empty input, or
 * null when it is not a number.
 */
export function parseDecimal( input: unknown, settings: Settings ): string | null {
	if ( typeof input === 'number' ) {
		return Number.isFinite( input ) ? String( input ) : null;
	}

	if ( input === null || input === undefined ) {
		return '';
	}

	let text = String( input ).trim();

	if ( text === '' ) {
		return '';
	}

	const { decimalSeparator, thousandSeparator } = settings.currency;

	if ( thousandSeparator && thousandSeparator !== decimalSeparator ) {
		text = text.split( thousandSeparator ).join( '' );
	}

	text = text.split( ' ' ).join( '' );

	if ( decimalSeparator && decimalSeparator !== '.' ) {
		text = text.replace( decimalSeparator, '.' );
	}

	return /^-?\d+(\.\d+)?$/.test( text ) ? text : null;
}

export function formatMoney( value: unknown, currency: FieldCurrency, settings: Settings ): string {
	const number = typeof value === 'number' ? value : Number.parseFloat( String( value ) );

	if ( ! Number.isFinite( number ) ) {
		return String( value ?? '' );
	}

	const fixed = Math.abs( number ).toFixed( currency.decimals );
	const [ whole = '0', fraction ] = fixed.split( '.' );
	const grouped = whole.replace( /\B(?=(\d{3})+(?!\d))/g, settings.currency.thousandSeparator );
	const amount = ( number < 0 ? '-' : '' ) + grouped + ( fraction ? settings.currency.decimalSeparator + fraction : '' );

	switch ( settings.currency.position ) {
		case 'left':
			return `${ currency.symbol }${ amount }`;
		case 'left_space':
			return `${ currency.symbol } ${ amount }`;
		case 'right':
			return `${ amount }${ currency.symbol }`;
		default:
			return `${ amount } ${ currency.symbol }`;
	}
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

const TYPE_MAP: Record< DeclarativeFieldType, FieldTypeName | undefined > = {
	text: 'text',
	html: 'text',
	price: 'text',
	integer: 'integer',
	number: 'number',
	boolean: 'boolean',
	select: 'text',
	date: 'date',
	datetime: 'datetime',
	media: 'media',
	array: 'array',
};

function stripTags( html: string ): string {
	return html
		.replace( /<[^>]*>/g, ' ' )
		.replace( /&nbsp;/g, ' ' )
		.replace( /&amp;/g, '&' )
		.replace( /&lt;/g, '<' )
		.replace( /&gt;/g, '>' )
		.replace( /&quot;/g, '"' )
		.replace( /&#0?39;/g, "'" )
		.replace( /\s+/g, ' ' )
		.trim();
}

function editControlFor( def: DeclarativeFieldInput, currency: FieldCurrency ): EditConfig | undefined {
	switch ( def.type ) {
		case 'html':
			return { control: 'textarea', rows: 4 };
		case 'price': {
			const suffix = () =>
				createElement( 'span', { className: 'wc-products-list-currency-suffix', 'aria-hidden': 'true' }, currency.symbol );

			return { control: 'text', suffix };
		}
		default:
			return undefined;
	}
}

function displayValue( value: unknown, def: DeclarativeFieldInput, currency: FieldCurrency, settings: Settings ): string {
	switch ( def.type ) {
		case 'price':
			return formatMoney( value, currency, settings );
		case 'boolean':
			return value ? __( 'Yes', 'wp-woocommerce-products-list' ) : __( 'No', 'wp-woocommerce-products-list' );
		case 'select':
			return def.options.find( ( option ) => option.value === String( value ) )?.label ?? String( value );
		case 'html':
			return stripTags( String( value ) );
		default:
			return Array.isArray( value ) ? value.join( ', ' ) : String( value );
	}
}

/** A translation's name column is as wide as the name it translates; other text gets room to read, prices their usual width. */
export const DECLARATIVE_NAME_MIN_WIDTH = 240;

export const DECLARATIVE_TEXT_MIN_WIDTH = 180;

/**
 * The column's default width: the definition's `width` when given, else by
 * type. A translated name squeezed to a hundred pixels ("BREJD Skata Chel…")
 * is unreadable, and the pickers show the column before anyone can resize it.
 */
export function defaultColumnStyle( def: DeclarativeField ): ProductField[ 'columnStyle' ] {
	if ( typeof def.width === 'number' && def.width > 0 ) {
		return { width: def.width };
	}

	switch ( def.type ) {
		case 'price':
		case 'integer':
		case 'number':
			return { width: 120, align: 'end' };
		case 'text':
		case 'html':
			return { minWidth: /(^|[.:_])name$/.test( def.path ) || /(^|[.:_])name$/.test( def.id ) ? DECLARATIVE_NAME_MIN_WIDTH : DECLARATIVE_TEXT_MIN_WIDTH };
		default:
			return undefined;
	}
}

function toOperators( operators: string[] | undefined ): Operator[] {
	const list = ( operators ?? [] ).filter( ( operator ): operator is Operator => typeof operator === 'string' && operator !== '' );

	return list.length > 0 ? list : [ 'is' ];
}

/**
 * A declarative field definition as a ProductField.
 *
 * - `getValue` reads the row at `path`, `setValue` writes the same path (so
 *   DataForm edits nest the way the row does), `rest.write` puts the value at
 *   `writePath` in the request body.
 * - `render` shows the value, or the muted `reference` companion when empty.
 * - `edit.tab` is the group, so `i18n:se` becomes a quick-edit tab.
 * - price fields get a text control with the currency as suffix, locale
 *   parsing on write and a validation rule.
 */
/** A term a translated value falls back on (gds-woo-i18n: `i18n.{lang}.name.untranslated`). */
interface UntranslatedTerm {
	id: number;
	taxonomy?: string;
	name: string;
	edit_link?: string | null;
}

export function fieldFromDeclarative( input: DeclarativeField, settings: Settings ): DeclarativeProductField {
	const def = input as DeclarativeFieldInput;
	const currency = currencyForField( def, settings );
	const editable = def.editable && ! def.readonly;
	const writePath = def.writePath ?? def.path;
	const readValue = ( item: ProductListItem ) => getPath( item, def.path );
	const reference = def.reference ? ( item: ProductListItem ) => getPath( item, def.reference as string ) : undefined;
	const normalizeForWrite = ( value: unknown ): unknown => {
		if ( def.type === 'price' ) {
			return parseDecimal( value, settings ) ?? value;
		}

		if ( def.type === 'integer' && typeof value === 'string' && value !== '' ) {
			const parsed = Number.parseInt( value, 10 );

			return Number.isNaN( parsed ) ? value : parsed;
		}

		return value;
	};

	// The object holding the value (`i18n.se.name` for `i18n.se.name.value`) may say more about this row:
	// a row-level `referenceLabel`, and `untranslated` terms (a variation name built from attribute values without a translation).
	const containerPath = def.path.includes( '.' ) ? def.path.slice( 0, def.path.lastIndexOf( '.' ) ) : '';
	const rowNotes = ( item: ProductListItem ): { label?: string; untranslated: UntranslatedTerm[] } => {
		const container = containerPath ? getPath( item, containerPath ) : null;

		if ( ! container || typeof container !== 'object' ) {
			return { untranslated: [] };
		}

		const { referenceLabel, untranslated } = container as { referenceLabel?: unknown; untranslated?: unknown };

		return {
			label: typeof referenceLabel === 'string' && referenceLabel ? referenceLabel : undefined,
			untranslated: Array.isArray( untranslated ) ? ( untranslated as UntranslatedTerm[] ).filter( ( term ) => term && typeof term === 'object' ) : [],
		};
	};
	const untranslatedMarker = ( terms: UntranslatedTerm[], label: string | undefined ) => {
		if ( ! terms.length ) {
			return null;
		}

		const first = terms[ 0 ]!;
		const text = __( 'untranslated term', 'wp-woocommerce-products-list' );
		const title =
			label ??
			sprintf(
				/* translators: %s: attribute value names */
				__( 'No translation for: %s', 'wp-woocommerce-products-list' ),
				terms.map( ( term ) => term.name ).join( ', ' )
			);

		return first.edit_link
			? createElement( 'a', { className: 'wc-products-list-field__untranslated', href: first.edit_link, title, onClick: ( event: { stopPropagation(): void } ) => event.stopPropagation() }, text )
			: createElement( 'span', { className: 'wc-products-list-field__untranslated', title }, text );
	};

	const renderCell = ( { item, field }: DataViewRenderFieldProps< ProductListItem > ) => {
		const value = field.getValue( { item } );
		const notes = rowNotes( item );
		const marker = untranslatedMarker( notes.untranslated, notes.label );

		if ( ! isEmptyValue( value ) ) {
			return createElement( 'span', { className: 'wc-products-list-field', title: marker ? notes.label : undefined }, displayValue( value, def, currency, settings ), marker ? ' ' : null, marker );
		}

		const fallback = reference?.( item );

		if ( isEmptyValue( fallback ) ) {
			return marker;
		}

		return createElement(
			'span',
			{
				className: 'wc-products-list-field wc-products-list-field--reference',
				title: notes.label ?? def.referenceLabel ?? undefined,
			},
			displayValue( fallback, def, currency, settings ),
			marker ? ' ' : null,
			marker
		);
	};

	const render = memo( renderCell );

	const toParams: ToParams | undefined = def.filter
		? ( value, operator ) => {
				const param = def.filter?.param;
				const map = def.filter?.toParams;
				const values = Array.isArray( value ) ? value : [ value ];
				const mapped = values.filter( ( entry ) => map && String( entry ) in map );

				if ( map && mapped.length > 0 ) {
					return Object.assign( {}, ...mapped.map( ( entry ) => map[ String( entry ) ] ) ) as QueryParams;
				}

				if ( ! param || isEmptyValue( value ) ) {
					return {};
				}

				const sent = Array.isArray( value ) ? value.map( String ) : String( value );

				return operator === 'isNot' || operator === 'isNone' ? { [ `exclude_${ param }` ]: sent } : { [ param ]: sent };
		  }
		: undefined;

	const field: DeclarativeProductField = {
		id: def.id,
		label: def.label || def.id,
		description: def.description || undefined,
		type: TYPE_MAP[ def.type ],
		elements: def.options.length > 0 ? def.options.map( ( option ) => ( { value: option.value, label: option.label } ) ) : undefined,
		Edit: editControlFor( def, currency ),
		readOnly: ! editable,
		enableSorting: def.enableSorting,
		enableGlobalSearch: false,
		enableHiding: true,
		filterBy: def.filter ? { operators: toOperators( def.filter.operators ), isPrimary: false } : false,
		getValue: ( { item } ) => readValue( item ),
		setValue: ( { value } ) => setPath( def.path, value ) as Partial< ProductListItem >,
		render,
		rest: {
			fields: def.restFields.length > 0 ? def.restFields : [ def.path.split( '.' )[ 0 ] as string ],
			read: readValue,
			write: ( value ) => setPath( writePath, normalizeForWrite( value ) ),
			param: def.filter?.param ?? undefined,
			sortParam: def.sortParam ?? undefined,
			applies: {
				product: def.applies.product === true || def.applies.product.length > 0,
				variation: def.applies.variation,
			},
			toParams,
		},
		productTypes: def.applies.product === true ? 'all' : def.applies.product,
		edit: editable
			? {
					group: def.group ?? 'general',
					...( def.tab ?? def.group ? { tab: ( def.tab ?? def.group ) as string } : {} ),
					bulk: def.bulk,
					order: def.order,
			  }
			: false,
		reference,
		source: def.source || 'extension',
		columnStyle: defaultColumnStyle( def ),
		columnGroup: def.group ?? undefined,
	};

	if ( def.type === 'price' ) {
		field.currency = currency;
		field.isValid = {
			custom: ( item, normalized ) => {
				const value = normalized.getValue( { item } );
				const parsed = parseDecimal( value, settings );

				if ( parsed === null ) {
					return sprintf(
						/* translators: %s: an example price in the site's number format */
						__( 'Enter a price like %s.', 'wp-woocommerce-products-list' ),
						`12${ settings.currency.decimalSeparator }50`
					);
				}

				if ( parsed !== '' && Number.parseFloat( parsed ) < 0 ) {
					return __( 'A price cannot be negative.', 'wp-woocommerce-products-list' );
				}

				return null;
			},
		};
	}

	return field;
}

/**
 * A declarative filter as a filter-only field: it has options and operators,
 * never a value, and tells the query builder what to send through
 * `rest.param` or each option's `params`.
 */
export function filterFromDeclarative( def: DeclarativeFilter ): DeclarativeProductField {
	const optionParams = new Map( def.options.map( ( option ) => [ option.value, option.params ] ) );
	const toParams: ToParams = ( value, operator ) => {
		const values = Array.isArray( value ) ? value : [ value ];
		const withParams = values.filter( ( entry ) => {
			const params = optionParams.get( String( entry ) );

			return params && Object.keys( params ).length > 0;
		} );

		if ( withParams.length > 0 ) {
			return Object.assign( {}, ...withParams.map( ( entry ) => optionParams.get( String( entry ) ) ) ) as QueryParams;
		}

		if ( ! def.param || isEmptyValue( value ) ) {
			return {};
		}

		const sent = Array.isArray( value ) ? value.map( String ) : typeof value === 'boolean' ? value : String( value );

		return operator === 'isNot' || operator === 'isNone' ? { [ `exclude_${ def.param }` ]: sent } : { [ def.param ]: sent };
	};

	return {
		id: def.id,
		label: def.label || def.id,
		type: def.type === 'select' ? undefined : def.type,
		elements: def.options.map( ( option ) => ( { value: option.value, label: option.label } ) ),
		filterBy: { operators: toOperators( def.operators ), isPrimary: def.isPrimary },
		getValue: () => undefined,
		render: () => null,
		readOnly: true,
		enableSorting: false,
		enableGlobalSearch: false,
		// A filter is not a column: keep it out of the column pickers.
		enableHiding: false,
		filterOnly: true,
		rest: {
			fields: [],
			param: def.param ?? undefined,
			applies: { product: true, variation: def.variations },
			toParams,
		},
		productTypes: 'all',
		edit: false,
		source: def.source || 'extension',
	};
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

const ARG_TYPE_MAP: Record< Exclude< DeclarativeActionArg[ 'type' ], 'array' >, FieldTypeName > = {
	text: 'text',
	select: 'text',
	boolean: 'boolean',
	integer: 'integer',
	number: 'number',
};

type ArgsData = Record< string, unknown >;

/** The DataForm fields for the scalar args; `array` args get their own checkbox group. */
function argFields( args: DeclarativeActionArg[] ): Field< ArgsData >[] {
	return args
		.filter( ( arg ) => arg.type !== 'array' )
		.map( ( arg ) => ( {
			id: arg.id,
			label: arg.label || arg.id,
			type: ARG_TYPE_MAP[ arg.type as Exclude< DeclarativeActionArg[ 'type' ], 'array' > ],
			elements: arg.options.length > 0 ? arg.options.map( ( option: DeclarativeOption ) => ( { value: option.value, label: option.label } ) ) : undefined,
			isValid: { required: arg.required },
		} ) );
}

/**
 * The form's initial values. A select shows its first option whatever the
 * value is, so a required select without a default starts on that option
 * (what the user sees is what is sent); `array` args start as a list.
 */
export function defaultArgs( args: DeclarativeActionArg[] ): ArgsData {
	const data: ArgsData = {};

	args.forEach( ( arg ) => {
		if ( arg.type === 'array' ) {
			const value = Array.isArray( arg.default ) ? arg.default.map( String ) : typeof arg.default === 'string' && arg.default !== '' ? arg.default.split( ',' ).map( ( v ) => v.trim() ) : [];
			data[ arg.id ] = value.filter( ( v ) => arg.options.length === 0 || arg.options.some( ( option ) => option.value === v ) );

			return;
		}

		if ( arg.type === 'boolean' ) {
			data[ arg.id ] = arg.default ?? false;

			return;
		}

		if ( arg.type === 'select' && isEmptyValue( arg.default ) && arg.required ) {
			data[ arg.id ] = arg.options[ 0 ]?.value ?? '';

			return;
		}

		data[ arg.id ] = arg.default ?? '';
	} );

	return data;
}

export function missingRequired( args: DeclarativeActionArg[], data: ArgsData ): boolean {
	return args.some( ( arg ) => arg.required && isEmptyValue( data[ arg.id ] ) );
}

function ArrayArgControl( { arg, value, onChange }: { arg: DeclarativeActionArg; value: string[]; onChange: ( next: string[] ) => void } ) {
	const name = `wc-products-list-arg-${ arg.id }`;

	return createElement(
		'fieldset',
		{ className: 'wc-products-list-action-modal__group' },
		createElement( 'legend', { className: 'wc-products-list-action-modal__group-label' }, arg.label || arg.id ),
		...arg.options.map( ( option ) => {
			const id = `${ name }-${ option.value }`;
			const checked = value.includes( option.value );

			return createElement(
				'label',
				{ key: option.value, htmlFor: id, className: 'wc-products-list-action-modal__option' },
				createElement( 'input', {
					type: 'checkbox',
					id,
					name,
					value: option.value,
					checked,
					onChange: () => onChange( checked ? value.filter( ( v ) => v !== option.value ) : [ ...value, option.value ] ),
				} ),
				' ',
				option.label
			);
		} )
	);
}

export function actionableIds( items: ProductListItem[] ): number[] {
	return items.filter( ( item ) => ! item._placeholder ).map( ( item ) => item.id );
}

function isEligibleFor( scope: DeclarativeAction[ 'scope' ] ) {
	return ( item: ProductListItem ): boolean => {
		if ( item._placeholder ) {
			return false;
		}

		switch ( scope ) {
			case 'product':
				return item._kind === 'product';
			case 'variation':
				return item._kind === 'variation';
			default:
				return true;
		}
	};
}

/**
 * A declarative action as a DataViews action. Without `confirm` and `args`
 * it runs on click; otherwise a modal collects the args and asks first.
 * `run` is the client's `runAction` bound to the action id (and whatever
 * the actions module does with the response: patch rows, notices).
 */
/**
 * `wcProductsList.actionPerformed` once the server answered: the rows it
 * processed leave the selection (list/selection.ts), so a filter the action
 * just took them out of ("Missing in Svenska") cannot keep offering a bulk
 * edit on rows that are no longer on any page.
 */
export function announceActionPerformed( action: string, response: ActionResponse | undefined ): void {
	const results = Array.isArray( response?.results ) ? response.results : [];

	doAction( ACTIONS.actionPerformed, {
		action,
		ids: results.filter( ( result ) => result.ok ).map( ( result ) => result.id ),
		batchId: response?.batch_id ?? '',
		items: Array.isArray( response?.items ) ? response.items : [],
	} );
}

export function actionFromDeclarative( def: DeclarativeAction, run: ActionRunner ): ProductAction {
	const base = {
		id: def.id,
		label: def.label || def.id,
		icon: def.icon ?? undefined,
		isPrimary: def.isPrimary,
		supportsBulk: def.supportsBulk,
		isEligible: isEligibleFor( def.scope ),
		scope: def.scope,
		capability: def.capability ?? undefined,
		source: def.source || 'extension',
	};

	if ( def.args.length === 0 && ! def.confirm ) {
		return {
			...base,
			callback: ( items, { onActionPerformed } ) => {
				void run( actionableIds( items ), {} )
					.then( ( response ) => {
						announceActionPerformed( def.id, response );
						onActionPerformed?.( items );
					} )
					.catch( () => {} );
			},
		};
	}

	const fields = argFields( def.args );
	const form = { fields: fields.map( ( field ) => field.id ) };
	const arrayArgs = def.args.filter( ( arg ) => arg.type === 'array' );

	const RenderModal = ( { items, closeModal, onActionPerformed }: RenderModalProps< ProductListItem > ) => {
		const [ data, setData ] = useState< ArgsData >( () => defaultArgs( def.args ) );
		const [ isRunning, setIsRunning ] = useState( false );
		const [ error, setError ] = useState< string | null >( null );
		const ids = actionableIds( items );
		const disabled = isRunning || ids.length === 0 || missingRequired( def.args, data );

		const submit = () => {
			setIsRunning( true );
			setError( null );

			run( ids, data )
				.then( ( response ) => {
					announceActionPerformed( def.id, response );
					closeModal?.();
					onActionPerformed?.( items );
				} )
				.catch( ( reason: unknown ) => {
					setIsRunning( false );
					setError( reason instanceof Error ? reason.message : __( 'The action failed.', 'wp-woocommerce-products-list' ) );
				} );
		};

		return createElement(
			'div',
			{ className: 'wc-products-list-action-modal' },
			def.description
				? createElement( 'p', { className: 'wc-products-list-action-modal__description' }, def.description )
				: null,
			fields.length > 0
				? createElement( DataForm< ArgsData >, {
						data,
						fields,
						form,
						onChange: ( changes: Record< string, unknown > ) => setData( ( previous ) => ( { ...previous, ...changes } ) ),
				  } )
				: null,
			...arrayArgs.map( ( arg ) =>
				createElement( ArrayArgControl, {
					key: arg.id,
					arg,
					value: Array.isArray( data[ arg.id ] ) ? ( data[ arg.id ] as string[] ) : [],
					onChange: ( next: string[] ) => setData( ( previous ) => ( { ...previous, [ arg.id ]: next } ) ),
				} )
			),
			def.confirm ? createElement( 'p', { className: 'wc-products-list-action-modal__confirm' }, def.confirm ) : null,
			error ? createElement( 'p', { className: 'wc-products-list-action-modal__error', role: 'alert' }, error ) : null,
			createElement(
				'div',
				{ className: 'wc-products-list-action-modal__buttons' },
				createElement(
					'button',
					{ type: 'button', className: 'components-button is-tertiary', onClick: () => closeModal?.(), disabled: isRunning },
					__( 'Cancel', 'wp-woocommerce-products-list' )
				),
				createElement(
					'button',
					{
						type: 'button',
						className: `components-button ${ def.destructive ? 'is-destructive' : 'is-primary' }`,
						onClick: submit,
						disabled,
						'aria-busy': isRunning,
					},
					isRunning
						? __( 'Working…', 'wp-woocommerce-products-list' )
						: sprintf(
								/* translators: 1: action label, 2: number of selected rows */
								__( '%1$s (%2$d)', 'wp-woocommerce-products-list' ),
								base.label,
								ids.length
						  )
				)
			)
		);
	};

	return {
		...base,
		RenderModal,
		modalHeader: base.label,
		modalSize: 'medium',
	};
}

/** All of a settings payload's declarative fields and filters, in `order`. */
export function fieldsFromSettings( settings: Settings ): DeclarativeProductField[] {
	return [
		...settings.fields.map( ( def ) => fieldFromDeclarative( def, settings ) ),
		...settings.filters.map( ( def ) => filterFromDeclarative( def ) ),
	];
}

/** All of a settings payload's declarative actions, each bound to `runAction( id, … )`. */
export function actionsFromSettings(
	settings: Settings,
	runAction: ( action: string, ids: number[], args: Record< string, unknown > ) => Promise< ActionResponse >
): ProductAction[] {
	return settings.actions.map( ( def ) => actionFromDeclarative( def, ( ids, args ) => runAction( def.id, ids, args ) ) );
}

export type { NormalizedField };
