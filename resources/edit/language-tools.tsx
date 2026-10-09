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
 */
import { Button, CheckboxControl, SelectControl, TextControl, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { KeyboardEvent } from 'react';
import type { DeclarativeAction, DeclarativeActionArg, ProductField, ProductListItem, Settings } from '../types';
import { isVariation, readFieldValue, readReference } from './field-value';
import { itemLabel } from './item-label';

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
export function argOptions( arg: DeclarativeActionArg, args: Record< string, unknown >, lang: string, settings: Pick< Settings, 'languages' | 'currency' >, copies = true ): DeclarativeActionArg[ 'options' ] {
	if ( arg.type !== 'array' || ! copies ) {
		return arg.options;
	}

	const currencies = settings.languages?.currencies ?? {};
	const source = typeof args.source === 'string' && args.source ? args.source : settings.languages?.default ?? '';
	const from = currencies[ source ] ?? settings.currency.code;
	const to = currencies[ lang ] ?? settings.currency.code;

	return from === to ? arg.options : arg.options.filter( ( option ) => ! PRICE_OPTION.test( option.value ) );
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
export function previewTransform( def: DeclarativeAction, data: Record< string, unknown >, tabId: string, items: ProductListItem[], fields: ProductField[] ): { lines: PreviewLine[]; changes: number } | null {
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

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		for ( const name of chosen ) {
			const field = byId.get( `${ tabId }.${ name }` );

			if ( ! field ) {
				continue;
			}

			const old = typeof readFieldValue( field, item ) === 'string' ? ( readFieldValue( field, item ) as string ) : '';
			const reference = readReference( field, item );
			const base = old !== '' || ! shown ? old : typeof reference === 'string' ? reference : '';
			let next = base;

			if ( operation === 'replace' ) {
				next = base === '' ? '' : base.replace( new RegExp( escapeRegExp( find ), ignoreCase ? 'gi' : 'g' ), () => replace );
			} else if ( operation === 'prefix' ) {
				next = base === '' || base.startsWith( text ) ? base : text + base;
			} else if ( operation === 'suffix' ) {
				next = base === '' || base.endsWith( text ) ? base : base + text;
			} else {
				const shownName = old || ( typeof reference === 'string' ? reference : '' );

				next = text
					.replace( /\{name\}/g, shownName )
					.replace( /\{default_name\}/g, String( ( item as { name?: unknown } ).name ?? '' ) )
					.replace( /\{sku\}/g, String( ( item as { sku?: unknown } ).sku ?? '' ) );
			}

			if ( next.trim() === '' || next === old || ( operation !== 'template' && next === base && old === '' ) ) {
				continue;
			}

			changes += 1;

			if ( lines.length < PREVIEW_SHOWN ) {
				lines.push( { id: item.id, label: itemLabel( item ), field: field.label ?? name, before: plainText( old ) || __( '(not translated)', 'wp-woocommerce-products-list' ), after: plainText( next ) } );
			}
		}
	}

	return { lines, changes };
}

/** The ids an action runs on: variations only when its scope takes them. */
export function toolIds( def: DeclarativeAction, items: ProductListItem[] ): number[] {
	return items
		.filter( ( item ) => ! item._placeholder )
		.filter( ( item ) => ( def.scope === 'product' ? ! isVariation( item ) : def.scope === 'variation' ? isVariation( item ) : true ) )
		.map( ( item ) => item.id );
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
}

function sameData( a: Record< string, unknown >, b: Record< string, unknown > ): boolean {
	return JSON.stringify( a ) === JSON.stringify( b );
}

type ToolProps = Omit< LanguageToolsProps, 'tabId' | 'onDirtyChange' | 'defaultOpen' > & { def: DeclarativeAction; lang: string; tabId: string; onDirty( id: string, dirty: boolean ): void };

function Tool( { def, lang, tabId, tabLabel, items, settings, fields, disabled, run, onDone, onDirty }: ToolProps ) {
	const defaults = useMemo( () => defaultsOf( def, lang ), [ def, lang ] );
	const [ data, setData ] = useState< Record< string, unknown > >( defaults );
	// What the last run was made with: settings equal to these are not "unsaved".
	const [ ranWith, setRanWith ] = useState< Record< string, unknown > >( defaults );
	const [ running, setRunning ] = useState( false );
	const [ confirming, setConfirming ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );
	const ids = useMemo( () => toolIds( def, items ), [ def, items ] );
	const copies = copiesBetweenLanguages( def );
	const args = def.args.filter( ( arg ) => arg.id !== LANG_ARG && argShown( arg, def, data ) );
	const missing = missingArg( def, data );
	const preview = useMemo( () => ( fields ? previewTransform( def, data, tabId, items, fields ) : null ), [ def, data, tabId, items, fields ] );
	const set = ( id: string, value: unknown ) => {
		setError( null );
		setData( ( previous ) => ( { ...previous, [ id ]: value } ) );
	};
	const dirty = ! sameData( data, ranWith );
	const onDirtyRef = useRef( onDirty );

	useEffect( () => {
		onDirtyRef.current = onDirty;
	} );

	useEffect( () => {
		onDirtyRef.current( def.id, dirty );
	}, [ def.id, dirty ] );

	// A tool that leaves (another tab) holds nothing unsaved any more.
	useEffect( () => () => onDirtyRef.current( def.id, false ), [ def.id ] );

	const go = () => {
		setRunning( true );
		setError( null );

		// Only the arguments shown are sent; the fields argument only carries what this run may copy (prices dropped across currencies).
		const sent: Record< string, unknown > = { [ LANG_ARG ]: lang };

		for ( const arg of args ) {
			sent[ arg.id ] = data[ arg.id ];

			if ( arg.type === 'array' && Array.isArray( sent[ arg.id ] ) ) {
				const allowed = new Set( argOptions( arg, data, lang, settings, copies ).map( ( option ) => option.value ) );

				sent[ arg.id ] = ( sent[ arg.id ] as string[] ).filter( ( value ) => allowed.has( value ) );
			}
		}

		const snapshot = data;

		run( def, ids, sent )
			.then( () => {
				setRanWith( snapshot );
				onDone();
			} )
			.catch( ( reason: unknown ) => setError( reason instanceof Error ? reason.message : __( 'The action failed.', 'wp-woocommerce-products-list' ) ) )
			.finally( () => setRunning( false ) );
	};

	const blocked = disabled || running || ids.length === 0;

	const start = () => {
		if ( blocked ) {
			return;
		}

		if ( missing ) {
			/* translators: %s: the label of an input, e.g. "Amount" */
			setError( sprintf( __( 'Fill in "%s" first.', 'wp-woocommerce-products-list' ), missing.label ) );

			return;
		}

		if ( def.confirm || def.destructive ) {
			setConfirming( true );
		} else {
			go();
		}
	};

	// Enter in one of the tool's inputs runs the tool, not the editor's Update.
	const onKeyDown = ( event: KeyboardEvent< HTMLDivElement > ) => {
		if ( event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox' ) {
			event.preventDefault();
			event.stopPropagation();
			start();
		}
	};

	return (
		<div className="wc-pl-language-tools__tool" onKeyDown={ onKeyDown }>
			<strong className="wc-pl-language-tools__label">{ def.label }</strong>
			{ def.description ? <p className="wc-pl-language-tools__description">{ def.description }</p> : null }
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
						const options = argOptions( arg, data, lang, settings, copies );
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
								{ options.length < arg.options.length ? (
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
			{ preview ? (
				<div className="wc-pl-language-tools__preview" aria-live="polite">
					{ preview.changes === 0 ? (
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
			<Button variant="secondary" isDestructive={ def.destructive } isBusy={ running } aria-disabled={ blocked } onClick={ start } __next40pxDefaultSize>
				{ sprintf(
					/* translators: 1: action label, 2: language, 3: number of items */
					__( '%1$s: %2$s (%3$d)', 'wp-woocommerce-products-list' ),
					def.label,
					tabLabel,
					ids.length
				) }
			</Button>
			{ confirming ? (
				<ConfirmDialog
					isOpen
					confirmButtonText={ def.label }
					onConfirm={ () => {
						setConfirming( false );
						go();
					} }
					onCancel={ () => setConfirming( false ) }
				>
					{ def.confirm ?? def.description }
				</ConfirmDialog>
			) : null }
		</div>
	);
}

/** "Copy, clear, edit text, adjust prices": the tools' own names, so the folded panel says what is inside. */
export function toolsSummary( tools: DeclarativeAction[], tabLabel: string ): string {
	return sprintf(
		/* translators: 1: language name, 2: comma-separated tool names */
		__( '%1$s tools: %2$s', 'wp-woocommerce-products-list' ),
		tabLabel,
		tools.map( ( def ) => def.label ).join( ', ' )
	);
}

/** The tools of one language tab, folded until opened. */
export function LanguageTools( props: LanguageToolsProps ) {
	const { tabId, settings, onDirtyChange } = props;
	const tools = languageToolsFor( settings.actions ?? [], tabId );
	const lang = tabId.slice( tabId.indexOf( ':' ) + 1 );
	const dirtyRef = useRef< Set< string > >( new Set() );
	const onDirtyChangeRef = useRef( onDirtyChange );

	useEffect( () => {
		onDirtyChangeRef.current = onDirtyChange;
	} );

	const onDirty = useMemo(
		() => ( id: string, dirty: boolean ) => {
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
		[]
	);

	if ( tools.length === 0 ) {
		return null;
	}

	const { defaultOpen: _defaultOpen, onDirtyChange: _onDirtyChange, ...toolProps } = props;

	return (
		<details className="wc-pl-language-tools" open={ props.defaultOpen || undefined }>
			<summary>{ toolsSummary( tools, props.tabLabel ) }</summary>
			{ tools.map( ( def ) => (
				<Tool key={ def.id } { ...toolProps } def={ def } lang={ lang } onDirty={ onDirty } />
			) ) }
		</details>
	);
}
