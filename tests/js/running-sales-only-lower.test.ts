import { describe, expect, it } from 'vitest';
import { lowersPrice } from '../../resources/edit/bulk-numeric';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { describeRunningSales, salesTheEditReaches } from '../../resources/edit/inline-editor';
import type { RowEditOptions } from '../../resources/edit/row-rules';
import { rowsWithExistingSale } from '../../resources/edit/row-rules';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, variation } from './edit-fixtures';

const settings = editSettings();
const fields = withScheduleSale( coreFields() );
const edits = { sale_price: { operation: 'regular_minus', value: '20', percent: true } };

// Variation 41 is on sale now at 120; the other has a sale scheduled for later.
const rows = [
	variation( 41, 1, { regular_price: '189', sale_price: '120', on_sale: true } ),
	variation( 42, 1, { regular_price: '189', sale_price: '160', on_sale: false, date_on_sale_from: '2099-01-01T00:00:00' } ),
];

describe( 'the existing-sales notice with "Only where lower"', () => {
	it( 'does not count a running sale the option skips as one the update ends', () => {
		const onlyLower: RowEditOptions = { keepSale: ( item: ProductListItem, rowEdits: Record< string, unknown > ) => lowersPrice( item, rowEdits, fields, settings ) };
		const existing = rowsWithExistingSale( rows, edits ).rows;

		expect( describeRunningSales( salesTheEditReaches( existing, edits, {} ), edits, settings ).count ).toBe( 1 );

		const reached = salesTheEditReaches( existing, edits, onlyLower );

		expect( reached.map( ( item ) => item.id ) ).toEqual( [ 42 ] );
		expect( describeRunningSales( reached, edits, settings ) ).toEqual( { count: 0, message: '' } );
	} );
} );
