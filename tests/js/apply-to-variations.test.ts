import { describe, expect, it, vi } from 'vitest';
import { fetchAllVariations, resolveSaveTargets, resolveSaveTargetsWith, splitParentEdits, variationFetchFields } from '../../resources/edit/apply-to-variations';
import { coreFields, simple, variable, variation } from './edit-fixtures';

const fields = coreFields();
const saleEdits = { sale_price: { operation: 'set', value: '10' }, date_on_sale_from: '2026-11-01T00:00:00', status: 'publish' };

describe( 'splitParentEdits', () => {
	it( 'separates sellable edits from the rest, by id or leaf', () => {
		expect( splitParentEdits( { ...saleEdits, 'i18n:se.sale_price': '9' }, fields ) ).toEqual( {
			parent: { status: 'publish' },
			sellable: { sale_price: saleEdits.sale_price, date_on_sale_from: saleEdits.date_on_sale_from, 'i18n:se.sale_price': '9' },
		} );
	} );
} );

describe( 'variationFetchFields', () => {
	it( 'always asks for ids, status and the core prices, plus what the edits need', () => {
		const list = variationFetchFields( fields, { 'i18n:se.sale_price': '9' } );

		expect( list ).toEqual( expect.arrayContaining( [ 'id', 'parent_id', 'status', 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to', 'i18n' ] ) );
		expect( list.filter( ( key ) => key === 'i18n' ) ).toHaveLength( 1 );
	} );
} );

describe( 'resolveSaveTargets', () => {
	const fetchVariations = vi.fn( async ( parentId: number, _fields: string[] ) => [ variation( parentId * 10 + 1, parentId ), variation( parentId * 10 + 2, parentId ) ] );

	it( 'simple products and variations get the full edits; variable parents keep only non-sellable ones', async () => {
		const targets = await resolveSaveTargets( [ simple( 1 ), variable( 2 ), variation( 31, 3 ) ], saleEdits, fields, { applyToVariations: false, fetchVariations } );

		expect( targets.map( ( t ) => [ t.item.id, t.edits, t.viaParent ] ) ).toEqual( [
			[ 1, saleEdits, false ],
			[ 2, { status: 'publish' }, false ],
			[ 31, saleEdits, false ],
		] );
		expect( fetchVariations ).not.toHaveBeenCalled();
	} );

	it( 'with applyToVariations the sellable edits go to every variation of each variable parent', async () => {
		fetchVariations.mockClear();

		const targets = await resolveSaveTargets( [ variable( 2 ), variable( 4 ) ], saleEdits, fields, { applyToVariations: true, fetchVariations } );

		expect( fetchVariations ).toHaveBeenCalledTimes( 2 );
		expect( fetchVariations.mock.calls[ 0 ]?.[ 1 ] ).toEqual( expect.arrayContaining( [ 'id', 'sale_price' ] ) );
		expect( targets.map( ( t ) => [ t.item.id, t.viaParent ] ) ).toEqual( [ [ 2, false ], [ 4, false ], [ 21, true ], [ 22, true ], [ 41, true ], [ 42, true ] ] );
		expect( targets[ 2 ]?.edits ).toEqual( { sale_price: saleEdits.sale_price, date_on_sale_from: saleEdits.date_on_sale_from } );
		expect( targets[ 0 ]?.edits ).toEqual( { status: 'publish' } );
	} );

	it( 'does not fetch when nothing sellable is edited', async () => {
		fetchVariations.mockClear();

		const targets = await resolveSaveTargets( [ variable( 2 ) ], { status: 'draft' }, fields, { applyToVariations: true, fetchVariations } );

		expect( fetchVariations ).not.toHaveBeenCalled();
		expect( targets ).toHaveLength( 1 );
	} );

	it( 'a variation selected directly and reached via its parent is saved once with both sets', async () => {
		const selected = variation( 21, 2, { regular_price: '77' } );
		const targets = await resolveSaveTargets( [ variable( 2 ), selected ], { ...saleEdits, stock_quantity: '3' }, fields, { applyToVariations: true, fetchVariations } );
		const direct = targets.find( ( t ) => t.item.id === 21 );

		expect( targets.filter( ( t ) => t.item.id === 21 ) ).toHaveLength( 1 );
		expect( direct?.viaParent ).toBe( false );
		expect( direct?.item ).toBe( selected );
		expect( direct?.edits ).toMatchObject( { stock_quantity: '3', sale_price: saleEdits.sale_price, status: 'publish' } );
	} );

	it( 'skips placeholder rows', async () => {
		const targets = await resolveSaveTargets( [ simple( 1 ), { ...variation( 99, 1 ), _placeholder: 'loading' } ], saleEdits, fields, { applyToVariations: false, fetchVariations } );

		expect( targets.map( ( t ) => t.item.id ) ).toEqual( [ 1 ] );
	} );
} );

describe( 'fetchAllVariations', () => {
	it( 'walks every page', async () => {
		const getPage = vi.fn( async ( parentId: number, page: number ) => ( { items: [ variation( page, parentId ) ], totalPages: 3 } ) );
		const rows = await fetchAllVariations( 7, [ 'id' ], getPage );

		expect( rows.map( ( r ) => r.id ) ).toEqual( [ 1, 2, 3 ] );
		expect( getPage ).toHaveBeenCalledTimes( 3 );
		expect( getPage.mock.calls[ 1 ] ).toEqual( [ 7, 2, [ 'id' ] ] );
	} );
} );

describe( 'resolveSaveTargetsWith, a retry', () => {
	it( 'a parent that only carries its failed variations does not send its own (already saved) edits again', () => {
		const failed = variation( 21, 2 );
		const byParent = new Map( [ [ 2, [ failed ] ] ] );
		const edits = { ...saleEdits, stock_quantity: { operation: 'increase', value: '1' } };

		const carried = resolveSaveTargetsWith( [ variable( 2 ) ], edits, fields, { applyToVariations: true, variationsByParent: byParent, carriersOnly: new Set( [ 2 ] ) } );

		expect( carried.map( ( t ) => t.item.id ) ).toEqual( [ 21 ] );
		expect( carried[ 0 ]?.edits ).not.toHaveProperty( 'stock_quantity' );

		// The parent itself failed: it is sent again with its own edits.
		const again = resolveSaveTargetsWith( [ variable( 2 ) ], edits, fields, { applyToVariations: true, variationsByParent: byParent } );

		expect( again.map( ( t ) => t.item.id ) ).toEqual( [ 2, 21 ] );
		expect( again[ 0 ]?.edits ).toHaveProperty( 'stock_quantity' );
	} );
} );
