/**
 * Copy and clear a language run inline in the editor's language tab, not
 * from a dialog in the action menu; prices are never copied between
 * languages that sell in different currencies.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { argOptions, isEditorHostedAction, LanguageTools, languageToolsFor, toolIds } from '../../resources/edit/language-tools';
import type { DeclarativeAction } from '../../resources/types';
import { editSettings, simple, variation } from './edit-fixtures';

vi.mock( '../../resources/extensions/api', () => ( { getRegisteredActions: () => [], useRegistryVersion: () => 0 } ) );

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

	it( 'run on the editor\'s rows with the tab\'s language and reload the tab', async () => {
		const run = vi.fn( async () => undefined );
		const onDone = vi.fn();

		render( <LanguageTools tabId="i18n:se" tabLabel="Svenska" items={ [ simple( 1 ), variation( 41, 1 ) ] } settings={ settings } run={ run } onDone={ onDone } /> );

		fireEvent.click( screen.getByText( 'Copy or clear Svenska for the selected items' ) );
		expect( screen.queryByLabelText( 'Regular price' ) ).not.toBeInTheDocument();
		fireEvent.click( screen.getByLabelText( 'Name' ) );
		fireEvent.click( screen.getByRole( 'button', { name: 'Copy translations: Svenska (2)' } ) );

		await waitFor( () => expect( onDone ).toHaveBeenCalled() );
		expect( run ).toHaveBeenCalledWith( expect.objectContaining( { id: 'i18n_copy' } ), [ 1, 41 ], { lang: 'se', source: 'fi', fields: [ 'name' ], overwrite: false } );
		expect( toolIds( { ...copyAction(), scope: 'product' }, [ simple( 1 ), variation( 41, 1 ) ] ) ).toEqual( [ 1 ] );
	} );

	it( 'leave the action menu when an editor can host them', async () => {
		const { buildProductActions } = await import( '../../resources/actions/index' );
		const context = { fields: [], settings, view: { type: 'table' }, tab: 'all', hierarchy: {} } as unknown as Parameters< typeof buildProductActions >[ 0 ];

		expect( buildProductActions( { ...context, openEditor: () => {} } ).some( ( action ) => action.id === 'i18n_copy' ) ).toBe( false );
		expect( buildProductActions( context ).some( ( action ) => action.id === 'i18n_copy' ) ).toBe( true );
	} );
} );
