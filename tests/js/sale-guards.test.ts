/**
 * Sale campaigns that would raise prices or end running sales say so
 * before Update: the summary counts rows going up and down (a sale price
 * against what the row sells at now), "only where it gets cheaper" leaves
 * the others alone, and a sale scheduled for later warns that it ends the
 * running one now.
 */
import { describe, expect, it } from 'vitest';
import { lowersPrice } from '../../resources/edit/bulk-numeric';
import { describeDirection, describeEdits } from '../../resources/edit/change-summary';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { currentSellingPrice, resolveRowEdits } from '../../resources/edit/row-rules';
import { planSave } from '../../resources/edit/save-runner';
import { coreFields, editSettings, variation } from './edit-fixtures';

const settings = editSettings();
const fields = withScheduleSale( coreFields() );
// Mojo: regular 159, on sale at 70. Diva: regular 159, on sale at 127,20. Plain: regular 159, no sale.
const mojo = variation( 11, 1, { name: 'Mojo 36', regular_price: '159', sale_price: '70', on_sale: true } );
const diva = variation( 12, 1, { name: 'Diva 36', regular_price: '159', sale_price: '127.20', on_sale: true } );
const plain = variation( 13, 1, { name: 'Plain 36', regular_price: '159', sale_price: '' } );
const minus25 = { sale_price: { operation: 'regular_minus', value: '25', percent: true } };

describe( 'sale price direction', () => {
	it( 'compares a new sale price with what the row sells at now', () => {
		expect( currentSellingPrice( mojo ) ).toBe( '70' );
		expect( currentSellingPrice( plain ) ).toBe( '159' );
		expect( lowersPrice( mojo, minus25, fields, settings ) ).toBe( false );
		expect( lowersPrice( diva, minus25, fields, settings ) ).toBe( true );
		expect( lowersPrice( plain, minus25, fields, settings ) ).toBe( true );
		// No new sale price: nothing to guard.
		expect( lowersPrice( mojo, { status: 'draft' }, fields, settings ) ).toBe( true );
	} );

	it( 'the summary splits the rows into lower and HIGHER, with a raised row as the example', () => {
		const [ line ] = describeEdits( minus25, fields, [ diva, mojo, plain ], settings, true );

		expect( line?.direction ).toMatchObject( { lower: 2, higher: 1, againstSelling: true, higherExample: 'Mojo 36: 70,00 € → 119,25 €' } );
		expect( describeDirection( line!.direction! ) ).toBe( 'Lower on 2 rows, HIGHER than the current selling price on 1 row (e.g. Mojo 36: 70,00 € → 119,25 €); all 119,25 €.' );
	} );

	it( '"only where it gets cheaper" leaves the rows it would raise alone and the plan counts them', () => {
		const keepSale = ( item: Parameters< typeof lowersPrice >[ 0 ], edits: Record< string, unknown > ) => lowersPrice( item, edits, fields, settings );

		expect( resolveRowEdits( mojo, { ...minus25, status: 'publish' }, { keepSale } ) ).toEqual( { status: 'publish' } );
		expect( resolveRowEdits( diva, minus25, { keepSale } ) ).toEqual( minus25 );

		const plan = planSave( [ diva, mojo, plain ], minus25, fields, settings, { applyToVariations: false, keepSale } );

		expect( plan.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 12, 13 ] );
		expect( plan.notLowerSkipped.map( ( row ) => row.id ) ).toEqual( [ 11 ] );
		expect( plan.saleSkipped ).toEqual( [] );
	} );
} );
