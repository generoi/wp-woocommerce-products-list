import { describe, expect, it } from 'vitest';
import { projectEdits } from '../../resources/edit/bulk-numeric';
import { coreFields, editSettings, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

describe( 'relative sale price ops on rows without a sale', () => {
	it( 'decreases from the regular price when the row has no sale price', () => {
		const row = variation( 11, 1, { regular_price: '100', sale_price: '' } );
		const out = projectEdits( row, { sale_price: { operation: 'decrease', value: '20', percent: true } }, fields, settings );

		expect( Number( out.sale_price ) ).toBe( 80 );
	} );

	it( 'still decreases a running sale from the sale price', () => {
		const row = variation( 12, 1, { regular_price: '100', sale_price: '90' } );
		const out = projectEdits( row, { sale_price: { operation: 'decrease', value: '20', percent: true } }, fields, settings );

		expect( Number( out.sale_price ) ).toBe( 72 );
	} );

	it( 'decreases by an amount from the regular price too', () => {
		const row = variation( 13, 1, { regular_price: '59', sale_price: '' } );
		const out = projectEdits( row, { sale_price: { operation: 'decrease', value: '10' } }, fields, settings );

		expect( Number( out.sale_price ) ).toBe( 49 );
	} );
} );
