import { describe, expect, it, vi } from 'vitest';
import { isGoneCode } from '../../resources/edit/errors';
import { hydrateSelection } from '../../resources/edit/hydrate';
import type { HydrateDeps } from '../../resources/edit/hydrate';
import { listNames, saveLabelFor, successMessage } from '../../resources/edit/product-edit-modal';
import { planSave, runSave } from '../../resources/edit/save-runner';
import type { SaveDeps, SavePlan, SaveResult } from '../../resources/edit/save-runner';
import type { BatchResponse, RawProduct } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

function plan( overrides: Partial< SavePlan > ): SavePlan {
	return { writes: [], products: 0, variations: 0, unchanged: 0, stockSkipped: [], saleSkipped: [], replacedSales: 0, ...overrides };
}

function result( overrides: Partial< SaveResult > ): SaveResult {
	return { updated: [], errors: [], batchId: 'b', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0, ...overrides };
}

describe( 'planSave', () => {
	it( 'counts what is written per kind, with the variations of variable parents when applied', () => {
		const parents = [ variable( 1 ), variable( 2 ), simple( 3, { regular_price: '100', sale_price: '' } ) ];
		const byParent = new Map( [
			[ 1, [ variation( 11, 1, { regular_price: '50' } ), variation( 12, 1, { regular_price: '60' } ) ] ],
			[ 2, [ variation( 21, 2, { regular_price: '70' } ) ] ],
		] );
		const edits = { sale_price: { operation: 'regular_minus', value: '20', percent: true } };

		const applied = planSave( parents, edits, fields, settings, { applyToVariations: true, variationsByParent: byParent } );

		expect( applied.variations ).toBe( 3 );
		expect( applied.products ).toBe( 1 );
		expect( applied.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 1, 2, 3, 11, 12, 21 ].filter( ( id ) => id !== 1 && id !== 2 ) );

		// Without the option the parents get nothing sellable and the simple one is written alone.
		const alone = planSave( parents, edits, fields, settings, { applyToVariations: false } );

		expect( alone.products ).toBe( 1 );
		expect( alone.variations ).toBe( 0 );
	} );

	it( 'rows that already have the value are unchanged, not written', () => {
		const items = [ simple( 1, { featured: false } ), simple( 2, { featured: true } ), simple( 3, { featured: false } ) ];
		const featured = planSave( items, { featured: true }, fields, settings, { applyToVariations: false } );

		expect( featured.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 1, 3 ] );
		expect( featured.unchanged ).toBe( 1 );
	} );
} );

describe( 'saveLabelFor', () => {
	it( 'says what will be written', () => {
		expect( saveLabelFor( plan( { variations: 158 } ) ) ).toBe( 'Save 158 variations' );
		expect( saveLabelFor( plan( { products: 3, variations: 31 } ) ) ).toBe( 'Save 3 products, 31 variations' );
		expect( saveLabelFor( plan( { products: 1 } ) ) ).toBe( 'Save 1 product' );
		expect( saveLabelFor( plan( { products: 90 } ) ) ).toBe( 'Save 90 products' );
		expect( saveLabelFor( plan( {} ) ) ).toBe( 'Nothing to save' );
	} );
} );

describe( 'successMessage', () => {
	it( 'explains the no-ops and the skips next to the count', () => {
		const rows = Array.from( { length: 90 }, ( _, index ) => simple( index + 1 ) );

		expect( successMessage( result( { updated: rows } ) ) ).toBe( '90 items updated.' );
		expect( successMessage( result( { updated: rows, unchanged: 10 } ) ) ).toBe( '90 items updated, 10 unchanged.' );
		expect( successMessage( result( { updated: rows.slice( 0, 31 ), stockSkipped: 3 } ) ) ).toBe( '31 items updated, 3 skipped (no stock management).' );
		expect( successMessage( result( { updated: rows, replacedSales: 73 } ) ) ).toBe( '90 items updated, 73 existing sales replaced.' );
		expect( successMessage( result( { updated: rows.slice( 0, 1 ), saleSkipped: 2 } ) ) ).toBe( '1 item updated, 2 skipped (already on sale).' );
		expect( successMessage( result( { unchanged: 100 } ) ) ).toBe( 'Nothing changed: 100 unchanged.' );
		expect( successMessage( result( { stockSkipped: 100 } ) ) ).toBe( 'Nothing changed: 100 skipped (no stock management).' );
		expect( successMessage( result( {} ) ) ).toBe( 'Nothing to change.' );
	} );
} );

describe( 'listNames', () => {
	it( 'lists a few names and counts the rest', () => {
		expect( listNames( [ simple( 1, { name: 'A' } ), simple( 2, { name: 'B' } ) ] ) ).toBe( 'A, B' );
		expect( listNames( Array.from( { length: 7 }, ( _, index ) => simple( index + 1, { name: `N${ index + 1 }` } ) ) ) ).toBe( 'N1, N2, N3, N4, N5 and 2 more' );
		expect( listNames( [ simple( 9, { name: '' } ) ] ) ).toBe( '#9' );
	} );
} );

describe( 'rows that no longer exist', () => {
	it( 'are told apart by their wc/v3 code', () => {
		expect( isGoneCode( 'woocommerce_rest_product_invalid_id' ) ).toBe( true );
		expect( isGoneCode( 'woocommerce_rest_variation_invalid_id' ) ).toBe( true );
		expect( isGoneCode( 'rest_invalid_param' ) ).toBe( false );
		expect( isGoneCode( undefined ) ).toBe( false );
	} );

	it( 'hydrateSelection names the ids the server did not return', async () => {
		const deps = {
			listProducts: vi.fn( async ( query: Record< string, unknown > ) => ( {
				items: String( query.include )
					.split( ',' )
					.filter( ( id ) => id !== '2' )
					.map( ( id ) => simple( Number( id ), { regular_price: '1' } ) ),
				total: 0,
				totalPages: 1,
			} ) ),
			getVariations: vi.fn( async () => ( { items: [], total: 0, totalPages: 1 } ) ),
		} as unknown as HydrateDeps;
		const { items, missing } = await hydrateSelection( [ simple( 1 ), simple( 2 ), variation( 31, 3 ) ], [ 'id' ], deps );

		expect( items.map( ( row ) => row.id ) ).toEqual( [ 1, 2, 31 ] );
		expect( missing ).toEqual( [ 2, 31 ] );
	} );

	it( 'one of three failing keeps the other two saved and reports the failed one with its code', async () => {
		const batchProducts = vi.fn( async ( update: Array< { id: number } > ) => ( {
			update: update.map( ( row ) => ( row.id === 3 ? { id: 3, error: { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' } } : { ...row } ) ),
		} ) as BatchResponse< RawProduct > );
		const deps: SaveDeps = {
			batchProducts,
			batchVariations: vi.fn( async () => ( { update: [] } ) ),
			fetchVariations: vi.fn( async () => [] ),
			patchItems: vi.fn(),
			newBatchId: () => 'batch-1',
			batchSize: 50,
		};
		const saved = await runSave( deps, [ simple( 1, { featured: false } ), simple( 2, { featured: false } ), simple( 3, { featured: false } ) ], { featured: true }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( saved.updated.map( ( row ) => row.id ) ).toEqual( [ 1, 2 ] );
		expect( saved.errors ).toEqual( [ { id: 3, code: 'woocommerce_rest_product_invalid_id', message: expect.stringMatching( /no longer exists/ ) } ] );
		expect( saved.errors.filter( ( error ) => isGoneCode( error.code ) ).map( ( error ) => error.id ) ).toEqual( [ 3 ] );
	} );
} );
