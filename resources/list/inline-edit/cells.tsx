/**
 * "Edit in table": the table's cells as inputs, for the fields quick edit
 * would show for that row (a variable product's price and a variation's
 * name stay as they are). Typing changes a draft (drafts.ts); a row's
 * drafts save together when Enter is pressed or the keyboard leaves the
 * row, a select or a checkbox saves on change. Escape takes a cell back
 * to its saved value. Saving is quick edit's (save-row.ts): the row is
 * locked while it saves, a clash with someone else's change is refused,
 * and the snackbar offers Undo.
 */
import { speak } from '@wordpress/a11y';
import { createElement, useContext, useEffect, useRef, useState } from '@wordpress/element';
import { decodeEntities } from '@wordpress/html-entities';
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType, FocusEvent, KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import { notify } from '../../actions/notices';
import type { FieldCurrency } from '../../extensions/declarative';
import { numericKindOf, validateBulkNumericEdits } from '../../edit/bulk-numeric';
import { isVariation, parentIdOf, readFieldValue } from '../../edit/field-value';
import { VARIATION_STATUS_ELEMENTS, isPlainTextField } from '../../edit/form-fields';
import { itemLabel } from '../../edit/item-label';
import { hasOptionList } from '../../edit/merge';
import { SCHEDULE_SALE_FIELD_ID } from '../../edit/payload';
import { isStockGatedEdit, managesStock } from '../../edit/row-rules';
import { leafOf, visibleEditFields } from '../../edit/visibility';
import { parsePrice } from '../../fields/currency';
import { toInput } from '../../fields/components/price-edit';
import { NameCell as HierarchyNameCell } from '../../hierarchy/chevron';
import { memoRender } from '../../fields/helpers';
import { findCachedRow, invalidateProducts } from '../../store/products';
import type { Option, ProductField, ProductListItem, Settings } from '../../types';
import { clearDrafts, flagDrafts, getDraft, isRowSaving, rowDrafts, setDraft, setRowSaving, useRowDrafts, whenRowSaved } from './drafts';
import type { CellDraft } from './drafts';
import { InlineEditContext } from './mode';
import type { InlineEditValue } from './mode';
import { saveRow } from './save-row';

export type InlineKind = 'text' | 'money' | 'integer' | 'select' | 'boolean';

const INTEGER = /^-?\d+$/;

/** How a field is edited in its cell, or null when it is not (HTML, terms, dates, images, custom controls). */
export function inlineKindOf( field: ProductField ): InlineKind | null {
	if ( field.edit === false || field.edit === undefined || field.readOnly || field.html || field.filterOnly ) {
		return null;
	}

	if ( field.type === 'array' || field.type === 'media' || field.type === 'date' || field.type === 'datetime' || leafOf( field.id ) === SCHEDULE_SALE_FIELD_ID ) {
		return null;
	}

	const numeric = numericKindOf( field );

	if ( numeric ) {
		return numeric;
	}

	if ( ( field as { currency?: FieldCurrency } ).currency ) {
		return 'money';
	}

	if ( field.type === 'boolean' ) {
		return 'boolean';
	}

	if ( hasOptionList( field ) ) {
		return 'select';
	}

	if ( field.type === 'integer' ) {
		return 'integer';
	}

	return isPlainTextField( field ) ? 'text' : null;
}

const editableCache = new WeakMap< ProductListItem, WeakMap< InlineEditValue, ReadonlySet< string > > >();

/** The field ids this row takes in its cells: what quick edit shows for it, stock fields only when it manages stock. */
export function rowEditableIds( item: ProductListItem, context: InlineEditValue ): ReadonlySet< string > {
	const byContext = editableCache.get( item ) ?? new WeakMap< InlineEditValue, ReadonlySet< string > >();
	const known = byContext.get( context );

	if ( known ) {
		return known;
	}

	const ids = new Set< string >();
	const allowed = context.settings.caps.edit && ! item._placeholder && item.wc_products_list?.can_edit !== false && item.status !== 'trash';

	if ( allowed ) {
		for ( const field of visibleEditFields( context.fields, [ item ], { mode: 'quick', applyToVariations: false } ) ) {
			if ( isStockGatedEdit( leafOf( field.id ) ) && field.id === leafOf( field.id ) && ! managesStock( item ) ) {
				continue;
			}

			if ( inlineKindOf( field ) ) {
				ids.add( field.id );
			}
		}
	}

	byContext.set( context, ids );
	editableCache.set( item, byContext );

	return ids;
}

