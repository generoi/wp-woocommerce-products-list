/**
 * Copy and clear a language run inline in the editor's language tab, not
 * from a dialog in the action menu; prices are never copied between
 * languages that sell in different currencies.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTabs, toolTabIds } from '../../resources/edit/form-layouts';
import { isBulkUnsupportedField } from '../../resources/edit/visibility';
import { describe, expect, it, vi } from 'vitest';
import { argOptions, argShown, isEditorHostedAction, LanguageTools, languageToolsFor, missingArg, previewTransform, toolIds } from '../../resources/edit/language-tools';
import type { DeclarativeAction } from '../../resources/types';
import { coreFields, editSettings, simple, variation } from './edit-fixtures';

vi.mock( '../../resources/extensions/api', () => ( { getRegisteredActions: () => [], getQuickEditTabs: () => [], useRegistryVersion: () => 0 } ) );

const languages = [
	{ value: 'se', label: 'Svenska' },
	{ value: 'de', label: 'Deutsch' },
];

function copyAction(): DeclarativeAction {
	return {
		id: 'i18n_copy',
		label: 'Copy translations',
		description: '',
		icon: null,
		scope: 'both',
		supportsBulk: true,
		isPrimary: false,
		destructive: false,
		confirm: null,
		capability: null,
		group: 'i18n',
		order: 500,
		source: 'gds-woo-i18n',
		args: [
			{ id: 'lang', label: 'To language', type: 'select', required: true, default: null, options: languages },
			{ id: 'source', label: 'From language', type: 'select', required: false, default: 'fi', options: [ { value: 'fi', label: 'Suomi' }, ...languages ] },
			{
				id: 'fields',
				label: 'Fields',
				type: 'array',
				required: true,
				default: null,
				options: [
					{ value: 'name', label: 'Name' },
					{ value: 'regular_price', label: 'Regular price' },
					{ value: 'sale_price', label: 'Sale price' },
				],
			},
			{ id: 'overwrite', label: 'Overwrite existing translations', type: 'boolean', required: false, default: false, options: [] },
		],
	};
}

const settings = editSettings( {
	actions: [ copyAction() ],
	languages: { default: 'fi', others: [ 'se', 'de' ], labels: { fi: 'Suomi', se: 'Svenska', de: 'Deutsch' }, currencies: { fi: 'EUR', se: 'SEK', de: 'EUR' } },
} );

describe( 'language tabs in bulk', () => {
	it( 'keep a tab for the tools when the bulk edit has no field of that language (SEO texts are not bulk fields)', () => {
		const general = coreFields().filter( ( entry ) => entry.id === 'status' );
		const tabs = buildTabs( general, [ simple( 1 ), simple( 2 ) ], settings );

		expect( tabs.map( ( tab ) => tab.id ) ).toEqual( [ 'general', 'i18n:se', 'i18n:de' ] );
		expect( toolTabIds( settings, [ simple( 1 ) ] ) ).toEqual( new Set( [ 'i18n:se', 'i18n:de' ] ) );
		// A product-only tool adds nothing to a selection of variations.
		expect( toolTabIds( { actions: [ { ...copyAction(), scope: 'product' } ] }, [ variation( 41, 4 ) ] ).size ).toBe( 0 );
		expect( isBulkUnsupportedField( 'i18n:se.meta_title' ) ).toBe( true );
		expect( isBulkUnsupportedField( 'i18n:se.meta_description' ) ).toBe( true );
		expect( isBulkUnsupportedField( 'i18n:se.short_description' ) ).toBe( false );
	} );
} );

describe( 'language tools', () => {
	it( 'are the grouped actions with a language argument, per tab', () => {
		expect( isEditorHostedAction( copyAction() ) ).toBe( true );
		expect( isEditorHostedAction( { ...copyAction(), group: null } ) ).toBe( false );
		expect( languageToolsFor( settings.actions, 'i18n:se' ).map( ( def ) => def.id ) ).toEqual( [ 'i18n_copy' ] );
		expect( languageToolsFor( settings.actions, 'i18n:nb' ) ).toEqual( [] );
		expect( languageToolsFor( settings.actions, 'general' ) ).toEqual( [] );
	} );

	it( 'offer prices only between languages of one currency', () => {
		const fields = copyAction().args[ 2 ]!;

		expect( argOptions( fields, { source: 'fi' }, 'se', settings ).map( ( option ) => option.value ) ).toEqual( [ 'name' ] );
		expect( argOptions( fields, { source: 'fi' }, 'de', settings ).map( ( option ) => option.value ) ).toEqual( [ 'name', 'regular_price', 'sale_price' ] );
	} );

	it( 'offer only the fields the selected items have (no names for variations alone)', () => {
		const fields = {
			...copyAction().args[ 2 ]!,
			options: [
				{ value: 'name', label: 'Name', applies: { product: true, variation: false } },
				{ value: 'description', label: 'Description', applies: { product: true, variation: true } },
				{ value: 'regular_price', label: 'Price', applies: { product: [ 'simple' ], variation: true } },
			],
		};
		const variation = { id: 2, type: 'variation', parent_id: 1 } as never;
		const variable = { id: 1, type: 'variable', parent_id: 0 } as never;

		expect( argOptions( fields, {}, 'de', settings, false, [ variation ] ).map( ( option ) => option.value ) ).toEqual( [ 'description', 'regular_price' ] );
		expect( argOptions( fields, {}, 'de', settings, false, [ variable ] ).map( ( option ) => option.value ) ).toEqual( [ 'name', 'description' ] );
		expect( argOptions( fields, {}, 'de', settings, false ).map( ( option ) => option.value ) ).toEqual( [ 'name', 'description', 'regular_price' ] );
	} );

	it( 'run on the editor\'s rows with the tab\'s language and reload the tab', async () => {
		const run = vi.fn( async () => undefined );
		const onDone = vi.fn();

		render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ [ simple( 1 ), variation( 41, 1 ) ] } settings={ settings } run={ run } onDone={ onDone } /> );

		fireEvent.click( screen.getByText( 'Svenska tools: Copy translations' ) );
		expect( screen.queryByLabelText( 'Regular price' ) ).not.toBeInTheDocument();
		fireEvent.click( screen.getByLabelText( 'Name' ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Copy translations: Svenska, apply now to 2 items…' } ) );

		// It saves outside Update / Cancel: it says so and asks first, inline (no dialog).
		expect( run ).not.toHaveBeenCalled();
		expect( document.querySelector( '.components-modal__frame' ) ).toBeNull();
		expect( screen.getByText( /saves now to 2 items, separately from Update: Cancel will not undo it/ ) ).toBeInTheDocument();
		fireEvent.click( screen.getByRole( 'button', { name: 'Apply now to 2 items' } ) );

		await waitFor( () => expect( onDone ).toHaveBeenCalled() );
		// The preview made from the values before is replaced by what was done.
		expect( await screen.findByText( 'Copy translations applied to 2 items. Undo it from the notice; Cancel does not undo it.' ) ).toBeInTheDocument();
		expect( run ).toHaveBeenCalledWith( expect.objectContaining( { id: 'i18n_copy' } ), [ 1, 41 ], { lang: 'se', source: 'fi', fields: [ 'name' ], overwrite: false } );
		expect( toolIds( { ...copyAction(), scope: 'product' }, [ simple( 1 ), variation( 41, 1 ) ] ) ).toEqual( [ 1 ] );
	} );

	it( 'leave the action menu when an editor can host them', async () => {
		const { buildProductActions } = await import( '../../resources/actions/index' );
		const context = { fields: [], settings, view: { type: 'table' }, tab: 'all', hierarchy: {} } as unknown as Parameters< typeof buildProductActions >[ 0 ];

		expect( buildProductActions( { ...context, openEditor: () => {} } ).some( ( action ) => action.id === 'i18n_copy' ) ).toBe( false );
		expect( buildProductActions( context ).some( ( action ) => action.id === 'i18n_copy' ) ).toBe( true );
	} );

	it( 'draw a text input for every text argument and a decimal input for an amount (every arg type gds-woo-i18n declares)', async () => {
		const tools = editSettings( { actions: [ copyAction(), clearAction(), transformAction(), pricesAction() ], languages: settings.languages } );
		const run = vi.fn( async () => undefined );

		render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ [ simple( 1 ) ] } settings={ tools } run={ run } onDone={ vi.fn() } /> );
		fireEvent.click( screen.getByText( /^Svenska tools: / ) );

		// Find & replace (the default operation): its two inputs, not the prefix one.
		expect( screen.getByLabelText( 'Find (find & replace)' ) ).toHaveAttribute( 'type', 'text' );
		expect( screen.getByLabelText( 'Replace with (find & replace)' ) ).toBeInTheDocument();
		expect( screen.queryByLabelText( /Prefix, suffix or template/ ) ).not.toBeInTheDocument();

		// Another operation swaps in the prefix/suffix/template input.
		fireEvent.change( screen.getByLabelText( 'Operation' ), { target: { value: 'prefix' } } );
		expect( screen.getByLabelText( /Prefix, suffix or template/ ) ).toBeInTheDocument();
		expect( screen.queryByLabelText( 'Find (find & replace)' ) ).not.toBeInTheDocument();

		// Market prices in SEK: the amount input and both price boxes (the tab's own currency, nothing is converted).
		const amount = screen.getByLabelText( 'Amount' );

		expect( amount ).toHaveAttribute( 'inputmode', 'decimal' );
		expect( screen.getByLabelText( 'Regular price' ) ).toBeInTheDocument();
		expect( screen.getByLabelText( 'Sale price' ) ).toBeInTheDocument();

		// Empty: an inline prompt, no request.
		fireEvent.click( screen.getByRole( 'button', { name: 'Adjust market prices: Svenska, apply now to 1 item…' } ) );
		expect( await screen.findByText( 'Fill in "Amount" first.' ) ).toBeInTheDocument();
		expect( run ).not.toHaveBeenCalled();

		// Enter in the amount runs this tool (never the editor's Update) with what is shown.
		fireEvent.change( amount, { target: { value: '5' } } );
		const enter = new KeyboardEvent( 'keydown', { key: 'Enter', bubbles: true, cancelable: true } );
		const outer = vi.fn();

		document.addEventListener( 'keydown', outer );
		amount.dispatchEvent( enter );
		expect( outer ).not.toHaveBeenCalled();
		// Enter asks; a second Enter in the field is not the yes: only the confirm's own button runs it.
		await screen.findByRole( 'button', { name: 'Apply now to 1 item' } );
		amount.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Enter', bubbles: true, cancelable: true } ) );
		document.removeEventListener( 'keydown', outer );
		expect( run ).not.toHaveBeenCalled();
		fireEvent.click( screen.getByRole( 'button', { name: 'Apply now to 1 item' } ) );
		await waitFor( () => expect( run ).toHaveBeenCalledWith( expect.objectContaining( { id: 'i18n_prices' } ), [ 1 ], { lang: 'se', fields: [ 'regular_price' ], operation: 'increase_percent', amount: '5', rounding: 'none' } ) );
	} );

	it( 'show which arguments an operation uses and what is still missing', () => {
		const def = transformAction();
		const find = def.args.find( ( arg ) => arg.id === 'find' )!;
		const text = def.args.find( ( arg ) => arg.id === 'text' )!;
		const amount = pricesAction().args.find( ( arg ) => arg.id === 'amount' )!;

		expect( argShown( find, def, { operation: 'replace' } ) ).toBe( true );
		expect( argShown( text, def, { operation: 'replace' } ) ).toBe( false );
		expect( argShown( text, def, { operation: 'template' } ) ).toBe( true );
		expect( argShown( amount, pricesAction(), { operation: 'round' } ) ).toBe( false );
		expect( missingArg( def, { fields: [ 'name' ], operation: 'replace', find: '' } )?.id ).toBe( 'find' );
		expect( missingArg( def, { fields: [ 'name' ], operation: 'replace', find: 'x' } ) ).toBeNull();
		expect( missingArg( def, { fields: [ 'name' ], operation: 'suffix', text: ' ' } )?.id ).toBe( 'text' );
		// Copy needs no free text.
		expect( missingArg( copyAction(), { fields: [ 'name' ] } ) ).toBeNull();
	} );

	it( 'preview a few before → after values from the loaded translations', () => {
		const fields = coreFields();
		const items = [
			simple( 1, { name: 'Boot', i18n: { se: { name: { value: 'Känga vinter', source: '' } } } } ),
			simple( 2, { name: 'Sandal', i18n: { se: { name: { value: '', source: 'Sandal' } } } } ),
			simple( 3, { name: 'Shoe', i18n: { se: { name: { value: 'Sko vinter', source: '' } } } } ),
		];
		const replace = previewTransform( transformAction(), { fields: [ 'name' ], operation: 'replace', find: 'VINTER', replace: 'sommar', case_insensitive: true, base: 'stored' }, 'i18n:se', items, fields );

		expect( replace?.changes ).toBe( 2 );
		expect( replace?.lines.map( ( line ) => `${ line.before } → ${ line.after }` ) ).toEqual( [ 'Känga vinter → Känga sommar', 'Sko vinter → Sko sommar' ] );

		// A suffix on what untranslated rows show only with "edit the value they show".
		expect( previewTransform( transformAction(), { fields: [ 'name' ], operation: 'suffix', text: ' (SE)', base: 'stored' }, 'i18n:se', items, fields )?.changes ).toBe( 2 );
		expect( previewTransform( transformAction(), { fields: [ 'name' ], operation: 'suffix', text: ' (SE)', base: 'shown' }, 'i18n:se', items, fields )?.lines[ 1 ] ).toMatchObject( { before: '(not translated)', after: 'Sandal (SE)' } );
		expect( previewTransform( transformAction(), { fields: [ 'name' ], operation: 'template', text: '{default_name} | {sku}' }, 'i18n:se', items, fields )?.lines[ 0 ]?.after ).toBe( 'Boot | S1' );
		// Values the editor never loaded (SEO texts in a bulk edit) are unknown, not "(not translated)".
		type Tree = { i18n?: { se?: { name?: { value?: string; source?: string } } } };
		const byPath = fields.map( ( field ) =>
			field.id === 'i18n:se.name' ? { ...field, rest: { ...field.rest, read: ( item: unknown ) => ( item as Tree ).i18n?.se?.name?.value }, reference: ( item: unknown ) => ( item as Tree ).i18n?.se?.name?.source } : field
		) as typeof fields;
		const bare = [ simple( 4, { name: 'Spray' } ) ];
		const unknown = previewTransform( transformAction(), { fields: [ 'name' ], operation: 'suffix', text: ' | Widetoes', base: 'shown' }, 'i18n:se', bare, byPath );

		expect( unknown ).toMatchObject( { changes: 0, unloaded: 1, lines: [] } );
		// {name} in a template on another field (an SEO title) is the name the product shows: its translation, else the default name.
		type Seo = { i18n?: { se?: { meta_title?: { value?: string; source?: string } } } };
		const withSeo = [
			...fields,
			{
				...fields.find( ( field ) => field.id === 'i18n:se.name' )!,
				id: 'i18n:se.meta_title',
				label: 'SEO title',
				rest: { fields: [ 'i18n' ], read: ( item: unknown ) => ( item as Seo ).i18n?.se?.meta_title?.value, applies: { product: true, variation: false } },
				reference: ( item: unknown ) => ( item as Seo ).i18n?.se?.meta_title?.source,
			},
		] as typeof fields;
		const seoDef = transformAction();
		seoDef.args[ 0 ] = { ...seoDef.args[ 0 ], options: [ { value: 'meta_title', label: 'SEO title' } ] } as ( typeof seoDef.args )[ number ];
		const seo = previewTransform( seoDef, { fields: [ 'meta_title' ], operation: 'template', text: '{name} kaufen | Widetoes' }, 'i18n:se', items, withSeo );

		expect( seo?.lines.map( ( line ) => line.after ) ).toEqual( [ 'Känga vinter kaufen | Widetoes', 'Sandal kaufen | Widetoes', 'Sko vinter kaufen | Widetoes' ] );
		// Every token empty for a row: the server skips it, the preview says so.
		const noSku = previewTransform( transformAction(), { fields: [ 'name' ], operation: 'template', text: '{sku} (SE)' }, 'i18n:se', [ simple( 9, { name: 'X', sku: '' } ) ], fields );

		expect( noSku ).toMatchObject( { changes: 0, emptyTemplate: 1 } );
		// Nothing to preview until the text is there.
		expect( previewTransform( transformAction(), { fields: [ 'name' ], operation: 'replace', find: '' }, 'i18n:se', items, fields ) ).toBeNull();
	} );

	it( 'report settings typed and not run yet as unsaved, and not after the run', async () => {
		const onDirtyChange = vi.fn();
		const tools = editSettings( { actions: [ transformAction() ], languages: settings.languages } );

		render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ [ simple( 1 ) ] } settings={ tools } run={ async () => undefined } onDone={ vi.fn() } onDirtyChange={ onDirtyChange } /> );
		fireEvent.click( screen.getByText( /^Svenska tools: / ) );
		fireEvent.change( screen.getByLabelText( 'Find (find & replace)' ), { target: { value: 'x' } } );
		expect( onDirtyChange ).toHaveBeenLastCalledWith( 1 );

		fireEvent.click( screen.getByRole( 'button', { name: 'Edit translated text: Svenska, apply now to 1 item…' } ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Apply now to 1 item' } ) );
		await waitFor( () => expect( onDirtyChange ).toHaveBeenLastCalledWith( 0 ) );
	} );
} );

function base( id: string, label: string, args: DeclarativeAction[ 'args' ] ): DeclarativeAction {
	return { ...copyAction(), id, label, order: 500, args: [ { id: 'lang', label: 'Language', type: 'select', required: true, default: null, options: languages }, ...args ] };
}

function clearAction(): DeclarativeAction {
	return base( 'i18n_clear', 'Clear translations', [ { id: 'fields', label: 'Fields', type: 'array', required: true, default: null, options: [ { value: 'name', label: 'Name' } ] } ] );
}

function transformAction(): DeclarativeAction {
	return base( 'i18n_transform', 'Edit translated text', [
		{ id: 'fields', label: 'Fields', type: 'array', required: true, default: [ 'name' ], options: [ { value: 'name', label: 'Name' } ] },
		{
			id: 'operation',
			label: 'Operation',
			type: 'select',
			required: true,
			default: 'replace',
			options: [
				{ value: 'replace', label: 'Find & replace' },
				{ value: 'prefix', label: 'Add prefix' },
				{ value: 'suffix', label: 'Add suffix' },
				{ value: 'template', label: 'Set from template' },
			],
		},
		{ id: 'find', label: 'Find (find & replace)', type: 'text', required: false, default: null, options: [] },
		{ id: 'replace', label: 'Replace with (find & replace)', type: 'text', required: false, default: null, options: [] },
		{ id: 'case_insensitive', label: 'Ignore case', type: 'boolean', required: false, default: true, options: [] },
		{ id: 'text', label: 'Prefix, suffix or template, e.g. {name} | {brand}', type: 'text', required: false, default: null, options: [] },
		{
			id: 'base',
			label: 'Products without their own translation',
			type: 'select',
			required: false,
			default: 'stored',
			options: [
				{ value: 'stored', label: 'Leave them as they are' },
				{ value: 'shown', label: 'Edit the value they show' },
			],
		},
	] );
}

function pricesAction(): DeclarativeAction {
	return base( 'i18n_prices', 'Adjust market prices', [
		{
			id: 'fields',
			label: 'Prices',
			type: 'array',
			required: true,
			default: [ 'regular_price' ],
			options: [
				{ value: 'regular_price', label: 'Regular price' },
				{ value: 'sale_price', label: 'Sale price' },
			],
		},
		{
			id: 'operation',
			label: 'Price operation',
			type: 'select',
			required: true,
			default: 'increase_percent',
			options: [
				{ value: 'increase_percent', label: 'Increase by %' },
				{ value: 'round', label: 'Round only' },
			],
		},
		{ id: 'amount', label: 'Amount', type: 'number', required: false, default: null, options: [] },
		{
			id: 'rounding',
			label: 'Round to',
			type: 'select',
			required: false,
			default: 'none',
			options: [
				{ value: 'none', label: 'No rounding' },
				{ value: 'x9', label: 'Ending in 9' },
			],
		},
	] );
}
