import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSettings as getDateSettings, setSettings as setDateSettings } from '@wordpress/date';
import { describeEdits, describeSiteDateTime } from '../../resources/edit/change-summary';
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
		expect( lines[ 1 ] ).toMatchObject( { field: 'schedule_sale' } );
		// What the sale runs from and to, never just "on".
		expect( lines[ 1 ]?.change ).toMatch( /^on: from .*2026.*, to as each row has it$/ );
		expect( lines[ 2 ] ).toMatchObject( { field: 'date_on_sale_from', count: 1 } );
		expect( lines[ 2 ]?.change ).toMatch( /^→ .*2026/ );
	} );

	it( 'counts the rows a sellable edit reaches: variations, never the variable parent', () => {
		const targets = [ variable( 1 ), simple( 2, { regular_price: '50' } ), variation( 11, 1, { regular_price: '40' } ) ];
		const lines = describeEdits( { sale_price: { operation: 'set', value: '30' } }, fields, targets, settings, true );

		expect( lines[ 0 ] ).toMatchObject( { change: '→ 30,00 €', count: 2 } );
	} );

	it( 'gives a variation reached only through its selected parent the price and sale edits alone', () => {
		const targets = [ variable( 1, { status: 'draft' } ), simple( 2, { regular_price: '50', status: 'draft' } ), variation( 11, 1, { regular_price: '40', status: 'publish' } ) ];
		const lines = describeEdits( { regular_price: { operation: 'increase', value: '1' }, status: 'private' }, fields, targets, settings, true, {}, new Set( [ 11 ] ) );

		expect( lines.find( ( line ) => line.field === 'regular_price' ) ).toMatchObject( { count: 2, rowIds: [ 2, 11 ] } );
		// The save sends the status to the selected products, not to the variations it adds for the prices.
		expect( lines.find( ( line ) => line.field === 'status' ) ).toMatchObject( { count: 2, rowIds: [ 1, 2 ] } );
	} );

	it( 'counts a plain value only on the rows that do not hold it already', () => {
		const items = [ simple( 1, { featured: true } ), simple( 2, { featured: false } ), simple( 3, { featured: true } ) ];
		const lines = describeEdits( { featured: true }, fields, items, settings );

		expect( lines[ 0 ] ).toMatchObject( { field: 'featured', count: 1, rowIds: [ 2 ] } );
	} );

	it( 'skips unknown fields and idle ops', () => {
		expect( describeEdits( { nope: 'x', stock_quantity: { operation: 'dont_change', value: '' } }, fields, [ simple( 1 ) ], settings ) ).toMatchObject( [ { field: 'stock_quantity', count: 0 } ] );
	} );
} );

describe( 'describeSiteDateTime', () => {
	const dateSettings = getDateSettings();

	beforeAll( () => setDateSettings( { ...dateSettings, timezone: { offset: 0, offsetFormatted: '0', string: 'UTC', abbr: 'UTC' } } ) );
	afterAll( () => setDateSettings( dateSettings ) );

	it( 'shows the wall-clock value the control emits, whatever the browser timezone, and says it is site time', () => {
		expect( describeSiteDateTime( '2026-11-01T00:00:00', settings ) ).toBe( '1.11.2026 00:00 (site time)' );
		expect( describeSiteDateTime( '2026-11-30T23:59:00', settings ) ).toBe( '30.11.2026 23:59 (site time)' );
		// A zoned instant is shown in the site's zone.
		expect( describeSiteDateTime( '2026-10-31T22:00:00Z', settings ) ).toBe( '31.10.2026 22:00 (site time)' );
	} );

	it( 'is what the summary line shows for a sale date', () => {
		const lines = describeEdits( { date_on_sale_from: '2026-11-01T00:00:00' }, fields, [ simple( 1, { regular_price: '10' } ) ], settings );

		expect( lines[ 0 ]?.change ).toBe( '→ 1.11.2026 00:00 (site time)' );
	} );
} );