/** A field's settings with its own currency (a market price in SEK), else the shop's. */
function moneySettings( field: ProductField, settings: Settings ): Settings {
	const currency = ( field as { currency?: FieldCurrency } ).currency;

	return currency ? { ...settings, currency: { ...settings.currency, symbol: currency.symbol, decimals: currency.decimals } } : settings;
}

/** What the cell shows for the row's saved value. */
export function displayText( field: ProductField, item: ProductListItem, kind: InlineKind, settings: Settings ): string {
	const value = readFieldValue( field, item );

	if ( value === null || value === undefined ) {
		return '';
	}

	if ( kind === 'money' ) {
		return toInput( value, moneySettings( field, settings ) );
	}

	return typeof value === 'string' ? decodeEntities( value ) : String( value );
}

/** The typed text as the value to save; `error` when it is not one. */
export function parseText( field: ProductField, kind: InlineKind, text: string, settings: Settings, item: ProductListItem ): { value: unknown; error?: string } {
	const trimmed = text.trim();

	if ( kind === 'money' ) {
		if ( trimmed === '' ) {
			return { value: '' };
		}

		const parsed = parsePrice( trimmed, moneySettings( field, settings ) );

		return parsed === null ? { value: text, error: __( 'Enter a valid price.', 'wp-woocommerce-products-list' ) } : { value: parsed };
	}

	if ( kind === 'integer' ) {
		if ( trimmed === '' ) {
			return { value: '' };
		}

		return INTEGER.test( trimmed ) ? { value: Number( trimmed ) } : { value: text, error: __( 'Enter a whole number.', 'wp-woocommerce-products-list' ) };
	}

	if ( leafOf( field.id ) === 'name' && field.id === 'name' && trimmed === '' ) {
		return { value: text, error: __( 'The name cannot be empty.', 'wp-woocommerce-products-list' ) };
	}

	// A name typed back to the shown text is the stored one ("&amp;" shown as "&").
	const stored = readFieldValue( field, item );

	return { value: typeof stored === 'string' && decodeEntities( stored ) === text ? stored : text };
}

/** How far a typed price may move from the stored one before it is asked about (a digit too many, a missing comma). */
const PRICE_JUMP = 10;

/**
 * A typed price ten times the stored one or more, or a tenth or less: most often a slip ("1050" for "10,50", or
 * typed after the old value). Asked about once; the same text again saves.
 */
export function priceJumps( item: ProductListItem, drafts: ReadonlyMap< string, CellDraft >, context: InlineEditValue ): Array< { field: string; message: string; confirm: true } > {
	const out: Array< { field: string; message: string; confirm: true } > = [];

	for ( const [ id, draft ] of drafts ) {
		const field = context.byId.get( id );

		if ( ! field || draft.error || draft.confirmed === draft.text || inlineKindOf( field ) !== 'money' ) {
			continue;
		}

		const before = Number( readFieldValue( field, item ) );
		const after = Number( draft.value );

		if ( ! ( before > 0 ) || ! ( after > 0 ) || ( after < before * PRICE_JUMP && after > before / PRICE_JUMP ) ) {
			continue;
		}

		const shown = `${ displayText( field, item, 'money', context.settings ) } ${ moneySettings( field, context.settings ).currency.symbol }`;

		out.push( {
			field: id,
			confirm: true,
			message: sprintf(
				/* translators: 1: the price now, e.g. "105,00 €" */
				after > before
					? __( 'This is ten times the price now (%1$s) or more. Press Enter again to save it.', 'wp-woocommerce-products-list' )
					: __( 'This is a tenth of the price now (%1$s) or less. Press Enter again to save it.', 'wp-woocommerce-products-list' ),
				shown
			),
		} );
	}

	return out;
}

