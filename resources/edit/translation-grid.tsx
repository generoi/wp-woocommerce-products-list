/**
 * "Translate product by product": a spreadsheet-style grid on a bulk
 * edit's language tab, one row per selected product with its name and short
 * description in that language, the text the shop shows now as the
 * reference, and Enter moving down the column.
 *
 * What is typed is kept in a TranslationStore owned by the editor (so a tab
 * switch keeps it) and saved with Update, in its History batch, as one
 * products/batch request per hundred products: the payloads come from the
 * field registry (`i18n:<lang>.name`, `i18n:<lang>.short_description`), so
 * gds-woo-i18n's own write path, slug rules and change log apply. The
 * inputs are uncontrolled: typing re-renders nothing but the input.
 *
 * A short description that is plain paragraphs is edited as text (blank
 * line between paragraphs) and stored as paragraphs again; one with other
 * markup is edited as its HTML.
 */
import { Button } from '@wordpress/components';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { KeyboardEvent } from 'react';
import type { ProductField, ProductListItem, Settings } from '../types';
import { CheckboxControl } from '../ui/checkbox-control';
import { getPath } from '../extensions/declarative';
import { isPlainObject, isVariation, mergeFragments, readFieldValue, readReference } from './field-value';
import { writeItem } from './expect';
import { buildPayload } from './payload';
import { hydrateSelection } from './hydrate';
import { itemLabel } from './item-label';

/** The translated texts the grid edits. */
export const GRID_FIELDS = [ 'name', 'short_description' ] as const;
export type GridField = ( typeof GRID_FIELDS )[ number ];
/** Rows shown at once; "Show more" adds as many again. */
export const GRID_PAGE = 100;

type Listener = ( count: number ) => void;

/** Edits by product id, then by registry field id (`i18n:se.name`). */
export class TranslationStore {
	private edits = new Map< number, Map< string, string > >();
	/**
	 * The stored value each edit was typed over, as the grid showed it when the
	 * first character was typed: the save's expected value (`_wcpl_expect`).
	 * Kept until the edit is taken out, never replaced by a value a later load
	 * brought (the input keeps the typed text and never showed that one).
	 */
	private originals = new Map< number, Map< string, string > >();
	private listeners = new Set< Listener >();

	get( id: number, fieldId: string ): string | undefined {
		return this.edits.get( id )?.get( fieldId );
	}

	/** The stored value an edit was typed over (undefined: the field is not edited). */
	originalOf( id: number, fieldId: string ): string | undefined {
		return this.edits.get( id )?.has( fieldId ) ? this.originals.get( id )?.get( fieldId ) : undefined;
	}

	/**
	 * Record a value typed over `stored` (the value the row holds now). The
	 * first stored value of an edit is kept as its base; a value equal to that
	 * base (typed back to what was shown) or to the stored one (nothing to
	 * write) takes the edit out again. Typed back to the base, the base stays
	 * (until the cell is shown the stored value again, showsStored): the input
	 * shows the text typed over it, so a later keystroke must expect it, never
	 * a value a reload brought. Typed to a newer stored value, the input shows
	 * exactly what is stored now, so the old base goes.
	 */
	set( id: number, fieldId: string, value: string, stored: string ): void {
		const before = this.count();
		const row = this.edits.get( id ) ?? new Map< string, string >();
		const bases = this.originals.get( id ) ?? new Map< string, string >();
		const base = bases.get( fieldId ) ?? stored;

		if ( value === base ) {
			row.delete( fieldId );
			bases.set( fieldId, base );
		} else if ( value === stored ) {
			row.delete( fieldId );
			bases.delete( fieldId );
		} else {
			row.set( fieldId, value );
			bases.set( fieldId, base );
		}

		if ( bases.size ) {
			this.originals.set( id, bases );
		} else {
			this.originals.delete( id );
		}

		if ( row.size ) {
			this.edits.set( id, row );
		} else {
			this.edits.delete( id );
		}

		if ( this.count() !== before ) {
			this.emit();
		}
	}

	/**
	 * A cell with no edit shows the stored value again (a reload put it in the
	 * input): the next keystroke is typed over that value, so a base kept from
	 * text typed back earlier goes.
	 */
	showsStored( id: number, fieldId: string ): void {
		if ( this.edits.get( id )?.has( fieldId ) ) {
			return;
		}

		const bases = this.originals.get( id );

		bases?.delete( fieldId );

		if ( bases && ! bases.size ) {
			this.originals.delete( id );
		}
	}

