/**
 * Round 8 i18n: the market-price tool previews its result and reaches the
 * variations of selected variable parents, a template preview says when
 * {name} is another language's, each language tab has its own tool form,
 * and a tool can be added to Update more than once without the form
 * silently dropping a run already added.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
	describeToolArgs,
	isSellableTool,
	LanguageTools,
	previewPrices,
	previewTransform,
	priceOperation,
	stagedToolIds,
	toolItems,
	toolTargetsLabel,
} from '../../resources/edit/language-tools';
import type { StagedTool } from '../../resources/edit/language-tools';
import type { DeclarativeAction, ProductField, ProductListItem } from '../../resources/types';
import { editSettings, field, simple, variable, variation } from './edit-fixtures';

vi.mock( '../../resources/extensions/api', () => ( { getRegisteredActions: () => [], getQuickEditTabs: () => [], useRegistryVersion: () => 0 } ) );

const languages = [
	{ value: 'se', label: 'Svenska' },
	{ value: 'de', label: 'Deutsch' },
];
const priceApplies = { product: [ 'simple', 'external' ], variation: true };

function action( id: string, label: string, args: DeclarativeAction[ 'args' ] ): DeclarativeAction {
	return {
		id,
		label,
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
		args: [ { id: 'lang', label: 'Language', type: 'select', required: true, default: null, options: languages }, ...args ],
	};
}

function pricesAction(): DeclarativeAction {
	return action( 'i18n_prices', 'Adjust market prices', [
		{
			id: 'fields',
			label: 'Prices',
			type: 'array',
			required: true,
			default: [ 'regular' ],
			options: [
				{ value: 'regular', label: 'Regular price', applies: priceApplies },
				{ value: 'sale', label: 'Sale price', applies: priceApplies },
			],
		},
		{
			id: 'operation',
			label: 'Operation',
			type: 'select',
			required: true,
			default: 'increase_percent',
			options: [
				{ value: 'increase_percent', label: 'Increase by %' },
				{ value: 'round', label: 'Round only' },
				{ value: 'sale_from_regular', label: 'Sale price = regular price − %' },
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
				{ value: 'none', label: 'No rounding (cents)' },
				{ value: 'x9', label: 'Ending in 9 (129, 139)' },
			],
		},
	] );
}

function transformAction(): DeclarativeAction {
	return action( 'i18n_transform', 'Edit translated text', [
		{
			id: 'fields',
			label: 'Fields',
			type: 'array',
			required: true,
			default: [ 'meta_title' ],
			options: [
				{ value: 'meta_title', label: 'SEO title', applies: { product: true, variation: false } },
				{ value: 'meta_description', label: 'SEO description', applies: { product: true, variation: false } },
			],
		},
		{
			id: 'operation',
			label: 'Operation',
			type: 'select',
			required: true,
			default: 'template',
			options: [
				{ value: 'replace', label: 'Find & replace' },
				{ value: 'template', label: 'Set from template' },
			],
		},
		{ id: 'find', label: 'Find', type: 'text', required: false, default: null, options: [] },
		{ id: 'text', label: 'Template', type: 'text', required: false, default: null, options: [] },
		{ id: 'own_name', label: 'Skip products without their own name', type: 'boolean', required: false, default: false, options: [] },
	] );
}

type Tree = Record< string, Record< string, Record< string, { value?: string; source?: string } > > >;

/** An i18n field reading `i18n.{lang}.{name}` and undefined when the row does not carry it (not loaded). */
function i18nField( lang: string, name: string, extra: Partial< ProductField > = {} ): ProductField {
	return field( `i18n:${ lang }.${ name }`, {
		label: name,
		source: 'gds-woo-i18n',
		rest: { fields: [ 'i18n' ], read: ( item ) => ( item as unknown as { i18n?: Tree } ).i18n?.[ lang ]?.[ name ]?.value, applies: { product: true, variation: true } },
		reference: ( item ) => ( item as unknown as { i18n?: Tree } ).i18n?.[ lang ]?.[ name ]?.source,
		...extra,
	} );
}

const sek = { code: 'SEK', symbol: 'kr', decimals: 2 };
const fields = [ i18nField( 'se', 'regular_price', { currency: sek } as Partial< ProductField > ), i18nField( 'se', 'sale_price', { currency: sek } as Partial< ProductField > ), i18nField( 'de', 'name' ), i18nField( 'de', 'meta_title' ), i18nField( 'se', 'name' ), i18nField( 'se', 'meta_title' ) ];
const settings = editSettings( {
	actions: [ pricesAction(), transformAction() ],
	languages: { default: 'fi', others: [ 'se', 'de' ], labels: { fi: 'Suomi', se: 'Svenska', de: 'Deutsch', en: 'English' }, currencies: { fi: 'EUR', se: 'SEK', de: 'EUR' } },
} );