/** Drafts that would not save: their own parse errors, then what quick edit checks across fields (a sale price above the regular price), then a price jump to confirm. */
export function validateRow( item: ProductListItem, drafts: ReadonlyMap< string, CellDraft >, context: InlineEditValue ): Array< { field: string; message: string; confirm?: boolean } > {
	const own = Array.from( drafts ).filter( ( [ , draft ] ) => draft.error ).map( ( [ field, draft ] ) => ( { field, message: draft.error as string } ) );

	if ( own.length ) {
		return own;
	}

	const edits = Object.fromEntries( Array.from( drafts ).map( ( [ id, draft ] ) => [ id, draft.value ] ) );

	const rules = validateBulkNumericEdits( [ item ], edits, context.fields, context.settings ).map( ( entry ) => ( { field: entry.field, message: entry.message } ) );

	return rules.length ? rules : priceJumps( item, drafts, context );
}

function labelOf( field: ProductField ): string {
	return ( field.edit && field.edit.label ) || field.label || field.id;
}

/** Whether a draft is still the one sent (its text and value; being flagged is no change). */
function stillSent( now: CellDraft | undefined, sent: CellDraft | undefined ): boolean {
	return !! now && !! sent && now.text === sent.text && now.value === sent.value;
}

/**
 * Saves the row's drafts. What the last attempt said about them is cleared
 * first and checked again (a sale price that was too high is fine once the
 * regular price is raised; a failed request is tried again). A row already
 * saving is left to that save, which saves again when it is back if more was
 * typed meanwhile; a row whose drafts do not validate is not saved, its cells
 * say why.
 */
export async function commitRow( item: ProductListItem, context: InlineEditValue ): Promise< void > {
	if ( ! rowDrafts( item.id ).size || isRowSaving( item.id ) ) {
		return;
	}

	// A variation waits for a save of its parent's row (a new name WooCommerce copies into the variations' titles):
	// its own save then starts from what the parent saved.
	const parentId = isVariation( item ) ? parentIdOf( item ) : 0;

	if ( parentId && isRowSaving( parentId ) ) {
		await whenRowSaved( parentId );

		return commitRow( findCachedRow( item.id ) ?? item, context );
	}

	flagDrafts( item.id, undefined );

	const drafts = rowDrafts( item.id );
	const problems = validateRow( item, drafts, context );
	const name = itemLabel( item );

	if ( problems.length ) {
		for ( const problem of problems ) {
			flagDrafts( item.id, problem.message, [ problem.field ], problem.confirm === true );
		}

		const text = sprintf( /* translators: 1: product name, 2: what is wrong */ __( '%1$s was not saved: %2$s', 'wp-woocommerce-products-list' ), name, problems.map( ( problem ) => problem.message ).join( ' ' ) );

		notify.error( text, { id: 'wc-pl-inline-saved' } );
		speak( text, 'assertive' );

		return;
	}

	const sent = new Map( drafts );
	const edits = Object.fromEntries( Array.from( sent ).map( ( [ id, draft ] ) => [ id, draft.value ] ) );
	let saved = false;

	setRowSaving( item.id, true );

	try {
		const outcome = await saveRow( item, edits, context.fields );
		// Drafts typed while it saved stay (and save next); the ones sent are done or flagged.
		const settled = Array.from( sent.keys() ).filter( ( id ) => stillSent( getDraft( item.id, id ), sent.get( id ) ) );

		saved = outcome.ok;

		if ( outcome.ok ) {
			clearDrafts( item.id, settled );
		} else if ( outcome.code === 'wc_products_list_conflict' ) {
			// Someone else saved the row meanwhile: what they saved is shown, the typed values are dropped (the snackbar said so).
			clearDrafts( item.id, settled );
			invalidateProducts();
		} else {
			flagDrafts( item.id, outcome.message ?? __( 'Not saved.', 'wp-woocommerce-products-list' ), settled );
		}
	} finally {
		setRowSaving( item.id, false );
	}

	// Typed (or picked in a menu) while the row saved: saved now, on the row as that save left it.
	const left = rowDrafts( item.id );

	if ( saved && left.size && Array.from( left.values() ).every( ( draft ) => ! draft.error && ! draft.problem ) ) {
		await commitRow( findCachedRow( item.id ) ?? item, context );
	}
}

