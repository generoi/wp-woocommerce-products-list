import { describe, expect, it, vi } from 'vitest';
import { prepareSave, runSave } from '../../resources/edit/save-runner';
import type { SaveDeps } from '../../resources/edit/save-runner';
import type { BatchResponse, ProductListItem, RawProduct, RawVariation } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

type Update = { id: number } & Record< string, unknown >;

function deps( overrides: Partial< SaveDeps > = {} ): SaveDeps & { calls: string[] } {
	const calls: string[] = [];
	const echo = < T extends { id: number } >( update: T[] ) => ( { update: update.map( ( row ) => ( { ...row, echoed: true } ) ) } );

	return {
		calls,
		batchProducts: vi.fn( async ( update: Update[] ) => {
			calls.push( `products:${ update.map( ( row ) => row.id ).join( ',' ) }` );

			return echo( update ) as BatchResponse< RawProduct >;
		} ),
		batchVariations: vi.fn( async ( parentId: number, update: Update[] ) => {
			calls.push( `variations:${ parentId }:${ update.map( ( row ) => row.id ).join( ',' ) }` );

			return echo( update ) as BatchResponse< RawVariation >;
		} ),
		fetchVariations: vi.fn( async ( parentId: number ) => [ variation( parentId * 10 + 1, parentId, { regular_price: '100' } ), variation( parentId * 10 + 2, parentId, { regular_price: '50' } ) ] ),
		patchItems: vi.fn(),
		newBatchId: () => 'batch-1',
		batchSize: 2,
		...overrides,
	};
}

describe( 'prepareSave', () => {
	it( 'drops rows with nothing to send', async () => {
		const d = deps();
		const prepared = await prepareSave( d, [ simple( 1, { status: 'draft' } ), simple( 2, { status: 'publish' } ) ], { status: 'draft' }, fields, settings, { applyToVariations: false } );

		expect( prepared.map( ( p ) => p.target.item.id ) ).toEqual( [ 2 ] );
		expect( prepared[ 0 ]?.payload ).toEqual( { status: 'draft' } );
		expect( prepared[ 0 ]?.snapshot ).toEqual( { id: 2, status: 'publish' } );
	} );
} );