	/** Products with at least one edit. */
	count(): number {
		return this.edits.size;
	}

	/** Every edited product with its edits as a field-id map (the shape buildPayload takes). */
	entries(): Array< [ number, Record< string, string > ] > {
		return Array.from( this.edits.entries(), ( [ id, row ] ) => [ id, Object.fromEntries( row ) ] );
	}

	/** The stored values a product's edits were typed over, by field id (what the save expects to find). */
	originalsOf( id: number ): Record< string, string > {
		const row = this.edits.get( id );
		const bases = this.originals.get( id );

		// Only the fields this Update writes: a field typed back to its original sends nothing and expects nothing.
		return Object.fromEntries( Array.from( bases ?? [] ).filter( ( [ fieldId ] ) => row?.has( fieldId ) ) );
	}

	/** Drop the given products' edits (saved), or all of them. */
	clear( ids?: number[] ): void {
		const before = this.count();

		if ( ids ) {
			ids.forEach( ( id ) => {
				this.edits.delete( id );
				this.originals.delete( id );
			} );
		} else {
			this.edits.clear();
			this.originals.clear();
		}

		if ( this.count() !== before ) {
			this.emit();
		}
	}

	subscribe( listener: Listener ): () => void {
		this.listeners.add( listener );

		return () => {
			this.listeners.delete( listener );
		};
	}

	private emit(): void {
		const count = this.count();

		this.listeners.forEach( ( listener ) => listener( count ) );
	}
}

/**
 * The request item of one product's grid edits: the payload from the field
 * registry plus `_wcpl_expect` with the stored values the edits were typed
 * over (as the grid loaded them), so a translation saved meanwhile in another
 * tab or by another user is refused (409), never overwritten.
 */
export function translationWriteItem( row: ProductListItem, edits: Record< string, string >, originals: Record< string, string >, fields: ProductField[], settings: Settings ): { id: number } & Record< string, unknown > {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	// The row as the grid saw it: each edited field's loaded value written back at its read path (`i18n.se.name.value`).
	let base: Record< string, unknown > = row as Record< string, unknown >;

	for ( const [ fieldId, original ] of Object.entries( originals ) ) {
		const fragment = byId.get( fieldId )?.setValue?.( { item: row, value: original } );

		if ( isPlainObject( fragment ) ) {
			base = mergeFragments( base, fragment );
		}
	}

	return writeItem( base as ProductListItem, buildPayload( row, edits, fields, settings ) );
}

const ENTITIES: Record< string, string > = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ' };

