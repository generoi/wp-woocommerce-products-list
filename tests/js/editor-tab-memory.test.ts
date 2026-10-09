import { describe, expect, it } from 'vitest';
import { carryTabToNext, openingTab, rememberTab } from '../../resources/edit/inline-editor';

describe( 'editor tab memory', () => {
	it( 'opens on the last tab used when nothing else asks for a tab', () => {
		rememberTab( 'i18n:se' );
		expect( openingTab( undefined ) ).toBe( 'i18n:se' );
		expect( window.sessionStorage.getItem( 'wcProductsList.editorTab' ) ).toBe( 'i18n:se' );
	} );

	it( 'lets the translation filter and Update & next win over the remembered tab', () => {
		rememberTab( 'i18n:se' );
		expect( openingTab( 'i18n:de' ) ).toBe( 'i18n:de' );
		carryTabToNext( 'i18n:en' );
		expect( openingTab( undefined ) ).toBe( 'i18n:en' );
		expect( openingTab( undefined ) ).toBe( 'i18n:se' );
	} );
} );
