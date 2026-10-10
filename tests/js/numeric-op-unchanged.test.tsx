import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChangeSummary, describeEdits } from '../../resources/edit/change-summary';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { buildPayload } from '../../resources/edit/payload';
import { planSave } from '../../resources/edit/save-runner';
import { coreFields, editSettings, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = withScheduleSale( coreFields() );

// Product B: 7 variations already on sale at regular − 20 % (151.20), the 8th at 120.
function productB() {
	const rows = [];

	for ( let i = 0; i < 7; i++ ) {
		rows.push( variation( 41 + i, 1, { name: `B – ${ 40 + i }`, regular_price: '189', sale_price: i === 0 ? '151.2' : '151.20' } ) );
	}

	rows.push( variation( 48, 1, { name: 'B – 47', regular_price: '189', sale_price: '120' } ) );

	return rows;
}

const edits = { sale_price: { operation: 'regular_minus', value: '20', percent: true } };

describe( 'a price operation whose result equals the stored price', () => {
	it( 'is not sent for that row', () => {
		const rows = productB();
		const same = rows[ 0 ]!;
		const other = rows[ 7 ]!;

		expect( buildPayload( same, edits, fields, settings ) ).toEqual( {} );
		expect( buildPayload( other, edits, fields, settings ) ).toEqual( { sale_price: '151.20' } );
	} );

	it( 'is planned as unchanged and does not count as a replaced sale', () => {
		const plan = planSave( [ variable( 1 ) ], edits, fields, settings, { applyToVariations: true, variationsByParent: new Map( [ [ 1, productB() ] ] ) } );

		expect( plan.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 48 ] );
		expect( plan.unchanged ).toBe( 7 );
		expect( plan.replacedSales ).toBe( 1 );
	} );

	it( 'is not counted or used as the example in the change summary', () => {
		const line = describeEdits( edits, fields, productB(), settings, true )[ 0 ]!;

		expect( line.count ).toBe( 1 );
		expect( line.rowIds ).toEqual( [ 48 ] );
		expect( line.example ).toBe( 'B – 47: 120,00 € → 151,20 €' );
	} );
} );

describe( 'the change summary when nothing reaches any row', () => {
	it( 'shows no "0 fields will change on 0 rows" box when every row is skipped', () => {
		const targets = [ variation( 11, 1, { regular_price: '189', sale_price: '150' } ), variation( 12, 1, { regular_price: '189', sale_price: '120' } ) ];
		const { container } = render(
			<ChangeSummary edits={ { sale_price: { operation: 'set', value: '140' } } } fields={ fields } targets={ targets } settings={ settings } applyToVariations options={ { skipExistingSales: true } } />
		);

		expect( container ).toBeEmptyDOMElement();
		expect( screen.queryByText( /will change on/ ) ).toBeNull();
	} );

	it( 'keeps only the "already have these values" note when every row already has the result', () => {
		const targets = [ variation( 11, 1, { regular_price: '189', sale_price: '140' } ) ];

		render( <ChangeSummary edits={ { sale_price: { operation: 'set', value: '140' } } } fields={ fields } targets={ targets } settings={ settings } applyToVariations unchanged={ 1 } /> );

		expect( screen.queryByText( /will change on/ ) ).toBeNull();
		expect( screen.getByText( '1 row already has these values and is left as it is.' ) ).toBeInTheDocument();
	} );
} );