function stop( event: SyntheticEvent ): void {
	event.stopPropagation();
}

/** The next (or previous) cell of the same column, in table order. */
function siblingCell( from: HTMLElement, fieldId: string, step: 1 | -1 ): HTMLElement | null {
	const table = from.closest( 'table' ) ?? document;
	const cells = Array.from( table.querySelectorAll< HTMLElement >( `[data-wcpl-inline-field="${ CSS.escape( fieldId ) }"]` ) ).filter( ( cell ) => ! ( cell as HTMLInputElement ).disabled );
	const index = cells.indexOf( from );

	return index === -1 ? null : cells[ index + step ] ?? null;
}

function sameRow( target: EventTarget | null, rowId: number ): boolean {
	return target instanceof Element && target.closest( '[data-wcpl-inline-row]' )?.getAttribute( 'data-wcpl-inline-row' ) === String( rowId );
}

interface ControlProps {
	item: ProductListItem;
	field: ProductField;
	kind: InlineKind;
	context: InlineEditValue;
	/** The accessible name: the field and the row ("Sale price, Aylla Chiri – 38"). */
	label: string;
	/** Shown in an empty input (the sale price's "Sale"). */
	placeholder?: string;
	className?: string;
}

function InlineTextControl( { item, field, kind, context, label, placeholder, className }: ControlProps ) {
	useRowDrafts( item.id );

	const draft = getDraft( item.id, field.id );
	const saved = displayText( field, item, kind, context.settings );
	const text = draft?.text ?? saved;
	const errorId = `wcpl-inline-error-${ item.id }-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }`;
	const message = draft?.error ?? draft?.problem;
	const symbol = kind === 'money' ? moneySettings( field, context.settings ).currency.symbol : null;
	const [ focused, setFocused ] = useState( false );
	// A click places the caret (the cell looks like an input, not a spreadsheet cell); a number, or a cell reached
	// by keyboard, is selected whole, ready to be typed over.
	const pointerRef = useRef( false );
	// Safari drops a selection made on focus at the mouseup of the click that focused: it is made there again.
	const selectOnMouseUpRef = useRef( false );

	const change = ( next: string ) => {
		if ( next === saved ) {
			setDraft( item.id, field.id, undefined );

			return;
		}

		const parsed = parseText( field, kind, next, context.settings, item );

		setDraft( item.id, field.id, { text: next, value: parsed.value, error: parsed.error } );
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLInputElement > ) => {
		// The table's own keys (arrows between rows, the screen's shortcuts) are not for a text being typed.
		event.stopPropagation();

		if ( event.key === 'Escape' && draft ) {
			event.preventDefault();
			setDraft( item.id, field.id, undefined );
			speak( __( 'Change undone.', 'wp-woocommerce-products-list' ) );

			return;
		}

		if ( event.key === 'Enter' && ! event.nativeEvent.isComposing ) {
			event.preventDefault();
			const target = event.currentTarget;

			// A change that would not save keeps the focus here, where its message is.
			if ( rowDrafts( item.id ).size && validateRow( item, rowDrafts( item.id ), context ).length ) {
				void commitRow( item, context );

				return;
			}

			const next = siblingCell( target, field.id, event.shiftKey ? -1 : 1 );

			// Down the column, as in a spreadsheet; the row saves (its inputs are locked while it does). The last row
			// keeps the focus.
			if ( next ) {
				next.focus();

				if ( next instanceof HTMLInputElement && next.type === 'text' ) {
					next.select();
				}
			} else {
				target.select();
			}

			void commitRow( item, context );
		}
	};

	const onBlur = ( event: FocusEvent< HTMLInputElement > ) => {
		setFocused( false );
		selectOnMouseUpRef.current = false;
		// A long text scrolled to its end while typed reads from its start again.
		event.currentTarget.scrollLeft = 0;

		if ( ! sameRow( event.relatedTarget, item.id ) ) {
			void commitRow( item, context );
		}
	};

	return (
		<span
			className={ [ 'wc-pl-inline', `wc-pl-inline--${ kind }`, leafOf( field.id ) === 'sku' ? 'wc-pl-inline--sku' : '', text === '' ? 'is-empty' : '', draft ? 'is-dirty' : '', message ? 'is-invalid' : '', className ?? '' ].filter( Boolean ).join( ' ' ) }
			data-wcpl-inline-row={ item.id }
		>
			<input
				type="text"
				className="wc-pl-inline__input"
				inputMode={ kind === 'money' ? 'decimal' : kind === 'integer' ? 'numeric' : undefined }
				value={ text }
				placeholder={ placeholder }
				aria-label={ label }
				aria-invalid={ message ? true : undefined }
				aria-describedby={ message ? errorId : undefined }
				readOnly={ isRowSaving( item.id ) }
				data-wcpl-inline-field={ field.id }
				onChange={ ( event ) => change( event.target.value ) }
				onKeyDown={ onKeyDown }
				onBlur={ onBlur }
				onFocus={ ( event ) => {
					setFocused( true );

					if ( kind !== 'text' || ! pointerRef.current ) {
						event.currentTarget.select();
						selectOnMouseUpRef.current = pointerRef.current;
					}

					pointerRef.current = false;
				} }
				onClick={ stop }
				onMouseDown={ ( event ) => {
					stop( event );
					pointerRef.current = document.activeElement !== event.currentTarget;
					// A mouseup that never came (the pointer dragged out) is not waited for again.
					selectOnMouseUpRef.current = false;
				} }
				onMouseUp={ ( event ) => {
					if ( selectOnMouseUpRef.current ) {
						selectOnMouseUpRef.current = false;
						event.preventDefault();
						event.currentTarget.select();
					}
				} }
			/>
			{ symbol && <span className="wc-pl-inline__suffix" aria-hidden="true">{ symbol }</span> }
			{ message && (
				<span id={ errorId } className={ focused ? 'wc-pl-inline__message' : 'screen-reader-text' }>
					{ message }
				</span>
			) }
		</span>
	);
}