function decode( text: string ): string {
	return text.replace( /&(?:amp|lt|gt|quot|#0?39|nbsp);/g, ( entity ) => ENTITIES[ entity ] ?? entity );
}

function encode( text: string ): string {
	return text.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
}

/** HTML made only of paragraphs and line breaks (and entities): editable as plain text. */
export function isPlainParagraphs( html: string ): boolean {
	return ! /<(?!\/?p>|br\s*\/?>)/i.test( html.replace( /<p\s*>/gi, '<p>' ) );
}

/** Stored HTML → the text the grid shows: paragraphs as blank lines, breaks as newlines, entities decoded. */
export function htmlToGridText( html: string ): string {
	if ( ! isPlainParagraphs( html ) ) {
		return html;
	}

	return decode(
		html
			.replace( /\r\n/g, '\n' )
			.replace( /<br\s*\/?>\n?/gi, '\n' )
			.replace( /<\/p>\s*<p\s*>/gi, '\n\n' )
			.replace( /<\/?p\s*>/gi, '' )
	).trim();
}

/** The grid's text → HTML to store, in the shape of the value it replaces (with or without `<p>`). */
export function gridTextToHtml( text: string, original: string ): string {
	if ( ! isPlainParagraphs( original ) ) {
		return text;
	}

	const paragraphs = text
		.replace( /\r\n/g, '\n' )
		.split( /\n{2,}/ )
		.map( ( part ) => part.trim() )
		.filter( Boolean );

	if ( ! /<p[\s>]/i.test( original ) ) {
		return paragraphs.map( encode ).join( '\n\n' );
	}

	return paragraphs.map( ( part ) => `<p>${ encode( part ).replace( /\n/g, '<br />\n' ) }</p>` ).join( '\n' );
}

function stringOf( value: unknown ): string {
	return typeof value === 'string' ? value : '';
}

/** What the shop shows now in the language when there is no own text: the fallback's (`effective`) or the default language's. */
function shownText( item: ProductListItem, field: ProductField | undefined, path: string ): string {
	const entry = getPath( item, path ) as { effective?: unknown } | undefined;

	if ( entry && typeof entry.effective === 'string' && entry.effective !== '' ) {
		return entry.effective;
	}

	return field ? stringOf( readReference( field, item ) ) : '';
}

export interface TranslationGridProps {
	/** The language tab, `i18n:<lang>`. */
	tabId: string;
	tabLabel: string;
	items: ProductListItem[];
	fields: ProductField[];
	settings: Pick< Settings, 'languages' >;
	store: TranslationStore;
	disabled?: boolean;
	/** Changes after an Update wrote translations: an unfolded grid loads its texts again. */
	reload?: number;
	/** Load the rows' texts in this language (tests pass their own). */
	load?: typeof hydrateSelection;
}

/** The registry fields the grid writes on this tab, by grid field. */
export function gridFieldsOf( tabId: string, fields: ProductField[] ): Partial< Record< GridField, ProductField > > {
	const found: Partial< Record< GridField, ProductField > > = {};

	for ( const name of GRID_FIELDS ) {
		const field = fields.find( ( entry ) => entry.id === `${ tabId }.${ name }` );

		if ( field ) {
			found[ name ] = field;
		}
	}

	return found;
}

interface RowProps {
	item: ProductListItem;
	tabId: string;
	lang: string;
	gridFields: Partial< Record< GridField, ProductField > >;
	store: TranslationStore;
	disabled?: boolean;
	defaultLabel: string;
}

/** The text a cell shows for a stored value. */
function cellText( name: GridField, stored: string ): string {
	return name === 'short_description' ? htmlToGridText( stored ) : decode( stored );
}

/** Put a stored value's text in an untouched (uncontrolled) cell. */
function showText( input: HTMLInputElement | HTMLTextAreaElement, text: string ): void {
	if ( input.value !== text ) {
		input.value = text;
	}
}

const GridRow = memo( function GridRow( { item, tabId, lang, gridFields, store, disabled, defaultLabel }: RowProps ) {
	const inputs = useRef< Partial< Record< GridField, HTMLInputElement | HTMLTextAreaElement | null > > >( {} );

	// The inputs are uncontrolled: a reload (the grid unfolded again) that brings another stored value
	// must show it in every cell the user has not typed in, so the value an edit is typed over (its
	// expected value) is always one the cell showed.
	useLayoutEffect( () => {
		for ( const name of GRID_FIELDS ) {
			const field = gridFields[ name ];
			const input = inputs.current[ name ];

			if ( ! field || ! input || store.get( item.id, field.id ) !== undefined ) {
				continue;
			}

			showText( input, cellText( name, stringOf( readFieldValue( field, item ) ) ) );
			store.showsStored( item.id, field.id );
		}
	} );

	const cell = ( name: GridField ) => {
		const field = gridFields[ name ];

		if ( ! field ) {
			return <td key={ name } />;
		}

		const stored = stringOf( readFieldValue( field, item ) );
		const isHtml = name === 'short_description';
		const shown = cellText( name, stored );
		const edited = store.get( item.id, field.id );
		const base = store.originalOf( item.id, field.id );
		// Saved meanwhile (another tab or user) over the value this edit was typed over: Update refuses it (409).
		const changedSince = edited !== undefined && base !== undefined && base !== stored;
		const reference = shownText( item, field, `i18n.${ lang }.${ name }` );
		const referenceText = isHtml ? htmlToGridText( reference ) : decode( reference );
		const onChange = ( value: string ) => {
			const next = isHtml ? gridTextToHtml( value, stored ) : value;

			store.set( item.id, field.id, next, stored );
		};
		const common = {
			className: 'wc-pl-translate__input',
			'data-grid-col': name,
			'aria-label': `${ field.label ?? name }: ${ itemLabel( item ) }`,
			ref: ( element: HTMLInputElement | HTMLTextAreaElement | null ) => {
				inputs.current[ name ] = element;
			},
			defaultValue: edited !== undefined ? ( isHtml ? htmlToGridText( edited ) : edited ) : shown,
			placeholder: referenceText.slice( 0, 200 ),
			disabled,
		};

		return (
			<td key={ name } data-col={ name }>
				{ isHtml ? (
					<textarea { ...common } rows={ 2 } onChange={ ( event ) => onChange( event.currentTarget.value ) } />
				) : (
					<input type="text" { ...common } onChange={ ( event ) => onChange( event.currentTarget.value ) } />
				) }
				{ changedSince ? (
					<span className="wc-pl-translate__reference wc-pl-translate__changed" role="status">
						{ sprintf(
							/* translators: %s: the translation saved meanwhile */
							__( 'Changed by someone else since you started typing, now: %s. Update will not write over it.', 'wp-woocommerce-products-list' ),
							cellText( name, stored ).slice( 0, 120 ) || __( '(empty)', 'wp-woocommerce-products-list' )
						) }
					</span>
				) : null }
				{ stored === '' && referenceText ? (
					<span className="wc-pl-translate__reference" title={ referenceText }>
						{ defaultLabel }: { referenceText.length > 120 ? `${ referenceText.slice( 0, 120 ) }…` : referenceText }
					</span>
				) : null }
				{ isHtml && stored !== '' && ! isPlainParagraphs( stored ) ? <span className="wc-pl-translate__reference">{ __( 'HTML', 'wp-woocommerce-products-list' ) }</span> : null }
			</td>
		);
	};

	return (
		<tr data-tab={ tabId }>
			<th scope="row" className="wc-pl-translate__name">
				{ itemLabel( item ) }
			</th>
			{ GRID_FIELDS.map( cell ) }
		</tr>
	);
} );

/** Enter in a cell (not Shift+Enter in a textarea) moves to the same column one row down, Shift+Enter in an input one up. */
export function onGridKeyDown( event: KeyboardEvent< HTMLTableElement > ): void {
	const target = event.target as HTMLElement;
	const column = target.getAttribute( 'data-grid-col' );

	if ( event.key !== 'Enter' || ! column || event.metaKey || event.ctrlKey || event.altKey ) {
		return;
	}

	const isTextarea = target.tagName === 'TEXTAREA';

	if ( isTextarea && event.shiftKey ) {
		// A new line in the description.
		return;
	}

	event.preventDefault();
	event.stopPropagation();

	const cells = Array.from( event.currentTarget.querySelectorAll< HTMLElement >( `[data-grid-col="${ column }"]` ) );
	const index = cells.indexOf( target );
	const next = cells[ index + ( event.shiftKey ? -1 : 1 ) ];

	next?.focus();

	if ( next instanceof HTMLInputElement ) {
		next.select();
	}
}

export function TranslationGrid( { tabId, tabLabel, items, fields, settings, store, disabled, reload = 0, load = hydrateSelection }: TranslationGridProps ) {
	const lang = tabId.slice( tabId.indexOf( ':' ) + 1 );
	const gridFields = useMemo( () => gridFieldsOf( tabId, fields ), [ tabId, fields ] );
	const products = useMemo( () => items.filter( ( item ) => ! item._placeholder && ! isVariation( item ) ), [ items ] );
	const skippedVariations = items.length - products.length;
	const [ rows, setRows ] = useState< Map< number, ProductListItem > | null >( null );
	const [ failed, setFailed ] = useState( false );
	const [ onlyMissing, setOnlyMissing ] = useState( false );
	const [ shown, setShown ] = useState( GRID_PAGE );
	const [ open, setOpen ] = useState( false );
	const [ count, setCount ] = useState( () => store.count() );
	const idsKey = products.map( ( item ) => item.id ).join( ',' );
	const loadRef = useRef( load );

	useEffect( () => store.subscribe( setCount ), [ store ] );

	// The texts of this language load when the grid is unfolded (not with the tab), once per selection,
	// and again after an Update wrote translations: the saved cells show the stored text (not the one
	// loaded before), a refused cell says what is stored now, and the next edit expects that.
	useEffect( () => {
		if ( ! open || ! products.length ) {
			return;
		}

		let live = true;
		const wanted = [ 'id', 'name', 'type', 'parent_id', 'sku', ...GRID_FIELDS.map( ( name ) => `i18n.${ lang }.${ name }` ) ];

		setFailed( false );
		loadRef
			.current( products, wanted )
			.then( ( { items: loaded } ) => {
				if ( live ) {
					setRows( new Map( loaded.map( ( row ) => [ row.id, row ] ) ) );
				}
			} )
			.catch( () => live && setFailed( true ) );

		return () => {
			live = false;
		};
		// idsKey stands for the products.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ open, idsKey, lang, reload ] );

	if ( ! gridFields.name && ! gridFields.short_description ) {
		return null;
	}

	const defaultLabel = settings.languages?.labels?.[ settings.languages.default ] ?? __( 'Default', 'wp-woocommerce-products-list' );
	const loadedRows = rows ? products.map( ( item ) => rows.get( item.id ) ).filter( ( row ): row is ProductListItem => Boolean( row ) ) : [];
	const missing = ( row: ProductListItem ) => GRID_FIELDS.some( ( name ) => gridFields[ name ] && stringOf( readFieldValue( gridFields[ name ]!, row ) ) === '' );
	const listed = onlyMissing ? loadedRows.filter( ( row ) => missing( row ) || store.get( row.id, gridFields.name?.id ?? '' ) !== undefined ) : loadedRows;

	return (
		<details className="wc-pl-translate" open={ open } onToggle={ ( event ) => setOpen( ( event.currentTarget as HTMLDetailsElement ).open ) }>
			<summary>
				{ sprintf(
					/* translators: %s: language */
					__( 'Translate product by product (%s)', 'wp-woocommerce-products-list' ),
					tabLabel
				) }
				{ count > 0
					? ` · ${ sprintf(
							/* translators: %d: number of products with typed translations */
							_n( '%d product changed', '%d products changed', count, 'wp-woocommerce-products-list' ),
							count
					  ) }`
					: '' }
			</summary>
			<p className="wc-pl-translate__help">
				{ __( 'Type each product\'s own text. Enter moves down the column, Shift+Enter up (in a description Shift+Enter is a new line). Saved with Update.', 'wp-woocommerce-products-list' ) }
				{ skippedVariations > 0
					? ` ${ sprintf(
							/* translators: %d: number of variations */
							_n( '%d variation is not listed: variations take their name from the product.', '%d variations are not listed: variations take their name from the product.', skippedVariations, 'wp-woocommerce-products-list' ),
							skippedVariations
					  ) }`
					: '' }
			</p>
			{ open && ! products.length ? <p>{ __( 'No products selected: only variations, which have no name of their own.', 'wp-woocommerce-products-list' ) }</p> : null }
			{ open && products.length && ! rows && ! failed ? <p aria-live="polite">{ __( 'Loading the translations…', 'wp-woocommerce-products-list' ) }</p> : null }
			{ failed ? <p role="alert">{ __( 'The translations could not be loaded.', 'wp-woocommerce-products-list' ) }</p> : null }
			{ rows ? (
				<>
					<CheckboxControl __nextHasNoMarginBottom label={ __( 'Only products missing a translation', 'wp-woocommerce-products-list' ) } checked={ onlyMissing } onChange={ setOnlyMissing } />
					<div className="wc-pl-translate__scroll">
						<table className="wc-pl-translate__table" onKeyDown={ onGridKeyDown }>
							<thead>
								<tr>
									<th scope="col">{ __( 'Product', 'wp-woocommerce-products-list' ) }</th>
									{ GRID_FIELDS.map( ( name ) => (
										<th scope="col" key={ name }>
											{ gridFields[ name ]?.label ?? name }
										</th>
									) ) }
								</tr>
							</thead>
							<tbody>
								{ listed.slice( 0, shown ).map( ( row ) => (
									<GridRow key={ `${ row.id }:${ lang }` } item={ row } tabId={ tabId } lang={ lang } gridFields={ gridFields } store={ store } disabled={ disabled } defaultLabel={ defaultLabel } />
								) ) }
							</tbody>
						</table>
					</div>
					{ listed.length === 0 ? <p>{ __( 'Every listed product has its translation.', 'wp-woocommerce-products-list' ) }</p> : null }
					{ listed.length > shown ? (
						<Button variant="secondary" onClick={ () => setShown( ( current ) => current + GRID_PAGE ) }>
							{ sprintf(
								/* translators: %d: number of products not shown yet */
								__( 'Show more (%d left)', 'wp-woocommerce-products-list' ),
								listed.length - shown
							) }
						</Button>
					) : null }
				</>
			) : null }
		</details>
	);
}