describe( 'market price tool', () => {
	it( 'rounds like the server (159 kr + 5 %, ending in 9 → 169 kr)', () => {
		expect( priceOperation( 15900, 'increase_percent', 5, 'x9' ) ).toBe( 16900 );
		expect( priceOperation( 15900, 'increase_percent', 5, 'none' ) ).toBe( 16695 );
		expect( priceOperation( null, 'increase_percent', 5, 'none' ) ).toBeNull();
		expect( priceOperation( null, 'set', 199, 'none' ) ).toBe( 19900 );
	} );

	it( 'previews before → after from the shown market price, with the lowest and highest result', () => {
		const items = [
			simple( 1, { name: 'Organic Care', i18n: { se: { regular_price: { value: '', source: '159' }, sale_price: { value: '', source: '' } } } } ),
			simple( 2, { name: 'Organic Cover', i18n: { se: { regular_price: { value: '129', source: '139' }, sale_price: { value: '', source: '' } } } } ),
			// Not loaded: counted, not guessed.
			simple( 3, { name: 'Spray' } ),
		];
		const preview = previewPrices( pricesAction(), { fields: [ 'regular' ], operation: 'increase_percent', amount: '5', rounding: 'x9' }, 'i18n:se', items, fields, settings );

		expect( preview?.changes ).toBe( 2 );
		expect( preview?.unloaded ).toBe( 1 );
		expect( preview?.lines.map( ( line ) => `${ line.label }: ${ line.before } → ${ line.after }` ) ).toEqual( [ 'Organic Care: 159,00 kr → 169,00 kr', 'Organic Cover: 129,00 kr → 139,00 kr' ] );
		expect( preview?.lowest ).toBe( '139,00 kr' );
		expect( preview?.highest ).toBe( '169,00 kr' );

		// A sale that would not be below the regular price is refused by the server: said before Apply.
		const sale = previewPrices( pricesAction(), { fields: [ 'sale' ], operation: 'increase_percent', amount: '50', rounding: 'none' }, 'i18n:se', [ simple( 4, { i18n: { se: { regular_price: { value: '', source: '100' }, sale_price: { value: '', source: '80' } } } } ) ], fields, settings );

		expect( sale ).toMatchObject( { changes: 0, invalid: 1 } );
	} );

	it( 'warns about a regular price lowered to or below the sale price the shop shows, as the server refuses it', () => {
		// 1 799,10 kr − 10 % = 1 619,19 kr, below the 1 799 kr sale: gds_woo_i18n_sale_not_below_regular.
		const items = [
			simple( 6, { i18n: { se: { regular_price: { value: '1799.10', source: '' }, sale_price: { value: '1799', source: '' } } } } ),
			// A converted (not own) sale price counts too.
			simple( 7, { i18n: { se: { regular_price: { value: '', source: '200' }, sale_price: { value: '', source: '185' } } } } ),
			simple( 8, { i18n: { se: { regular_price: { value: '300', source: '' }, sale_price: { value: '', source: '' } } } } ),
		];
		const preview = previewPrices( pricesAction(), { fields: [ 'regular' ], operation: 'decrease_percent', amount: '10', rounding: 'none' }, 'i18n:se', items, fields, settings );

		expect( preview ).toMatchObject( { invalid: 2, changes: 1 } );
		expect( preview?.lines.map( ( line ) => line.id ) ).toEqual( [ 8 ] );
	} );

	it( 'does not take a sale price that is not loaded for "no sale" (bulk edit: the list carries only the regular price column)', () => {
		const items = [
			// The list's "Svenska: Regular price" column, no sale price loaded: the server checks against the stored 880 kr.
			simple( 9, { i18n: { se: { regular_price: { value: '899.50', source: '' } } } } ),
			simple( 10, { i18n: { se: { regular_price: { value: '899.50', source: '' }, sale_price: { value: '880', source: '' } } } } ),
		];
		const preview = previewPrices( pricesAction(), { fields: [ 'regular' ], operation: 'decrease_percent', amount: '10', rounding: 'none' }, 'i18n:se', items, fields, settings );

		expect( preview ).toMatchObject( { changes: 0, invalid: 1, unloaded: 1 } );
	} );

	it( 'reaches the variations of selected variable parents only as a price tool', () => {
		const parent = variable( 10 );
		const reached = [ variation( 11, 10 ), variation( 12, 10 ) ];

		expect( isSellableTool( pricesAction() ) ).toBe( true );
		expect( isSellableTool( transformAction() ) ).toBe( false );
		// The parent has no price of its own: its variations stand in for it.
		expect( toolItems( pricesAction(), [ parent ], reached ).map( ( item ) => item.id ) ).toEqual( [ 11, 12 ] );
		expect( toolItems( transformAction(), [ parent ], reached ).map( ( item ) => item.id ) ).toEqual( [ 10 ] );
		expect( toolTargetsLabel( pricesAction(), [ parent, simple( 5 ) ], reached ) ).toBe( '2 variations of 1 product and 1 other item' );
		expect( stagedToolIds( { def: pricesAction() }, [ parent ], reached ) ).toEqual( [ 11, 12 ] );
	} );

	it( 'says why it is unavailable on variable parents, and works once their variations are in', () => {
		const run = vi.fn( async () => undefined );
		const items = [ variable( 10 ) ];
		const { rerender } = render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ items } settings={ settings } run={ run } onDone={ vi.fn() } /> );

		// Quick edit (one product) names its own control.
		expect( screen.getByText( /This variable product has no prices of its own\. Tick "Set the price of all its variations" in Prices/ ) ).toBeInTheDocument();
		expect( screen.queryByText( /Also apply to the variations/ ) ).toBeNull();
		expect( screen.queryByText( /variations have no name or SEO fields/ ) ).toBeNull();

		rerender( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ items } settings={ settings } run={ run } onDone={ vi.fn() } applyToVariations parentVariations={ [ variation( 11, 10 ), variation( 12, 10 ) ] } /> );

		const button = screen.getByRole( 'button', { name: /Adjust market prices: Svenska, apply now to 2 variations of 1 product/ } );

		expect( button ).toHaveAttribute( 'aria-disabled', 'false' );
	} );
} );