const elementsCache = new Map< string, Promise< Option[] > >();

function useElements( field: ProductField, item: ProductListItem ): Option[] {
	const variationStatus = isVariation( item ) && leafOf( field.id ) === 'status';
	const fixed = variationStatus ? VARIATION_STATUS_ELEMENTS : field.elements;
	const [ loaded, setLoaded ] = useState< Option[] | null >( null );

	useEffect( () => {
		if ( fixed || ! field.getElements ) {
			return;
		}

		let live = true;
		const promise = elementsCache.get( field.id ) ?? Promise.resolve( field.getElements() ).then( ( list ) => ( list ?? [] ) as Option[] );

		elementsCache.set( field.id, promise );
		promise.then( ( list ) => live && setLoaded( list ) ).catch( () => {} );

		return () => {
			live = false;
		};
	}, [ fixed, field ] );

	return ( fixed as Option[] | undefined ) ?? loaded ?? [];
}

function InlineSelectControl( { item, field, context, label, className }: ControlProps ) {
	useRowDrafts( item.id );

	const options = useElements( field, item );
	const draft = getDraft( item.id, field.id );
	const stored = readFieldValue( field, item );
	const saved = stored === null || stored === undefined ? '' : String( stored );
	const value = draft ? String( draft.value ) : saved;
	const known = options.some( ( option ) => String( option.value ) === value );

	return (
		<span className={ [ 'wc-pl-inline', 'wc-pl-inline--select', draft ? 'is-dirty' : '', draft?.error || draft?.problem ? 'is-invalid' : '', className ?? '' ].filter( Boolean ).join( ' ' ) } data-wcpl-inline-row={ item.id }>
			<select
				className="wc-pl-inline__select"
				value={ value }
				aria-label={ label }
				aria-invalid={ draft?.problem ? true : undefined }
				title={ draft?.problem }
				data-wcpl-inline-field={ field.id }
				onChange={ ( event ) => {
					const next = event.target.value;
					const option = options.find( ( entry ) => String( entry.value ) === next );

					setDraft( item.id, field.id, next === saved ? undefined : { text: option?.label ?? next, value: option ? option.value : next } );
					// A pick is a decision: it saves now, with whatever else the row has typed.
					void commitRow( item, context );
				} }
				onKeyDown={ stop }
				onClick={ stop }
				onMouseDown={ stop }
			>
				{ ! known && <option value={ value }>{ value === '' ? '—' : value }</option> }
				{ options.map( ( option ) => (
					<option key={ String( option.value ) } value={ String( option.value ) }>
						{ option.label }
					</option>
				) ) }
			</select>
		</span>
	);
}

