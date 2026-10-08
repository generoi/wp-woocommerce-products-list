import { describe, expect, it } from 'vitest';
import { editsForItem, projectWarnings, validateBulkNumericEdits } from '../../resources/edit/bulk-numeric';
import { buildPayload } from '../../resources/edit/payload';
import { hasSale, resolveRowEdits, rowsWithExistingSale, saleIsActive, stockGatedRows, willManageStock } from '../../resources/edit/row-rules';
import { planSave } from '../../resources/edit/save-runner';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = withScheduleSale( coreFields() );

describe( 'stock gating', () => {
	const managed = simple( 1, { manage_stock: true, stock_quantity: 2 } );
	const unmanaged = simple( 2, { manage_stock: false, stock_quantity: null } );
	const inherited = variation( 31, 3, { manage_stock: 'parent', stock_quantity: null } );
	const parent = variable( 4, { manage_stock: false } );

	it( 'drops quantity, low stock threshold and backorders for rows that do not manage stock', () => {
		expect( resolveRowEdits( managed, { stock_quantity: '10', status: 'draft' } ) ).toEqual( { stock_quantity: '10', status: 'draft' } );
		expect( resolveRowEdits( unmanaged, { stock_quantity: '10', low_stock_amount: '2', backorders: 'yes', status: 'draft' } ) ).toEqual( { status: 'draft' } );
		expect( resolveRowEdits( inherited, { stock_quantity: '10' } ) ).toEqual( {} );
		expect( stockGatedRows( [ managed, unmanaged, inherited, parent ], { stock_quantity: '10' } ).map( ( row ) => row.id ) ).toEqual( [ 2, 31, 4 ] );
		expect( stockGatedRows( [ managed, unmanaged ], { status: 'draft' } ) ).toEqual( [] );
	} );

	it( 'keeps the edit when the same save turns stock management on, and drops it when it turns it off', () => {
		expect( willManageStock( unmanaged, { manage_stock: true } ) ).toBe( true );
		expect( resolveRowEdits( unmanaged, { manage_stock: true, stock_quantity: '10' } ) ).toEqual( { manage_stock: true, stock_quantity: '10' } );
		expect( resolveRowEdits( managed, { manage_stock: false, stock_quantity: '10' } ) ).toEqual( { manage_stock: false } );
	} );

	it( 'the "turn on Manage stock" option adds manage_stock: true to rows that can take it, never to variable parents', () => {
		expect( resolveRowEdits( unmanaged, { stock_quantity: '10' }, { enableManageStock: true } ) ).toEqual( { stock_quantity: '10', manage_stock: true } );
		expect( resolveRowEdits( inherited, { stock_quantity: '10' }, { enableManageStock: true } ) ).toEqual( { stock_quantity: '10', manage_stock: true } );
		expect( resolveRowEdits( managed, { stock_quantity: '10' }, { enableManageStock: true } ) ).toEqual( { stock_quantity: '10' } );
		expect( resolveRowEdits( parent, { stock_quantity: '10' }, { enableManageStock: true } ) ).toEqual( {} );
		expect( stockGatedRows( [ managed, unmanaged, inherited, parent ], { stock_quantity: '10' }, { enableManageStock: true } ).map( ( row ) => row.id ) ).toEqual( [ 4 ] );
	} );

	it( 'reaches the payload, the validation and the warnings', () => {
		expect( buildPayload( unmanaged, { stock_quantity: '10' }, fields, settings ) ).toEqual( {} );
		expect( buildPayload( unmanaged, { stock_quantity: '10' }, fields, settings, { enableManageStock: true } ) ).toEqual( { stock_quantity: 10, manage_stock: true } );
		expect( buildPayload( unmanaged, { stock_quantity: { operation: 'set', value: '10' } }, fields, settings ) ).toEqual( {} );
		expect( validateBulkNumericEdits( [ unmanaged ], { stock_quantity: '1.5' }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( [ unmanaged ], { stock_quantity: '1.5' }, fields, settings, { enableManageStock: true } ) ).toHaveLength( 1 );
		expect( projectWarnings( [ unmanaged ], { stock_quantity: { operation: 'decrease', value: '10' } }, fields, settings ) ).toEqual( [] );
		expect( editsForItem( unmanaged, { stock_quantity: '10', status: 'draft' }, fields ) ).toEqual( { status: 'draft' } );
	} );

	it( 'the plan counts the skipped rows and the unchanged ones instead of reporting them as updated', () => {
		const items = [ managed, unmanaged, inherited, parent, simple( 5, { manage_stock: true, stock_quantity: 10 } ) ];
		const plan = planSave( items, { stock_quantity: '10' }, fields, settings, { applyToVariations: false } );

		expect( plan.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 1 ] );
		expect( plan.stockSkipped.map( ( row ) => row.id ) ).toEqual( [ 2, 31, 4 ] );
		expect( plan.unchanged ).toBe( 1 );
		expect( plan.products ).toBe( 1 );
		expect( plan.variations ).toBe( 0 );

		const enabled = planSave( items, { stock_quantity: '10' }, fields, settings, { applyToVariations: false, enableManageStock: true } );

		expect( enabled.writes.map( ( entry ) => [ entry.target.item.id, entry.payload ] ) ).toEqual( [
			[ 1, { stock_quantity: 10 } ],
			[ 2, { stock_quantity: 10, manage_stock: true } ],
			[ 31, { stock_quantity: 10, manage_stock: true } ],
		] );
		expect( enabled.stockSkipped.map( ( row ) => row.id ) ).toEqual( [ 4 ] );
		expect( enabled.variations ).toBe( 1 );
	} );
} );

