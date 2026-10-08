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
import { Button, CheckboxControl, SelectControl, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { useMemo, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import type { DeclarativeAction, DeclarativeActionArg, ProductListItem, Settings } from '../types';
import { isVariation } from './field-value';

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

/** The options of an argument for this run: price fields only between languages of one currency. */
export function argOptions( arg: DeclarativeActionArg, args: Record< string, unknown >, lang: string, settings: Pick< Settings, 'languages' | 'currency' > ): DeclarativeActionArg[ 'options' ] {
	if ( arg.type !== 'array' ) {
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
		}
	}

	return data;
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
	disabled?: boolean;
	run( def: DeclarativeAction, ids: number[], args: Record< string, unknown > ): Promise< unknown >;
	/** After a run: the tab's values are reloaded. */
	onDone(): void;
}

function Tool( { def, lang, tabLabel, items, settings, disabled, run, onDone }: Omit< LanguageToolsProps, 'tabId' > & { def: DeclarativeAction; lang: string } ) {
	const [ data, setData ] = useState< Record< string, unknown > >( () => defaultsOf( def, lang ) );
	const [ running, setRunning ] = useState( false );
	const [ confirming, setConfirming ] = useState( false );
	const [ error, setError ] = useState< string | null >( null );
	const ids = useMemo( () => toolIds( def, items ), [ def, items ] );
	const args = def.args.filter( ( arg ) => arg.id !== LANG_ARG );
	const missing = args.some( ( arg ) => arg.required && ( data[ arg.id ] === undefined || data[ arg.id ] === '' || ( Array.isArray( data[ arg.id ] ) && ( data[ arg.id ] as unknown[] ).length === 0 ) ) );
	const set = ( id: string, value: unknown ) => setData( ( previous ) => ( { ...previous, [ id ]: value } ) );

	const go = () => {
		setRunning( true );
		setError( null );

		// The fields argument only carries what this run may copy (prices dropped across currencies).
		const sent: Record< string, unknown > = { ...data, [ LANG_ARG ]: lang };

		for ( const arg of args ) {
			if ( arg.type === 'array' && Array.isArray( sent[ arg.id ] ) ) {
				const allowed = new Set( argOptions( arg, data, lang, settings ).map( ( option ) => option.value ) );

				sent[ arg.id ] = ( sent[ arg.id ] as string[] ).filter( ( value ) => allowed.has( value ) );
			}
		}

		run( def, ids, sent )
			.then( () => onDone() )
			.catch( ( reason: unknown ) => setError( reason instanceof Error ? reason.message : __( 'The action failed.', 'wp-woocommerce-products-list' ) ) )
			.finally( () => setRunning( false ) );
	};

	return (
		<div className="wc-pl-language-tools__tool">
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
						const options = argOptions( arg, data, lang, settings );
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

					return null;
				} ) }
			</div>
			{ error ? (
				<p className="wc-pl-language-tools__error" role="alert">
					{ error }
				</p>
			) : null }
			<Button
				variant="secondary"
				isDestructive={ def.destructive }
				isBusy={ running }
				aria-disabled={ disabled || running || missing || ids.length === 0 }
				onClick={ () => {
					if ( disabled || running || missing || ids.length === 0 ) {
						return;
					}

					if ( def.confirm || def.destructive ) {
						setConfirming( true );
					} else {
						go();
					}
				} }
				__next40pxDefaultSize
			>
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

/** The tools of one language tab, folded until opened. */
export function LanguageTools( props: LanguageToolsProps ) {
	const { tabId, settings } = props;
	const tools = languageToolsFor( settings.actions ?? [], tabId );
	const lang = tabId.slice( tabId.indexOf( ':' ) + 1 );

	if ( tools.length === 0 ) {
		return null;
	}

	return (
		<details className="wc-pl-language-tools">
			<summary>
				{ sprintf(
					/* translators: %s: language name */
					__( 'Copy or clear %s for the selected items', 'wp-woocommerce-products-list' ),
					props.tabLabel
				) }
			</summary>
			{ tools.map( ( def ) => (
				<Tool key={ def.id } { ...props } def={ def } lang={ lang } />
			) ) }
		</details>
	);
}