function InlineCheckboxControl( { item, field, context, label, className }: ControlProps ) {
	useRowDrafts( item.id );

	const draft = getDraft( item.id, field.id );
	const saved = readFieldValue( field, item ) === true;
	const checked = draft ? draft.value === true : saved;

	return (
		<span className={ [ 'wc-pl-inline', 'wc-pl-inline--boolean', draft ? 'is-dirty' : '', draft?.problem ? 'is-invalid' : '', className ?? '' ].filter( Boolean ).join( ' ' ) } data-wcpl-inline-row={ item.id }>
			<input
				type="checkbox"
				className="wc-pl-inline__checkbox"
				checked={ checked }
				aria-label={ label }
				aria-invalid={ draft?.problem ? true : undefined }
				title={ draft?.problem }
				data-wcpl-inline-field={ field.id }
				onChange={ ( event ) => {
					const next = event.target.checked;

					setDraft( item.id, field.id, next === saved ? undefined : { text: next ? '1' : '0', value: next } );
					void commitRow( item, context );
				} }
				onKeyDown={ stop }
				onClick={ stop }
				onMouseDown={ stop }
			/>
		</span>
	);
}

function cellLabel( field: ProductField, item: ProductListItem ): string {
	/* translators: 1: field name ("Sale price"), 2: product or variation name */
	return sprintf( __( '%1$s, %2$s', 'wp-woocommerce-products-list' ), labelOf( field ), itemLabel( item ) );
}

export function InlineControl( props: Omit< ControlProps, 'label' > & { label?: string } ) {
	const label = props.label ?? cellLabel( props.field, props.item );

	switch ( props.kind ) {
		case 'select':
			return <InlineSelectControl { ...props } label={ label } />;
		case 'boolean':
			return <InlineCheckboxControl { ...props } label={ label } />;
		default:
			return <InlineTextControl { ...props } label={ label } />;
	}
}

type Render = ( props: { item: ProductListItem; field: unknown } ) => ReactNode;

type Cell = ComponentType< { item: ProductListItem; field: unknown } >;

/**
 * The column's own cell, a component (`memoRender` makes it a `memo` one): rendered as an element, never called.
 * A field without a `render` gets what DataViews shows for one: its value as text.
 */
function original( field: ProductField ): Cell {
	if ( field.render ) {
		return field.render as Cell;
	}

	return function ValueCell( { item }: { item: ProductListItem } ) {
		const value = field.getValue ? field.getValue( { item } ) : ( item as Record< string, unknown > )[ field.id ];

		return value === null || value === undefined ? null : <>{ typeof value === 'object' ? '' : String( value ) }</>;
	};
}