describe( 'existing sales', () => {
	const onSale = variation( 11, 1, { regular_price: '100', sale_price: '75', on_sale: true, date_on_sale_from: null, date_on_sale_to: null } );
	const scheduled = variation( 12, 1, { regular_price: '100', sale_price: '80', on_sale: false, date_on_sale_from: '2099-01-01T00:00:00', date_on_sale_to: null } );
	const noSale = variation( 13, 1, { regular_price: '100', sale_price: '' } );
	const parent = variable( 1, { sale_price: '' } );
	const campaign = { sale_price: { operation: 'regular_minus', value: '20', percent: true }, schedule_sale: true, date_on_sale_from: '2026-10-12T00:00:00', date_on_sale_to: '2026-10-18T23:59:00' };

	it( 'knows which rows have a sale and whether it runs now', () => {
		expect( hasSale( onSale ) ).toBe( true );
		expect( hasSale( noSale ) ).toBe( false );
		expect( saleIsActive( onSale ) ).toBe( true );
		expect( saleIsActive( scheduled ) ).toBe( false );
		// Without wc/v3's on_sale the window decides, from the GMT stamps when present.
		expect( saleIsActive( variation( 14, 1, { sale_price: '5', date_on_sale_from: null, date_on_sale_to: null } ) ) ).toBe( true );
		expect( saleIsActive( variation( 15, 1, { sale_price: '5', date_on_sale_to_gmt: '2000-01-01T00:00:00' } ) ) ).toBe( false );
		expect( saleIsActive( variation( 16, 1, { sale_price: '5', date_on_sale_from_gmt: '2000-01-01T00:00:00', date_on_sale_to_gmt: '2999-01-01T00:00:00' } ) ) ).toBe( true );
	} );

	it( 'counts the rows a sale edit would replace, never variable parents, never for non-sale edits', () => {
		expect( rowsWithExistingSale( [ parent, onSale, scheduled, noSale ], campaign ) ).toEqual( { rows: [ onSale, scheduled ], active: 1 } );
		expect( rowsWithExistingSale( [ onSale ], { status: 'draft' } ) ).toEqual( { rows: [], active: 0 } );
		expect( rowsWithExistingSale( [ onSale ], { regular_price: { operation: 'increase', value: '5' } } ) ).toEqual( { rows: [], active: 0 } );
	} );

	it( 'skipping leaves the sale fields of those rows alone and keeps the other edits', () => {
		expect( resolveRowEdits( onSale, { ...campaign, status: 'publish' }, { skipExistingSales: true } ) ).toEqual( { status: 'publish' } );
		expect( resolveRowEdits( noSale, campaign, { skipExistingSales: true } ) ).toEqual( campaign );
		expect( resolveRowEdits( onSale, campaign ) ).toEqual( campaign );
	} );

	it( 'the plan says how many existing sales are replaced or skipped', () => {
		const items = [ parent ];
		const byParent = new Map( [ [ 1, [ onSale, scheduled, noSale ] ] ] );
		const replace = planSave( items, campaign, fields, settings, { applyToVariations: true, variationsByParent: byParent } );

		expect( replace.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 11, 12, 13 ] );
		expect( replace.replacedSales ).toBe( 2 );
		expect( replace.saleSkipped ).toEqual( [] );
		expect( replace.variations ).toBe( 3 );
		expect( replace.products ).toBe( 0 );

		const skip = planSave( items, campaign, fields, settings, { applyToVariations: true, variationsByParent: byParent, skipExistingSales: true } );

		expect( skip.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 13 ] );
		expect( skip.saleSkipped.map( ( row ) => row.id ) ).toEqual( [ 11, 12 ] );
		expect( skip.replacedSales ).toBe( 0 );
	} );
} );

describe( 'schedule sale without dates', () => {
	it( 'is refused: the sale would start right away', () => {
		const item = variation( 11, 1, { regular_price: '100', sale_price: '' } );
		const errors = validateBulkNumericEdits( [ item ], { sale_price: { operation: 'regular_minus', value: '20', percent: true }, schedule_sale: true }, fields, settings );

		expect( errors ).toHaveLength( 1 );
		expect( errors[ 0 ] ).toMatchObject( { id: 11, field: 'schedule_sale' } );
		expect( errors[ 0 ]?.message ).toMatch( /start immediately/ );
		// A date makes it a schedule; the toggle off is a clear.
		expect( validateBulkNumericEdits( [ item ], { sale_price: { operation: 'set', value: '50' }, schedule_sale: true, date_on_sale_from: '2026-11-01T00:00:00' }, fields, settings ) ).toEqual( [] );
		expect( validateBulkNumericEdits( [ item ], { schedule_sale: false }, fields, settings ) ).toEqual( [] );
		// A stored date counts too.
		expect( validateBulkNumericEdits( [ variation( 12, 1, { regular_price: '100', sale_price: '50', date_on_sale_to: '2026-12-01T00:00:00' } ) ], { schedule_sale: true }, fields, settings ) ).toEqual( [] );
	} );
} );