describe( 'runSave', () => {
	it( 'writes the variations of every parent through the cross-parent batch when the dep is there', async () => {
		const d = deps( { variationsBatchSize: 3 } );
		const across = vi.fn( async ( update: Array< Update & { parent_id: number } > ) => {
			d.calls.push( `across:${ update.map( ( row ) => `${ row.parent_id }/${ row.id }` ).join( ',' ) }` );

			return { update: update.map( ( { parent_id: _parent, ...row } ) => ( { ...row, echoed: true } ) ) } as BatchResponse< RawVariation >;
		} );
		d.batchVariationsAcross = across;
		const progress: Array< [ number, number ] > = [];
		const items = [ simple( 1 ), variation( 41, 4 ), variation( 51, 5 ), variation( 42, 4 ), variation( 61, 6 ) ];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', onProgress: ( done, total ) => progress.push( [ done, total ] ) } );

		// Grouped by parent, chunked by the cross-parent size, parents after.
		expect( d.calls ).toEqual( [ 'across:4/41,4/42,5/51', 'across:6/61', 'products:1' ] );
		expect( d.batchVariations ).not.toHaveBeenCalled();
		expect( across ).toHaveBeenCalledWith( [ { id: 41, parent_id: 4, status: 'draft' }, { id: 42, parent_id: 4, status: 'draft' }, { id: 51, parent_id: 5, status: 'draft' } ], { batchId: 'batch-1', source: 'bulk' } );
		expect( result.errors ).toEqual( [] );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 41, 42, 51, 61, 1 ] );
		expect( progress ).toEqual( [ [ 0, 5 ], [ 3, 5 ], [ 4, 5 ], [ 5, 5 ] ] );
	} );

	it( 'reports every row of a failed cross-parent request and rolls it back', async () => {
		const d = deps( { batchVariationsAcross: vi.fn( async () => { throw Object.assign( new Error( 'Boom' ), { code: 'http_500' } ); } ) } );
		const items = [ variation( 41, 4 ), variation( 51, 5 ) ];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.updated ).toEqual( [] );
		expect( result.errors.map( ( error ) => [ error.id, error.code ] ) ).toEqual( [ [ 41, 'http_500' ], [ 51, 'http_500' ] ] );
		// Optimistic patch, then every snapshot of the group back in one patch.
		expect( d.patchItems ).toHaveBeenLastCalledWith( [ { id: 41, status: 'publish' }, { id: 51, status: 'publish' } ] );
	} );

	it( 'saves variations per parent first, then parents, chunked, with progress', async () => {
		const d = deps();
		const progress: Array< [ number, number ] > = [];
		const items = [ simple( 1 ), simple( 2 ), simple( 3 ), variation( 41, 4 ), variation( 42, 4 ), variation( 43, 4 ), variation( 51, 5 ) ];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', onProgress: ( done, total ) => progress.push( [ done, total ] ) } );

		expect( d.calls ).toEqual( [ 'variations:4:41,42', 'variations:4:43', 'variations:5:51', 'products:1,2', 'products:3' ] );
		expect( result.batchId ).toBe( 'batch-1' );
		expect( result.errors ).toEqual( [] );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 41, 42, 43, 51, 1, 2, 3 ] );
		expect( progress ).toEqual( [ [ 0, 7 ], [ 2, 7 ], [ 3, 7 ], [ 4, 7 ], [ 6, 7 ], [ 7, 7 ] ] );
		expect( d.batchProducts ).toHaveBeenCalledWith( [ { id: 1, status: 'draft' }, { id: 2, status: 'draft' } ], { batchId: 'batch-1', source: 'bulk' } );
	} );

	it( 'patches optimistically, then with the returned rows', async () => {
		const d = deps();
		await runSave( d, [ simple( 1, { status: 'publish' } ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'quick' } );

		const patches = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls.map( ( call ) => call[ 0 ] );

		expect( patches[ 0 ] ).toEqual( [ { id: 1, status: 'draft' } ] );
		expect( patches[ 1 ] ).toEqual( [ { id: 1, status: 'draft', echoed: true } ] );
	} );

	it( 'normalises returned rows through normalizeRow and keeps the row’s thumbnails', async () => {
		const normalizeRow = vi.fn( ( raw: { id: number }, parentId?: number ) => ( { ...raw, _kind: parentId ? 'variation' : 'product', _normalized: true } ) );
		const d = deps( {
			normalizeRow: normalizeRow as unknown as SaveDeps[ 'normalizeRow' ],
			batchProducts: vi.fn( async ( update: Update[] ) => ( { update: update.map( ( row ) => ( { ...row, images: [ { id: 9, src: 'full.jpg' } ] } ) ) } ) as BatchResponse< RawProduct > ),
			batchVariations: vi.fn( async ( _parentId: number, update: Update[] ) => ( { update: update.map( ( row ) => ( { ...row, image: { id: 9, src: 'full.jpg' } } ) ) } ) as BatchResponse< RawVariation > ),
		} );
		const result = await runSave( d, [ simple( 1, { status: 'publish' } ), variation( 41, 4 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( normalizeRow ).toHaveBeenCalledWith( expect.objectContaining( { id: 41 } ), 4 );
		expect( normalizeRow ).toHaveBeenCalledWith( expect.objectContaining( { id: 1 } ), undefined );

		const patches = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls.map( ( call ) => call[ 0 ] as Array< Record< string, unknown > > );
		const returned = patches.filter( ( patch ) => patch[ 0 ]?._normalized ).flat();

		expect( returned ).toHaveLength( 2 );
		expect( returned.every( ( row ) => ! ( 'images' in row ) && ! ( 'image' in row ) ) ).toBe( true );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 41, 1 ] );
	} );

	it( 'turns known wc/v3 error codes into human text', async () => {
		const d = deps( {
			batchProducts: vi.fn( async ( update: Update[] ) => ( { update: update.map( ( row ) => ( { id: row.id, error: { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' } } ) ) } ) as BatchResponse< RawProduct > ),
		} );
		const result = await runSave( d, [ simple( 1, { status: 'publish' } ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.errors ).toEqual( [ { id: 1, code: 'woocommerce_rest_product_invalid_id', message: expect.stringMatching( /no longer exists/ ) } ] );
	} );

	it( 'does not optimistically patch object-shaped keys (extension row data differs from its write shape)', async () => {
		const d = deps();
		await runSave( d, [ simple( 1, { i18n: { se: { name: { value: 'Old' } } } } ) ], { 'i18n:se.name': 'New', status: 'draft' }, fields, settings, { applyToVariations: false, source: 'quick' } );

		const first = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls[ 0 ]?.[ 0 ];

		expect( first ).toEqual( [ { id: 1, status: 'draft' } ] );
	} );

	it( 'reports per-item errors from the batch response and rolls those rows back', async () => {
		const d = deps( {
			batchProducts: vi.fn( async ( update: Update[] ) => ( {
				update: update.map( ( row ) => ( row.id === 2 ? { id: 2, error: { code: 'woocommerce_rest_invalid', message: 'Nope' } } : { ...row } ) ),
			} ) ),
		} );
		const result = await runSave( d, [ simple( 1, { status: 'publish' } ), simple( 2, { status: 'publish' } ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 1 ] );
		expect( result.errors ).toEqual( [ { id: 2, message: 'Nope', code: 'woocommerce_rest_invalid' } ] );

		const patches = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls.map( ( call ) => call[ 0 ] );

		// The saved row and the failed row's snapshot land in one patch.
		expect( patches.at( -1 ) ).toContainEqual( { id: 2, status: 'publish' } );
		expect( patches.at( -1 ) ).toHaveLength( 2 );
	} );

	it( 'a failed request fails every row of that chunk and continues with the next', async () => {
		const d = deps( {
			batchProducts: vi.fn( async ( update: Update[] ) => {
				if ( update.some( ( row ) => row.id === 1 ) ) {
					throw Object.assign( new Error( 'Server exploded' ), { code: 'rest_error' } );
				}

				return { update: update.map( ( row ) => ( { ...row } ) ) };
			} ),
		} );
		const result = await runSave( d, [ simple( 1 ), simple( 2 ), simple( 3 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.errors ).toEqual( [
			{ id: 1, message: 'Server exploded', code: 'rest_error' },
			{ id: 2, message: 'Server exploded', code: 'rest_error' },
		] );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 3 ] );
	} );

	it( 'a row the response forgot is an error', async () => {
		const d = deps( { batchProducts: vi.fn( async () => ( { update: [] } ) ) } );
		const result = await runSave( d, [ simple( 1 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'quick' } );

		expect( result.errors ).toMatchObject( [ { id: 1, code: 'missing_result' } ] );
	} );

	it( 'applies a scheduled sale to the variations of variable parents and the parents themselves get the rest', async () => {
		const d = deps( { batchSize: 50 } );
		const edits = { sale_price: { operation: 'decrease', value: '20', percent: true }, date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00', status: 'publish' };
		const result = await runSave( d, [ variable( 4, { status: 'draft' } ), simple( 1, { regular_price: '10', sale_price: '', status: 'draft' } ) ], edits, fields, settings, { applyToVariations: true, source: 'bulk' } );

		expect( d.calls ).toEqual( [ 'variations:4:41,42', 'products:4,1' ] );
		expect( d.batchVariations ).toHaveBeenCalledWith(
			4,
			[
				{ id: 41, date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00' },
				{ id: 42, date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00' },
			],
			{ batchId: 'batch-1', source: 'bulk' }
		);
		expect( d.batchProducts ).toHaveBeenCalledWith( [ { id: 4, status: 'publish' }, { id: 1, date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00', status: 'publish' } ], expect.anything() );
		expect( result.errors ).toEqual( [] );
	} );

	it( 'relative ops on the fetched variations use their own prices', async () => {
		const d = deps( { batchSize: 50 } );
		await runSave( d, [ variable( 4 ) ], { regular_price: { operation: 'decrease', value: '10', percent: true } }, fields, settings, { applyToVariations: true, source: 'bulk' } );

		expect( d.batchVariations ).toHaveBeenCalledWith( 4, [ { id: 41, regular_price: '90.00' }, { id: 42, regular_price: '45.00' } ], expect.anything() );
		expect( d.batchProducts ).not.toHaveBeenCalled();
	} );

	it( 'forwards the field list so the server trims the returned rows', async () => {
		const d = deps();
		const items = [ simple( 1, { regular_price: '100' } ), variation( 21, 2, { regular_price: '100' } ) ];

		await runSave( d, items, { regular_price: '110' }, fields, settings, { applyToVariations: false, source: 'bulk', fields: [ 'id', 'regular_price', 'price' ] } );

		expect( d.batchVariations ).toHaveBeenCalledWith( 2, expect.anything(), { batchId: 'batch-1', source: 'bulk', fields: [ 'id', 'regular_price', 'price' ] } );
		expect( d.batchProducts ).toHaveBeenCalledWith( expect.anything(), { batchId: 'batch-1', source: 'bulk', fields: [ 'id', 'regular_price', 'price' ] } );

		const bare = deps();
		await runSave( bare, [ simple( 1, { regular_price: '100' } ) ], { regular_price: '110' }, fields, settings, { applyToVariations: false, source: 'quick' } );
		expect( bare.batchProducts ).toHaveBeenCalledWith( expect.anything(), { batchId: 'batch-1', source: 'quick' } );
	} );

	it( 'returns an empty result without requests when nothing changes', async () => {
		const d = deps();
		const result = await runSave( d, [ simple( 1, { status: 'draft' } ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'quick' } );

		expect( result ).toMatchObject( { updated: [], errors: [], batchId: 'batch-1', unchanged: 1, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );
		expect( d.batchProducts ).not.toHaveBeenCalled();
	} );

	it( 'updated rows merge the original row with the returned object', async () => {
		const d = deps();
		const original = simple( 1, { name: 'Keep me' } );
		const result = await runSave( d, [ original ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'quick' } );
		const row = result.updated[ 0 ] as ProductListItem & { echoed?: boolean };

		expect( row.name ).toBe( 'Keep me' );
		expect( row.status ).toBe( 'draft' );
		expect( row.echoed ).toBe( true );
		expect( row._kind ).toBe( 'product' );
	} );
} );
