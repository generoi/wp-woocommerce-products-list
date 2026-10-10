import { describe, expect, it, vi } from 'vitest';
import { payloadStored, prepareSave, runConcurrently, runSave, UNCERTAIN_CODE } from '../../resources/edit/save-runner';
import type { SaveDeps } from '../../resources/edit/save-runner';
import type { BatchResponse, ProductListItem, RawProduct, RawVariation } from '../../resources/types';
import { coreFields, editSettings, simple, variable, variation } from './edit-fixtures';

const settings = editSettings();
const fields = coreFields();

type Update = { id: number } & Record< string, unknown >;

function deps( overrides: Partial< SaveDeps > = {} ): SaveDeps & { calls: string[] } {
	const calls: string[] = [];
	// The server never returns the expected values (`_wcpl_expect`) it was sent.
	const echo = < T extends { id: number } >( update: T[] ) => ( { update: update.map( ( { _wcpl_expect: _expect, ...row }: T & { _wcpl_expect?: unknown } ) => ( { ...row, echoed: true } ) ) } );

	return {
		calls,
		batchProducts: vi.fn( async ( update: Update[] ) => {
			calls.push( `products:${ update.map( ( row ) => row.id ).join( ',' ) }` );

			return echo( update ) as unknown as BatchResponse< RawProduct >;
		} ),
		batchVariations: vi.fn( async ( parentId: number, update: Update[] ) => {
			calls.push( `variations:${ parentId }:${ update.map( ( row ) => row.id ).join( ',' ) }` );

			return echo( update ) as unknown as BatchResponse< RawVariation >;
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

			return { update: update.map( ( { parent_id: _parent, _wcpl_expect: _expect, ...row } ) => ( { ...row, echoed: true } ) ) } as BatchResponse< RawVariation >;
		} );
		d.batchVariationsAcross = across;
		const progress: Array< [ number, number ] > = [];
		const items = [ simple( 1 ), variation( 41, 4 ), variation( 51, 5 ), variation( 42, 4 ), variation( 61, 6 ) ];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', onProgress: ( done, total ) => progress.push( [ done, total ] ) } );

		// Grouped by parent, chunked by the cross-parent size, parents after.
		expect( d.calls ).toEqual( [ 'across:4/41,4/42,5/51', 'across:6/61', 'products:1' ] );
		expect( d.batchVariations ).not.toHaveBeenCalled();
		expect( across ).toHaveBeenCalledWith( [ { id: 41, parent_id: 4, status: 'draft', _wcpl_expect: { status: 'publish' } }, { id: 42, parent_id: 4, status: 'draft', _wcpl_expect: { status: 'publish' } }, { id: 51, parent_id: 5, status: 'draft', _wcpl_expect: { status: 'publish' } } ], { batchId: 'batch-1', source: 'bulk' } );
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
		const d = deps( { concurrency: 1 } );
		const progress: Array< [ number, number ] > = [];
		const items = [ simple( 1 ), simple( 2 ), simple( 3 ), variation( 41, 4 ), variation( 42, 4 ), variation( 43, 4 ), variation( 51, 5 ) ];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', onProgress: ( done, total ) => progress.push( [ done, total ] ) } );

		expect( d.calls ).toEqual( [ 'variations:4:41,42', 'variations:4:43', 'variations:5:51', 'products:1,2', 'products:3' ] );
		expect( result.batchId ).toBe( 'batch-1' );
		expect( result.errors ).toEqual( [] );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 41, 42, 43, 51, 1, 2, 3 ] );
		expect( progress ).toEqual( [ [ 0, 7 ], [ 2, 7 ], [ 3, 7 ], [ 4, 7 ], [ 6, 7 ], [ 7, 7 ] ] );
		expect( d.batchProducts ).toHaveBeenCalledWith( [ { id: 1, status: 'draft', _wcpl_expect: { status: 'publish' } }, { id: 2, status: 'draft', _wcpl_expect: { status: 'publish' } } ], { batchId: 'batch-1', source: 'bulk' } );
	} );

	it( 'sends product chunks side by side, cut so every slot has work, and shows every row at once', async () => {
		let inFlight = 0;
		let peak = 0;
		const d = deps( {
			batchSize: 50,
			batchProducts: vi.fn( async ( update: Update[] ) => {
				inFlight += 1;
				peak = Math.max( peak, inFlight );
				await new Promise( ( resolve ) => setTimeout( resolve, 5 ) );
				inFlight -= 1;

				return { update: update.map( ( row ) => ( { ...row } ) ) } as BatchResponse< RawProduct >;
			} ),
		} );
		const items = Array.from( { length: 100 }, ( _, index ) => simple( index + 1, { status: 'publish' } ) );
		const progress: Array< [ number, number ] > = [];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', onProgress: ( done, total ) => progress.push( [ done, total ] ) } );

		const sizes = ( d.batchProducts as ReturnType< typeof vi.fn > ).mock.calls.map( ( call ) => ( call[ 0 ] as Update[] ).length );

		expect( sizes ).toEqual( [ 34, 34, 32 ] );
		expect( peak ).toBe( 3 );
		expect( result.updated ).toHaveLength( 100 );
		expect( progress.at( -1 ) ).toEqual( [ 100, 100 ] );
		// The first patch is the optimistic one for all 100 rows.
		expect( ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls[ 0 ]?.[ 0 ] ).toHaveLength( 100 );
	} );

	it( 'sends a lane\'s next request before the list re-renders with the previous response', async () => {
		const events: string[] = [];
		const d = deps( {
			variationsBatchSize: 1,
			patchItems: vi.fn( ( patches: Array< { id: number; echoed?: boolean } > ) => {
				events.push( `${ patches.some( ( patch ) => patch.echoed ) ? 'returned' : 'optimistic' }:${ patches.map( ( patch ) => patch.id ).join( ',' ) }` );
			} ),
		} );

		d.batchVariationsAcross = vi.fn( async ( update: Array< Update & { parent_id: number } > ) => {
			events.push( `request:${ update.map( ( row ) => row.id ).join( ',' ) }` );

			return { update: update.map( ( { parent_id: _parent, ...row } ) => ( { ...row, echoed: true } ) ) } as BatchResponse< RawVariation >;
		} );

		// One parent with more rows than a request takes: a lane of requests one after the other.
		const result = await runSave( d, [ variation( 41, 4 ), variation( 42, 4 ), variation( 43, 4 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		// The optimistic render waits for the next task (after the first request went out); the responses land in one write at the end.
		expect( events ).toEqual( [ 'request:41', 'request:42', 'request:43', 'optimistic:41,42,43', 'returned:41,42,43' ] );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 41, 42, 43 ] );
	} );

	it( 'dispatches the requests before the optimistic render, and writes all responses to the cache once', async () => {
		const events: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise< void >( ( resolve ) => {
			release = resolve;
		} );
		const d = deps( {
			batchSize: 100,
			patchItems: vi.fn( ( patches: Array< { id: number; echoed?: boolean } > ) => {
				events.push( `${ patches.some( ( patch ) => patch.echoed ) ? 'returned' : 'optimistic' }:${ patches.length }` );
			} ),
		} );

		d.batchProducts = vi.fn( async ( update: Update[] ) => {
			events.push( `request:${ update.length }` );
			await gate;

			return { update: update.map( ( row ) => ( { ...row, echoed: true } ) ) } as BatchResponse< RawProduct >;
		} );

		const rows = Array.from( { length: 9 }, ( _, index ) => simple( 100 + index, { status: 'publish' } ) );
		const pending = runSave( d, rows, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		// Three requests (9 rows, 3 at a time) are out before any render.
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		expect( events.slice( 0, 3 ) ).toEqual( [ 'request:3', 'request:3', 'request:3' ] );
		expect( events ).toContain( 'optimistic:9' );

		release();
		await pending;

		expect( events.filter( ( event ) => event.startsWith( 'returned' ) ) ).toEqual( [ 'returned:9' ] );
	} );

	it( 'reports a row as updated when the request failed but the re-read shows it was stored', async () => {
		const d = deps( { batchSize: 100 } );
		const stored = simple( 1, { regular_price: '11.00', date_modified_gmt: '2026-10-09T10:00:01' } );

		d.batchProducts = vi.fn( async () => {
			throw Object.assign( new Error( 'Gateway Timeout' ), { code: 'http_error', status: 504 } );
		} );
		d.rereadRows = vi.fn( async () => new Map( [ [ 1, stored ], [ 2, simple( 2, { regular_price: '20', date_modified_gmt: '2026-10-09T09:00:00' } ) ] ] ) );

		const result = await runSave(
			d,
			[ simple( 1, { regular_price: '10', date_modified_gmt: '2026-10-09T09:00:00' } ), simple( 2, { regular_price: '20', date_modified_gmt: '2026-10-09T09:00:00' } ) ],
			{ regular_price: { operation: 'increase', value: '10', percent: true } },
			fields,
			settings,
			{ applyToVariations: false, source: 'bulk' }
		);

		expect( d.rereadRows ).toHaveBeenCalledTimes( 1 );
		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 1 ] );
		// Row 2 holds its old price and was not touched: a plain failure, safe to retry.
		expect( result.errors ).toEqual( [ expect.objectContaining( { id: 2, code: 'http_error' } ) ] );
		// The rows show what is stored, not the pre-save snapshot.
		const last = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls.at( -1 )?.[ 0 ] as Array< Record< string, unknown > >;

		expect( last.find( ( patch ) => patch.id === 1 )?.regular_price ).toBe( '11.00' );
	} );

	it( 'marks rows uncertain when the re-read fails too, and never re-reads after a 4xx', async () => {
		const d = deps( { batchSize: 100 } );

		d.batchProducts = vi.fn( async () => {
			throw Object.assign( new Error( 'Network down' ), { code: 'fetch_error', status: 0 } );
		} );
		d.rereadRows = vi.fn( async () => {
			throw new Error( 'still down' );
		} );

		const result = await runSave( d, [ simple( 1, { regular_price: '10' } ) ], { regular_price: { operation: 'increase', value: '1' } }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.errors ).toEqual( [ expect.objectContaining( { id: 1, code: UNCERTAIN_CODE } ) ] );

		const refused = deps( { batchSize: 100 } );

		refused.batchProducts = vi.fn( async () => {
			throw Object.assign( new Error( 'Bad request' ), { code: 'rest_invalid_param', status: 400 } );
		} );
		refused.rereadRows = vi.fn( async () => new Map() );

		const second = await runSave( refused, [ simple( 1, { regular_price: '10' } ) ], { regular_price: { operation: 'increase', value: '1' } }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( refused.rereadRows ).not.toHaveBeenCalled();
		expect( second.errors[ 0 ]?.code ).toBe( 'rest_invalid_param' );
	} );

	it( 'a save of several rows sends its planned count and closes its batch before it returns; one row does not', async () => {
		const closed: string[] = [];
		const d = deps( { concurrency: 1, closeBatch: vi.fn( async ( id: string ) => void closed.push( id ) ) } );

		d.batchProducts = vi.fn( async ( update: Update[], options ) => {
			expect( closed ).toEqual( [] );

			return { update: update.map( ( { _wcpl_expect: _expect, ...row } ) => ( { ...row, planned: options.planned } ) ) } as BatchResponse< RawProduct >;
		} );

		const result = await runSave( d, [ simple( 1 ), simple( 2 ), simple( 3 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( ( d.batchProducts as ReturnType< typeof vi.fn > ).mock.calls.every( ( call ) => call[ 1 ].planned === 3 ) ).toBe( true );
		expect( closed ).toEqual( [ 'batch-1' ] );
		expect( result.updated ).toHaveLength( 3 );

		const single = deps( { closeBatch: vi.fn( async () => {} ) } );

		await runSave( single, [ simple( 1 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'quick' } );

		expect( ( single.batchProducts as ReturnType< typeof vi.fn > ).mock.calls[ 0 ]?.[ 1 ] ).toEqual( { batchId: 'batch-1', source: 'quick' } );
		expect( single.closeBatch ).not.toHaveBeenCalled();
	} );

	it( 'leaves a shared batch open for the caller: planned with the writes that follow, on one row too, and never closed here', async () => {
		const d = deps( { closeBatch: vi.fn( async () => {} ) } );

		await runSave( d, [ simple( 1 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', batchId: 'shared-1', keepBatchOpen: true, plannedExtra: 4 } );

		expect( ( d.batchProducts as ReturnType< typeof vi.fn > ).mock.calls[ 0 ]?.[ 1 ] ).toEqual( { batchId: 'shared-1', source: 'bulk', planned: 5 } );
		expect( d.closeBatch ).not.toHaveBeenCalled();

		const many = deps( { closeBatch: vi.fn( async () => {} ) } );

		await runSave( many, [ simple( 1 ), simple( 2 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk', batchId: 'shared-2', keepBatchOpen: true } );

		expect( ( many.batchProducts as ReturnType< typeof vi.fn > ).mock.calls[ 0 ]?.[ 1 ] ).toMatchObject( { batchId: 'shared-2', planned: 2 } );
		expect( many.closeBatch ).not.toHaveBeenCalled();
	} );

	it( 'closes the batch when a request throws too', async () => {
		const d = deps( { closeBatch: vi.fn( async () => {} ), batchProducts: vi.fn( async () => { throw Object.assign( new Error( 'Nope' ), { code: 'rest_invalid_param', status: 400 } ); } ) } );
		const result = await runSave( d, [ simple( 1 ), simple( 2 ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.errors ).toHaveLength( 2 );
		expect( d.closeBatch ).toHaveBeenCalledWith( 'batch-1' );
	} );

	it( 'sends the loaded values of the changed fields as _wcpl_expect (term ids, single meta), never for a stock delta', async () => {
		const d = deps( { batchSize: 10 } );
		const row = simple( 1, {
			regular_price: '10',
			stock_quantity: 5,
			manage_stock: true,
			categories: [ { id: 3, name: 'A', slug: 'a' } ],
			meta_data: [ { id: 1, key: 'color', value: 'red' } ],
		} );
		const payloadOf = async ( edits: Record< string, unknown >, extra: Record< string, unknown > = {} ) => {
			const prepared = await prepareSave( d, [ { ...row, ...extra } as ProductListItem ], edits, fields, settings, { applyToVariations: false } );

			return prepared[ 0 ]!;
		};
		const { writeItem } = await import( '../../resources/edit/expect' );

		const price = await payloadOf( { regular_price: '12' } );
		expect( writeItem( price.target.item, price.payload ) ).toEqual( { id: 1, regular_price: '12', _wcpl_expect: { regular_price: '10' } } );

		expect( writeItem( row, { categories: [ { id: 4 } ], meta_data: [ { key: 'color', value: 'blue' }, { key: 'unknown', value: 'x' } ] } ) ).toEqual( {
			id: 1,
			categories: [ { id: 4 } ],
			meta_data: [ { key: 'color', value: 'blue' }, { key: 'unknown', value: 'x' } ],
			// A key the loaded list lacks was shown empty: expected empty, so a value set meanwhile is refused.
			_wcpl_expect: { categories: [ { id: 3 } ], 'meta_data.color': 'red', 'meta_data.unknown': null },
		} );

		// inventory_delta is applied to the stock as stored: an order meanwhile is not a conflict.
		expect( writeItem( row, { inventory_delta: 2 } ) ).toEqual( { id: 1, inventory_delta: 2 } );
	} );

	it( 'shows the stored values of rows the server refused as changed meanwhile', async () => {
		const d = deps( {
			batchProducts: vi.fn( async ( update: Update[] ) => ( {
				update: update.map( ( row ) => ( { id: row.id, error: { code: 'wc_products_list_conflict', message: 'Changed', data: { status: 409 } } } ) ),
			} ) ) as unknown as SaveDeps[ 'batchProducts' ],
			rereadRows: vi.fn( async () => new Map( [ [ 1, simple( 1, { regular_price: '15' } ) ] ] ) ),
		} );
		const result = await runSave( d, [ simple( 1, { regular_price: '10' } ) ], { regular_price: '12' }, fields, settings, { applyToVariations: false, source: 'quick' } );

		expect( result.errors ).toEqual( [ expect.objectContaining( { id: 1, code: 'wc_products_list_conflict', message: expect.stringMatching( /someone else/ ) } ) ] );
		expect( d.rereadRows ).toHaveBeenCalledTimes( 1 );

		const last = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls.at( -1 )?.[ 0 ] as Array< Record< string, unknown > >;

		expect( last.at( -1 ) ).toMatchObject( { id: 1, regular_price: '15' } );
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

	it( 'leaves the thumbnails out of the saved rows of variations fetched for a parent\'s "all its variations"', async () => {
		// The fetched variations carry trimmed fields; normalised they hold `images: []`, which the
		// hierarchy (the `saved` action) would show as the parent's image over the variation's own.
		const d = deps( {
			fetchVariations: vi.fn( async ( parentId: number ) => [ { ...variation( parentId * 10 + 1, parentId, { regular_price: '100' } ), images: [] } ] ),
		} );
		const result = await runSave( d, [ variable( 4 ) ], { regular_price: '90' }, fields, settings, { applyToVariations: true, source: 'quick' } );

		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 41 ] );
		expect( result.updated.every( ( row ) => ! ( 'images' in row ) && ! ( 'image' in row ) ) ).toBe( true );
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
			concurrency: 1,
			batchProducts: vi.fn( async ( update: Update[] ) => ( {
				update: update.map( ( row ) => ( row.id === 2 ? { id: 2, error: { code: 'woocommerce_rest_invalid', message: 'Nope' } } : { ...row } ) ),
			} ) ),
		} );
		const result = await runSave( d, [ simple( 1, { status: 'publish' } ), simple( 2, { status: 'publish' } ) ], { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( result.updated.map( ( row ) => row.id ) ).toEqual( [ 1 ] );
		// The server logged the item's error row itself (Recorder): the editor does not post it again.
		expect( result.errors ).toEqual( [ { id: 2, message: 'Nope', code: 'woocommerce_rest_invalid', logged: true } ] );

		const patches = ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls.map( ( call ) => call[ 0 ] );

		// The saved row and the failed row's snapshot land in one patch.
		expect( patches.at( -1 ) ).toContainEqual( { id: 2, status: 'publish' } );
		expect( patches.at( -1 ) ).toHaveLength( 2 );
	} );

	it( 'marks a refused duplicate SKU as logged by the server, so History gets one error row, not two', async () => {
		const message = 'The SKU "S-3" is already used by "Other" (#3).';
		const d = deps( {
			concurrency: 1,
			batchProducts: vi.fn( async ( update: Update[] ) => ( { update: update.map( ( row ) => ( { id: row.id, error: { code: 'product_invalid_sku', message, data: { status: 400 } } } ) ) } ) ),
		} );
		const result = await runSave( d, [ simple( 4, { sku: 'S-4' } ) ], { sku: 'S-3' }, coreFields(), settings, { applyToVariations: false, source: 'quick' } );

		expect( result.errors ).toEqual( [ { id: 4, message, code: 'product_invalid_sku', logged: true } ] );
	} );

	it( 'a failed request fails every row of that chunk and continues with the next', async () => {
		const d = deps( {
			concurrency: 1,
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
		const d = deps( { batchSize: 50, concurrency: 1 } );
		const edits = { sale_price: { operation: 'decrease', value: '20', percent: true }, date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00', status: 'publish' };
		const result = await runSave( d, [ variable( 4, { status: 'draft' } ), simple( 1, { regular_price: '10', sale_price: '', status: 'draft' } ) ], edits, fields, settings, { applyToVariations: true, source: 'bulk' } );

		expect( d.calls ).toEqual( [ 'variations:4:41,42', 'products:4,1' ] );
		expect( d.batchVariations ).toHaveBeenCalledWith(
			4,
			[
				// Not on sale yet: "Decrease by 20 %" starts from their regular price (100 and 50).
				{ id: 41, sale_price: '80.00', date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00', _wcpl_expect: { sale_price: '' } },
				{ id: 42, sale_price: '40.00', date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00', _wcpl_expect: { sale_price: '' } },
			],
			{ batchId: 'batch-1', source: 'bulk' }
		);
		expect( d.batchProducts ).toHaveBeenCalledWith(
			[
				{ id: 4, status: 'publish', _wcpl_expect: { status: 'draft' } },
				{ id: 1, sale_price: '8.00', date_on_sale_from: '2026-11-01T00:00:00', date_on_sale_to: '2026-11-30T00:00:00', status: 'publish', _wcpl_expect: { sale_price: '', status: 'draft' } },
			],
			expect.anything()
		);
		expect( result.errors ).toEqual( [] );
	} );

	it( 'relative ops on the fetched variations use their own prices', async () => {
		const d = deps( { batchSize: 50 } );
		await runSave( d, [ variable( 4 ) ], { regular_price: { operation: 'decrease', value: '10', percent: true } }, fields, settings, { applyToVariations: true, source: 'bulk' } );

		expect( d.batchVariations ).toHaveBeenCalledWith( 4, [ { id: 41, regular_price: '90.00', _wcpl_expect: { regular_price: '100' } }, { id: 42, regular_price: '45.00', _wcpl_expect: { regular_price: '50' } } ], expect.anything() );
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

describe( 'runSave concurrency', () => {
	it( 'sends the cross-parent variation chunks a few at a time, every row patched optimistically up front, parents after all of them', async () => {
		const d = deps( { variationsBatchSize: 1, concurrency: 2 } );
		let inFlight = 0;
		let peak = 0;
		const across = vi.fn( async ( update: Array< Update & { parent_id: number } > ) => {
			inFlight += 1;
			peak = Math.max( peak, inFlight );
			await new Promise( ( resolve ) => setTimeout( resolve, 5 ) );
			inFlight -= 1;
			d.calls.push( `across:${ update.map( ( row ) => row.id ).join( ',' ) }` );

			return { update: update.map( ( { parent_id: _parent, ...row } ) => row ) } as BatchResponse< RawVariation >;
		} );
		d.batchVariationsAcross = across;
		const items = [ variation( 41, 4 ), variation( 42, 4 ), variation( 51, 5 ), variation( 61, 6 ), simple( 1 ) ];
		const result = await runSave( d, items, { status: 'draft' }, fields, settings, { applyToVariations: false, source: 'bulk' } );

		expect( peak ).toBe( 2 );
		expect( across ).toHaveBeenCalledTimes( 4 );
		expect( d.calls[ d.calls.length - 1 ] ).toBe( 'products:1' );
		expect( result.updated.map( ( row ) => row.id ).sort() ).toEqual( [ 1, 41, 42, 51, 61 ] );
		expect( result.errors ).toEqual( [] );
		// The first patch carries all four variations at once.
		expect( ( d.patchItems as ReturnType< typeof vi.fn > ).mock.calls[ 0 ]?.[ 0 ] ).toHaveLength( 4 );
	} );

	it( 'runConcurrently keeps order of start and bounds what is in flight', async () => {
		const order: number[] = [];
		await runConcurrently(
			[ 1, 2, 3 ].map( ( n ) => async () => {
				order.push( n );
				await Promise.resolve();
			} ),
			1
		);
		expect( order ).toEqual( [ 1, 2, 3 ] );
	} );
} );

describe( 'payloadStored', () => {
	it( 'compares prices as numbers, nested objects leaf by leaf and terms by id', () => {
		expect( payloadStored( { regular_price: '21.90' }, { regular_price: '21.9' } ) ).toBe( true );
		expect( payloadStored( { regular_price: '20' }, { regular_price: '21.9' } ) ).toBe( false );
		expect( payloadStored( { i18n: { se: { name: 'Saga', slug: 'saga' } } }, { i18n: { se: { name: 'Saga' } } } ) ).toBe( true );
		expect( payloadStored( { categories: [ { id: 2 }, { id: 1 } ] }, { categories: [ { id: 1 }, { id: 2 } ] } ) ).toBe( true );
		expect( payloadStored( { sale_price: '' }, { sale_price: '' } ) ).toBe( true );
		expect( payloadStored( { stock_quantity: 4 }, { inventory_delta: -1 } ) ).toBeNull();
	} );
} );