describe( 'market price tool in bulk edit', () => {
	it( 'names the bulk control when several variable products are selected', () => {
		render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ [ variable( 10 ), variable( 20 ) ] } settings={ settings } run={ vi.fn( async () => undefined ) } onDone={ vi.fn() } /> );

		expect( screen.getByText( /Variable products have no prices of their own\. Tick "Also apply to the variations" in Prices/ ) ).toBeInTheDocument();
		expect( screen.queryByText( /Set the price of all its variations/ ) ).toBeNull();
	} );

	it( 'names the bulk control when bulk edit is down to one variable product', () => {
		render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ [ variable( 10 ) ] } settings={ settings } run={ vi.fn( async () => undefined ) } onDone={ vi.fn() } bulk /> );

		expect( screen.getByText( /Tick "Also apply to the variations" in Prices/ ) ).toBeInTheDocument();
		expect( screen.queryByText( /Set the price of all its variations/ ) ).toBeNull();
	} );
} );

describe( 'template preview', () => {
	it( 'shows the name the server fills in, and says when it is another language\'s', () => {
		const items: ProductListItem[] = [
			simple( 40755, { name: 'Organic Clean (FI)', i18n: { de: { name: { value: '', source: 'Organic Clean (FI)', effective: 'Organic Clean (EN)', effectiveLang: 'en' }, meta_title: { value: '', source: '' } } } } as never ),
			simple( 40756, { name: 'Organic Care (FI)', i18n: { de: { name: { value: 'Organic Care (DE)', source: 'Organic Care (FI)' }, meta_title: { value: '', source: '' } } } } as never ),
		];
		const data = { fields: [ 'meta_title' ], operation: 'template', text: '{name} | Schuhpflege' };
		const preview = previewTransform( transformAction(), data, 'i18n:de', items, fields, settings );

		expect( preview?.lines.map( ( line ) => line.after ) ).toEqual( [ 'Organic Clean (EN) | Schuhpflege', 'Organic Care (DE) | Schuhpflege' ] );
		expect( preview?.lines[ 0 ]?.note ).toBe( '{name} is the English name: no Deutsch name' );
		expect( preview?.lines[ 1 ]?.note ).toBeUndefined();
		expect( preview?.fallbackName ).toBe( 1 );

		// "Skip products without their own name" leaves the first one out, as the server does.
		const skipping = previewTransform( transformAction(), { ...data, own_name: true }, 'i18n:de', items, fields, settings );

		expect( skipping ).toMatchObject( { changes: 1, skippedNoName: 1, fallbackName: 0 } );
	} );

	it( 'does not guess a name it has not loaded', () => {
		const preview = previewTransform( transformAction(), { fields: [ 'meta_title' ], operation: 'template', text: '{name} | Shop' }, 'i18n:se', [ simple( 7, { name: 'Finnish name', i18n: { se: { meta_title: { value: '', source: '' } } } } ) ], fields, settings );

		expect( preview?.lines[ 0 ]?.after ).toBe( '{name} | Shop' );
		expect( preview?.lines[ 0 ]?.note ).toMatch( /not loaded/ );
	} );
} );

