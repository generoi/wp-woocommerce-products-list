import { describe, expect, it } from 'vitest';
import { describeValue } from '../../resources/edit/change-summary';
import { tabPricesInMarketCurrency } from '../../resources/edit/inline-editor';
import type { ProductField } from '../../resources/types';
import { coreFields, editSettings } from './edit-fixtures';

const settings = editSettings();
const sek = { code: 'SEK', symbol: 'kr', decimals: 2 };
const seFields = coreFields().map( ( field ) => ( field.id.startsWith( 'i18n:se.' ) && field.id.endsWith( 'price' ) ? ( { ...field, currency: sek } as ProductField ) : field ) );

describe( 'market prices (SEK) on a language tab', () => {
	it( 'are not described with the shop-currency price range of the variations', () => {
		expect( tabPricesInMarketCurrency( seFields, 'i18n:se', settings ) ).toBe( true );
		expect( tabPricesInMarketCurrency( seFields, 'general', settings ) ).toBe( false );
		// A language whose prices are in the shop currency keeps the range.
		expect( tabPricesInMarketCurrency( coreFields(), 'i18n:se', settings ) ).toBe( false );
	} );

	it( 'read as money in their own currency in the change summary, also when the field is not bulk-editable', () => {
		const regular = seFields.find( ( field ) => field.id === 'i18n:se.regular_price' )!;
		const quickOnly = { ...regular, edit: { ...( regular.edit as object ), bulk: false } } as ProductField;

		expect( describeValue( quickOnly, '1999', settings ) ).toBe( '1 999,00 kr' );
	} );
} );