/** A column's cell: its input when the row takes the field, else the column's own render. */
function fieldCell( field: ProductField, kind: InlineKind ): Render {
	const render = original( field );

	return function InlineFieldCell( props ) {
		const context = useContext( InlineEditContext );

		if ( ! context?.enabled || ! rowEditableIds( props.item, context ).has( field.id ) ) {
			return createElement( render, props );
		}

		return <InlineControl item={ props.item } field={ field } kind={ kind } context={ context } />;
	};
}

/** The name column: the hierarchy's indent and chevron kept, the name an input where the row's name can change. */
function nameCell( field: ProductField ): Render {
	const render = original( field );

	return function InlineNameCell( props ) {
		const context = useContext( InlineEditContext );

		if ( ! context?.enabled || ! rowEditableIds( props.item, context ).has( field.id ) ) {
			return createElement( render, props );
		}

		return (
			<HierarchyNameCell item={ props.item }>
				<InlineControl item={ props.item } field={ field } kind="text" context={ context } className="wc-pl-inline--name" />
			</HierarchyNameCell>
		);
	};
}

/** The Price column (WooCommerce's computed price): the regular and the sale price, one above the other, where the row sells. */
function priceCell( field: ProductField ): Render {
	const render = original( field );

	return function InlinePriceCell( props ) {
		const context = useContext( InlineEditContext );
		const regular = context?.byId.get( 'regular_price' );
		const sale = context?.byId.get( 'sale_price' );
		const ids = context ? rowEditableIds( props.item, context ) : null;

		if ( ! context?.enabled || ! regular || ! sale || ! ids?.has( 'regular_price' ) ) {
			return createElement( render, props );
		}

		return (
			<span className="wc-pl-inline-price">
				<InlineControl item={ props.item } field={ regular } kind="money" context={ context } />
				{ ids.has( 'sale_price' ) && <InlineControl item={ props.item } field={ sale } kind="money" context={ context } placeholder={ __( 'Sale', 'wp-woocommerce-products-list' ) } className="wc-pl-inline--sale" /> }
			</span>
		);
	};
}

/** The Stock column: the quantity of a row that manages stock (its status follows it), else the status. */
function stockCell( field: ProductField ): Render {
	const render = original( field );

	return function InlineStockCell( props ) {
		const context = useContext( InlineEditContext );
		const ids = context?.enabled ? rowEditableIds( props.item, context ) : null;
		const quantity = context?.byId.get( 'stock_quantity' );

		if ( context && quantity && ids?.has( 'stock_quantity' ) ) {
			return <InlineControl item={ props.item } field={ quantity } kind="integer" context={ context } className="wc-pl-inline--stock" />;
		}

		if ( context && ids?.has( field.id ) ) {
			return <InlineControl item={ props.item } field={ field } kind="select" context={ context } />;
		}

		return createElement( render, props );
	};
}

const wrapped = new WeakMap< ProductField, ProductField >();

/**
 * The fields with cells that turn into inputs while Edit in table is on
 * (`InlineEditContext.enabled`), else render the column's own cell. A field's
 * id, filters and sorting stay; only `render` changes. The wrapped field is
 * kept per field, so switching the mode re-renders the cells, never remounts
 * them (a hundred-row page has thousands).
 */
export function withInlineEditing( fields: ProductField[] ): ProductField[] {
	return fields.map( ( field ) => {
		const known = wrapped.get( field );

		if ( known ) {
			return known;
		}

		let render: Render | null = null;

		if ( field.id === 'name' ) {
			render = nameCell( field );
		} else if ( field.id === 'price' ) {
			render = priceCell( field );
		} else if ( field.id === 'stock_status' ) {
			render = stockCell( field );
		} else {
			const kind = inlineKindOf( field );

			render = kind ? fieldCell( field, kind ) : null;
		}

		const next = render ? { ...field, render: memoRender( render as ProductField[ 'render' ] ) } : field;

		wrapped.set( field, next );

		return next;
	} );
}