describe( 'staged language tools', () => {
	function Host( { tabId }: { tabId: string } ) {
		const [ staged, setStaged ] = useState< ReadonlyMap< string, StagedTool > >( () => new Map() );
		const stage = ( key: string, entry: StagedTool | null ) =>
			setStaged( ( current ) => {
				const next = new Map( current );

				if ( entry ) {
					next.set( key, entry );
				} else {
					next.delete( key );
				}

				return next;
			} );

		return (
			<>
				<LanguageTools tabId={ tabId } tabLabel={ tabId === 'i18n:de' ? 'Deutsch' : 'Svenska' } items={ [ simple( 1 ), simple( 2 ) ] } settings={ { ...settings, actions: [ transformAction() ] } } fields={ fields } run={ vi.fn() } onDone={ vi.fn() } stage={ stage } staged={ staged } />
				<output data-testid="staged">{ Array.from( staged.values() ).map( ( entry ) => `${ entry.tabId }|${ String( entry.args.text ) }|${ ( entry.args.fields as string[] ).join( ',' ) }` ).join( ';' ) }</output>
			</>
		);
	}

	it( 'adds several runs per language, keeps them when the form changes, and keeps each tab\'s form apart', () => {
		const { rerender } = render( <Host tabId="i18n:de" /> );

		fireEvent.change( screen.getByLabelText( 'Template' ), { target: { value: '{name} – Schuhpflege' } } );
		fireEvent.click( screen.getByRole( 'button', { name: /Edit translated text: Deutsch, add to Update/ } ) );
		expect( screen.getByTestId( 'staged' ) ).toHaveTextContent( 'i18n:de|{name} – Schuhpflege|meta_title' );
		// The form is free again; what was added is listed with its settings.
		expect( screen.getByLabelText( 'Template' ) ).toHaveValue( '' );
		expect( screen.getByText( /SEO title · Set from template · “\{name\} – Schuhpflege”, runs on 2 items with Update/ ) ).toBeInTheDocument();

		// Changing the form (another field) does not take the added run out; a second run is added next to it.
		fireEvent.click( screen.getByLabelText( 'SEO title' ) );
		fireEvent.click( screen.getByLabelText( 'SEO description' ) );
		fireEvent.change( screen.getByLabelText( 'Template' ), { target: { value: '{name} kaufen' } } );
		expect( screen.getByTestId( 'staged' ) ).toHaveTextContent( 'i18n:de|{name} – Schuhpflege|meta_title' );
		fireEvent.click( screen.getByRole( 'button', { name: /add another run to Update/ } ) );
		expect( screen.getByTestId( 'staged' ) ).toHaveTextContent( 'i18n:de|{name} – Schuhpflege|meta_title;i18n:de|{name} kaufen|meta_description' );

		// The same run twice is refused.
		fireEvent.click( screen.getByLabelText( 'SEO title' ) );
		fireEvent.click( screen.getByLabelText( 'SEO description' ) );
		fireEvent.change( screen.getByLabelText( 'Template' ), { target: { value: '{name} kaufen' } } );
		fireEvent.click( screen.getByRole( 'button', { name: /add another run to Update/ } ) );
		expect( screen.getByRole( 'alert' ) ).toHaveTextContent( 'already added' );

		// Another language starts from its own (default) settings, not the German ones.
		fireEvent.change( screen.getByLabelText( 'Template' ), { target: { value: 'typed in German' } } );
		rerender( <Host tabId="i18n:se" /> );
		expect( screen.getByLabelText( 'Template' ) ).toHaveValue( '' );
		expect( screen.queryByText( /runs on 2 items with Update/ ) ).toBeNull();
	} );

	it( 'describes a run by its settings', () => {
		expect( describeToolArgs( pricesAction(), { lang: 'se', fields: [ 'regular' ], operation: 'increase_percent', amount: '5', rounding: 'x9' } ) ).toBe( 'Regular price · Increase by % · 5 · Ending in 9 (129, 139)' );
	} );
} );
