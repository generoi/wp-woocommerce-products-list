import { describe, expect, it } from 'vitest';
import { describeEdits } from '../../resources/edit/change-summary';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = withScheduleSale( coreFields() );

describe( 'describeEdits', () => {
	it( 'names each field, the operation, the rows reached and one projected example', () => {
		const items = [ simple( 1, { name: 'Boot', regular_price: '120' } ), simple( 2, { regular_price: '80' } ), simple( 3, { regular_price: '' } ) ];
		const lines = describeEdits( { regular_price: { operation: 'increase', value: '5', percent: true }, featured: true, status: 'draft' }, fields, items, settings );

		expect( lines ).toHaveLength( 3 );
		expect( lines[ 0 ] ).toMatchObject( { field: 'regular_price', label: 'regular_price', change: '+ 5 %', count: 2, example: 'Boot: 120,00 € → 126,00 €' } );
		expect( lines[ 1 ] ).toMatchObject( { field: 'featured', change: '→ Yes', count: 3 } );
		expect( lines[ 2 ] ).toMatchObject( { field: 'status', change: '→ draft', count: 3 } );
	} );

	it( 'describes sale campaigns: regular price minus, dates and the schedule toggle', () => {
		const items = [ variation( 11, 1, { name: 'Boot 38', regular_price: '100', sale_price: '' } ) ];
		const lines = describeEdits( { sale_price: { operation: 'regular_minus', value: '20', percent: true }, schedule_sale: true, date_on_sale_from: '2026-11-01T00:00:00' }, fields, items, settings );

		expect( lines[ 0 ] ).toMatchObject( { change: 'regular price − 20 %', count: 1, example: 'Boot 38: (empty) → 80,00 €' } );
		expect( lines[ 1 ] ).toMatchObject( { field: 'schedule_sale', change: 'on' } );
		expect( lines[ 2 ] ).toMatchObject( { field: 'date_on_sale_from', count: 1 } );
		expect( lines[ 2 ]?.change ).toMatch( /^→ .*2026/ );
	} );

	it( 'counts the rows a sellable edit reaches: variations, never the variable parent', () => {
		const targets = [ variable( 1 ), simple( 2, { regular_price: '50' } ), variation( 11, 1, { regular_price: '40' } ) ];
		const lines = describeEdits( { sale_price: { operation: 'set', value: '30' } }, fields, targets, settings, true );

		expect( lines[ 0 ] ).toMatchObject( { change: '→ 30,00 €', count: 2 } );
	} );

	it( 'skips unknown fields and idle ops', () => {
		expect( describeEdits( { nope: 'x', stock_quantity: { operation: 'dont_change', value: '' } }, fields, [ simple( 1 ) ], settings ) ).toMatchObject( [ { field: 'stock_quantity', count: 0 } ] );
	} );
} );
