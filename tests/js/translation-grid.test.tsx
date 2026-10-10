/**
 * "Translate product by product" in a bulk language tab, and the server's
 * dry run of "Edit translated text".
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { gridTextToHtml, htmlToGridText, isPlainParagraphs, TranslationGrid, TranslationStore, translationWriteItem } from '../../resources/edit/translation-grid';
import { ServerPreview, serverPreviewLines, serverPreviewPath, useServerPreview } from '../../resources/edit/server-preview';
import type { ServerPreviewResponse } from '../../resources/edit/server-preview';
import type { DeclarativeAction, ProductField, ProductListItem } from '../../resources/types';

function i18nField( lang: string, name: string ): ProductField {
	return {
		id: `i18n:${ lang }.${ name }`,
		label: `${ lang }: ${ name }`,
		type: 'text',
		rest: {
			fields: [ 'i18n' ],
			read: ( item: unknown ) => ( item as { i18n?: Record< string, Record< string, { value?: string } > > } ).i18n?.[ lang ]?.[ name ]?.value,
			write: ( value: unknown ) => ( { i18n: { [ lang ]: { [ name ]: value } } } ),
		},
		reference: ( item: unknown ) => ( item as { i18n?: Record< string, Record< string, { source?: string } > > } ).i18n?.[ lang ]?.[ name ]?.source,
	} as unknown as ProductField;
}

function product( id: number, name: string, se: { name?: string; short?: string } = {} ): ProductListItem {
	return {
		id,
		name,
		type: 'simple',
		parent_id: 0,
		i18n: { se: { name: { value: se.name ?? '', source: name }, short_description: { value: se.short ?? '', source: '<p>Kuvaus</p>' } } },
	} as unknown as ProductListItem;
}

describe( 'translation grid text', () => {
	it( 'edits plain paragraphs as text and stores them in the same shape', () => {
		expect( isPlainParagraphs( '<p>A &amp; B</p>\n<p>C<br />D</p>' ) ).toBe( true );
		expect( isPlainParagraphs( '<p>A <strong>B</strong></p>' ) ).toBe( false );
		expect( htmlToGridText( '<p>A &amp; B</p>\n<p>C<br />\nD</p>' ) ).toBe( 'A & B\n\nC\nD' );
		expect( gridTextToHtml( 'A & B\n\nC\nD', '<p>old</p>' ) ).toBe( '<p>A &amp; B</p>\n<p>C<br />\nD</p>' );
		// Stored without <p> (wpautop adds them): stays without.
		expect( gridTextToHtml( 'One\n\nTwo <3', 'old' ) ).toBe( 'One\n\nTwo &lt;3' );
		// Other markup is edited as HTML, untouched.
		expect( htmlToGridText( '<ul><li>x</li></ul>' ) ).toBe( '<ul><li>x</li></ul>' );
		expect( gridTextToHtml( '<ul><li>y</li></ul>', '<ul><li>x</li></ul>' ) ).toBe( '<ul><li>y</li></ul>' );
	} );

	it( 'counts products with edits and drops an edit typed back to the stored value', () => {
		const store = new TranslationStore();
		const seen: number[] = [];

		store.subscribe( ( count ) => seen.push( count ) );
		store.set( 1, 'i18n:se.name', 'Sockor', '' );
		store.set( 1, 'i18n:se.short_description', 'x', '' );
		store.set( 2, 'i18n:se.name', 'Skor', '' );
		store.set( 2, 'i18n:se.name', '', '' );

		expect( store.count() ).toBe( 1 );
		expect( store.entries() ).toEqual( [ [ 1, { 'i18n:se.name': 'Sockor', 'i18n:se.short_description': 'x' } ] ] );
		expect( seen ).toEqual( [ 1, 2, 1 ] );
		store.clear( [ 1 ] );
		expect( store.count() ).toBe( 0 );
	} );

	it( 'keeps the value the first keystroke was typed over as the expected value, whatever a later load stored', () => {
		const store = new TranslationStore();

		store.set( 1, 'i18n:se.name', 'A x', 'A' );
		// The grid reloaded meanwhile: the row now stores B, the input still shows the user's text.
		store.set( 1, 'i18n:se.name', 'A xs', 'B' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'A' } );
		expect( store.originalOf( 1, 'i18n:se.name' ) ).toBe( 'A' );

		// Typed back to what was shown: taken out (nothing of the user's to write), but the base stays: the input
		// still shows the user's text over A, so the next keystroke expects A and Update refuses it (B is stored now).
		store.set( 1, 'i18n:se.name', 'A', 'B' );
		expect( store.count() ).toBe( 0 );
		expect( store.originalsOf( 1 ) ).toEqual( {} );
		store.set( 1, 'i18n:se.name', 'A y', 'B' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'A' } );
		// Saved (or discarded): the next edit starts from the value stored then.
		store.clear( [ 1 ] );
		store.set( 1, 'i18n:se.name', 'B y', 'B' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'B' } );
		// Typed to the value stored now: nothing to write either.
		store.set( 1, 'i18n:se.name', 'C', 'C' );
		expect( store.count() ).toBe( 0 );
	} );

	it( 'starts again from the stored value once the input shows it, so a refused edit can be typed over the other writer\'s text', () => {
		const store = new TranslationStore();

		// Typed over A; the save is refused (B stored meanwhile) and the grid reloads: the cell keeps 'A y' with B shown as changed.
		store.set( 1, 'i18n:se.name', 'A y', 'A' );
		// The user takes B (types it out) and adds to it: the input showed B, so B is what the save expects.
		store.set( 1, 'i18n:se.name', 'B', 'B' );
		expect( store.count() ).toBe( 0 );
		store.set( 1, 'i18n:se.name', 'B z', 'B' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'B' } );
	} );

	it( 'forgets a typed-back base once a reload puts the stored value in the cell', () => {
		const store = new TranslationStore();

		store.set( 1, 'i18n:se.name', 'A x', 'A' );
		store.set( 1, 'i18n:se.name', 'A', 'A' );
		// The grid unfolds again with B stored: the untouched cell now shows B.
		store.showsStored( 1, 'i18n:se.name' );
		store.set( 1, 'i18n:se.name', 'B x', 'B' );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'B' } );
		// A cell with an edit keeps its base.
		store.showsStored( 1, 'i18n:se.name' );
		expect( store.originalOf( 1, 'i18n:se.name' ) ).toBe( 'B' );
	} );
} );

describe( 'TranslationGrid', () => {
	it( 'lists the products (not variations) with their texts and moves down the column on Enter', async () => {
		const rows = [ product( 1, 'Villasukat', { name: 'Ullsockor' } ), product( 2, 'Kengät' ) ];
		const load = vi.fn( async () => ( { items: rows, missing: [], parentStamps: new Map() } ) );
		const store = new TranslationStore();
		const fields = [ i18nField( 'se', 'name' ), i18nField( 'se', 'short_description' ) ];
		const variation = { id: 9, name: 'V', type: 'variation', parent_id: 1 } as unknown as ProductListItem;

		render(
			<TranslationGrid
				tabId="i18n:se"
				tabLabel="Svenska"
				items={ [ ...rows, variation ] }
				fields={ fields }
				settings={ { languages: { default: 'fi', others: [ 'se' ], labels: { fi: 'Suomi', se: 'Svenska' } } } }
				store={ store }
				load={ load as never }
			/>
		);

		expect( screen.getByText( /1 variation is not listed/ ) ).toBeTruthy();
		fireEvent.click( screen.getByText( /Translate product by product/ ) );
		const details = document.querySelector( 'details' ) as HTMLDetailsElement;

		details.open = true;
		fireEvent( details, new Event( 'toggle' ) );

		await waitFor( () => expect( screen.getAllByRole( 'textbox' ).length ).toBe( 4 ) );
		expect( load ).toHaveBeenCalledWith( rows, expect.arrayContaining( [ 'i18n.se.name', 'i18n.se.short_description' ] ) );

		const names = Array.from( document.querySelectorAll< HTMLInputElement >( 'input[data-grid-col="name"]' ) );

		expect( names[ 0 ]!.value ).toBe( 'Ullsockor' );
		// No own name: the reference shows what the shop falls back to.
		expect( screen.getByText( /Suomi: Kengät/ ) ).toBeTruthy();
		expect( Array.from( document.querySelectorAll< HTMLTextAreaElement >( 'textarea' ) )[ 0 ]!.placeholder ).toBe( 'Kuvaus' );

		names[ 0 ]!.focus();
		fireEvent.keyDown( names[ 0 ]!, { key: 'Enter' } );
		expect( document.activeElement ).toBe( names[ 1 ] );

		fireEvent.change( names[ 1 ]!, { target: { value: 'Skor' } } );
		expect( store.entries() ).toEqual( [ [ 2, { 'i18n:se.name': 'Skor' } ] ] );
		await waitFor( () => expect( screen.getByText( /1 product changed/ ) ).toBeTruthy() );
	} );

	it( 'expects the value the input showed after the grid is folded, saved over by someone else and unfolded again', async () => {
		const fields = [ i18nField( 'se', 'name' ), i18nField( 'se', 'short_description' ) ];
		let stored = { d: 'Svensk F', e: 'Svensk E' };
		const load = vi.fn( async () => ( { items: [ product( 1, 'D', { name: stored.d } ), product( 2, 'E', { name: stored.e } ) ], missing: [], parentStamps: new Map() } ) );
		const store = new TranslationStore();
		const items = [ product( 1, 'D' ), product( 2, 'E' ) ];

		render(
			<TranslationGrid
				tabId="i18n:se"
				tabLabel="Svenska"
				items={ items }
				fields={ fields }
				settings={ { languages: { default: 'fi', others: [ 'se' ], labels: { fi: 'Suomi', se: 'Svenska' } } } }
				store={ store }
				load={ load as never }
			/>
		);

		const details = document.querySelector( 'details' ) as HTMLDetailsElement;
		const toggle = async ( open: boolean ) => {
			details.open = open;
			await act( async () => {
				fireEvent( details, new Event( 'toggle' ) );
			} );
		};
		const names = () => Array.from( document.querySelectorAll< HTMLInputElement >( 'input[data-grid-col="name"]' ) );

		await toggle( true );
		await waitFor( () => expect( names()[ 0 ]!.value ).toBe( 'Svensk F' ) );
		fireEvent.change( names()[ 0 ]!, { target: { value: 'Svensk F grid' } } );

		// Folded; another user saves both names; unfolded again: the rows reload.
		await toggle( false );
		stored = { d: 'Svensk G', e: 'Svensk H' };
		await toggle( true );
		await waitFor( () => expect( load ).toHaveBeenCalledTimes( 2 ) );

		// The edited cell keeps the user's text and says what is stored now; the untouched one shows the new value.
		await waitFor( () => expect( names()[ 1 ]!.value ).toBe( 'Svensk H' ) );
		expect( names()[ 0 ]!.value ).toBe( 'Svensk F grid' );
		expect( screen.getByText( /Changed by someone else since you started typing, now: Svensk G/ ) ).toBeTruthy();

		fireEvent.change( names()[ 0 ]!, { target: { value: 'Svensk F grids' } } );
		fireEvent.change( names()[ 1 ]!, { target: { value: 'Svensk H2' } } );

		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'Svensk F' } );
		// The registry's i18n fields set their value at the read path (`i18n.se.name.value`).
		const withSetValue = fields.map( ( field ) => ( { ...field, setValue: ( { value }: { value: unknown } ) => ( { i18n: { se: { [ field.id.split( '.' )[ 1 ]! ]: { value } } } } ) } ) ) as unknown as ProductField[];
		const write = ( id: number ) => translationWriteItem( items[ id - 1 ]!, Object.fromEntries( store.entries() )[ id ]!, store.originalsOf( id ), withSetValue, {} as never );

		// Expected: what each input showed when typing began, never the reloaded value D's input did not show.
		expect( write( 1 )._wcpl_expect ).toEqual( { 'i18n.se.name': 'Svensk F' } );
		expect( write( 2 )._wcpl_expect ).toEqual( { 'i18n.se.name': 'Svensk H' } );
	} );

	it( 'expects the reloaded value a typed-back cell shows, so a later edit is never a false conflict', async () => {
		const fields = [ i18nField( 'se', 'name' ) ];
		let stored = 'Svensk F';
		const load = vi.fn( async () => ( { items: [ product( 1, 'D', { name: stored } ) ], missing: [], parentStamps: new Map() } ) );
		const store = new TranslationStore();

		render( <TranslationGrid tabId="i18n:se" tabLabel="Svenska" items={ [ product( 1, 'D' ) ] } fields={ fields } settings={ { languages: { default: 'fi', others: [ 'se' ], labels: {} } } as never } store={ store } load={ load as never } /> );

		const details = document.querySelector( 'details' ) as HTMLDetailsElement;
		const toggle = async ( open: boolean ) => {
			details.open = open;
			await act( async () => {
				fireEvent( details, new Event( 'toggle' ) );
			} );
		};
		const name = () => document.querySelector< HTMLInputElement >( 'input[data-grid-col="name"]' )!;

		await toggle( true );
		await waitFor( () => expect( name().value ).toBe( 'Svensk F' ) );
		fireEvent.change( name(), { target: { value: 'Svensk F x' } } );
		fireEvent.change( name(), { target: { value: 'Svensk F' } } );

		// Another user saves; the grid unfolds again and the untouched cell shows their value.
		await toggle( false );
		stored = 'Svensk G';
		await toggle( true );
		await waitFor( () => expect( name().value ).toBe( 'Svensk G' ) );

		fireEvent.change( name(), { target: { value: 'Svensk G y' } } );
		expect( store.originalsOf( 1 ) ).toEqual( { 'i18n:se.name': 'Svensk G' } );
		expect( screen.queryByText( /Changed by someone else/ ) ).toBeNull();
	} );
} );

const transform: DeclarativeAction = {
	id: 'i18n_transform',
	label: 'Edit translated text',
	args: [
		{ id: 'operation', label: 'Operation', type: 'select', required: true, default: 'replace', options: [] },
		{ id: 'text', label: 'Text', type: 'text', required: false, default: null, options: [] },
	],
} as unknown as DeclarativeAction;

const response: ServerPreviewResponse = {
	items: [
		{ id: 1, name: 'Collonil', name_source: { lang: 'en', label: 'English', own: false, value: 'Collonil' }, fields: { meta_title: { old: '', new: 'Collonil | Brand', status: 'change' } } },
		{ id: 2, name: 'Boot', fields: { meta_title: { old: 'x', new: null, status: 'skipped', reason: 'no_own_name' } } },
		{ id: 3, name: 'Same', fields: { meta_title: { old: 'y', new: null, status: 'unchanged' } } },
		{ id: 4, error: 'gone', message: 'This item no longer exists.' },
	],
	summary: { items: 3, change: 1, unchanged: 1, skipped: 1, error: 0, name_sources: { en: 1 } },
	message: '1 of 3 have no Deutsch name yet: {name} would be the name in English (1).',
};

describe( 'server preview', () => {
	it( 'is asked for text transforms only, when the integration has the route', () => {
		const settings = { languages: { default: 'fi', others: [], labels: {}, routes: { preview: '/gds-woo-i18n/v1/products-list/preview' } } };

		expect( serverPreviewPath( transform, { operation: 'template' }, settings ) ).toBe( '/gds-woo-i18n/v1/products-list/preview' );
		expect( serverPreviewPath( transform, { operation: 'set' }, settings ) ).not.toBeNull();
		expect( serverPreviewPath( transform, { operation: 'clear' }, settings ) ).toBeNull();
		expect( serverPreviewPath( transform, { operation: 'template' }, { languages: { default: 'fi', others: [], labels: {} } } ) ).toBeNull();
	} );

	it( 'lists changes first, names where {name} comes from, and leaves unchanged values out', () => {
		const lines = serverPreviewLines( response, ( field ) => ( field === 'meta_title' ? 'SEO title' : field ), 'Deutsch' );

		expect( lines.map( ( line ) => line.status ) ).toEqual( [ 'change', 'skipped', 'gone' ] );
		expect( lines[ 0 ] ).toMatchObject( { name: 'Collonil', field: 'SEO title', after: 'Collonil | Brand', note: '{name} from English' } );
		expect( lines[ 1 ]!.note ).toBe( 'skipped: no Deutsch name of its own' );

		render( <ServerPreview state={ { result: { ...response, notPreviewed: 0 }, loading: false, failed: false } } fieldLabel={ () => 'SEO title' } langLabel="Deutsch" /> );
		expect( screen.getByText( response.message! ) ).toBeTruthy();
		expect( screen.getByText( /Preview: 1 value changes\. 1 skipped\./ ) ).toBeTruthy();
	} );

	it( 'debounces, sends the first hundred ids and drops a superseded answer', async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn( async ( _path: string, _ids: number[], _args: Record< string, unknown > ) => response );
		const ids = Array.from( { length: 150 }, ( _, index ) => index + 1 );
		let state: ReturnType< typeof useServerPreview > | null = null;

		function Probe( { text }: { text: string } ) {
			state = useServerPreview( '/p', ids, { operation: 'template', text }, fetcher );

			return null;
		}

		const { rerender } = render( <Probe text="{name} a" /> );

		rerender( <Probe text="{name} ab" /> );
		await act( async () => {
			vi.advanceTimersByTime( 400 );
		} );
		vi.useRealTimers();
		await waitFor( () => expect( state!.result ).not.toBeNull() );

		expect( fetcher ).toHaveBeenCalledTimes( 1 );
		expect( fetcher.mock.calls[ 0 ]![ 1 ] ).toHaveLength( 150 );
		expect( ( fetcher.mock.calls[ 0 ]![ 2 ] as { text: string } ).text ).toBe( '{name} ab' );
		expect( state!.result!.notPreviewed ).toBe( 50 );
	} );
} );
