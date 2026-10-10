import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateSelection, recheckBases } from '../../resources/edit/hydrate';
import type { HydrateDeps } from '../../resources/edit/hydrate';
import { acrossSupported, getVariationsByIds, getVariationsOfParents, resetAcrossSupport, setAcrossFetch } from '../../resources/edit/variations-read';
import type { RawVariation } from '../../resources/types';
import { simple, variable, variation } from './edit-fixtures';

afterEach( () => {
	setAcrossFetch( null );
	resetAcrossSupport();
} );

function listDeps( stamps: Record< number, string > = {}, statuses: Record< number, string > = {} ) {
	return vi.fn( async ( query: Record< string, unknown > ) => ( {
		items: String( query.include )
			.split( ',' )
			.map( Number )
			.filter( ( id ) => statuses[ id ] !== 'deleted' )
			.map( ( id ) => simple( id, { status: statuses[ id ] ?? 'publish', ...( stamps[ id ] ? { date_modified_gmt: stamps[ id ] } : {} ) } ) ),
		total: 0,
		totalPages: 1,
	} ) );
}

describe( 'hydrateSelection across parents', () => {
	it( 'reads the variations of many parents in one cross-parent request, not one per parent', async () => {
		const getVariations = vi.fn();
		const getVariationsByIds = vi.fn( async ( ids: number[], parentOf: ReadonlyMap< number, number > ) => ids.map( ( id ) => variation( id, parentOf.get( id )!, { regular_price: '9' } ) ) );
		const deps = { listProducts: listDeps( { 1: 'p1', 2: 'p2' } ), getVariations, getVariationsByIds } as unknown as HydrateDeps;
		const rows = [ variation( 11, 1 ), variation( 12, 1 ), variation( 21, 2 ) ];

		const result = await hydrateSelection( rows, [ 'id', 'regular_price', 'date_modified_gmt' ], deps );

		expect( getVariations ).not.toHaveBeenCalled();
		expect( getVariationsByIds ).toHaveBeenCalledTimes( 1 );
		expect( result.items.map( ( row ) => ( row as { regular_price?: string } ).regular_price ) ).toEqual( [ '9', '9', '9' ] );
		// The parents' stamps come along (one light request), the baseline of the pre-save check.
		expect( Array.from( result.parentStamps ) ).toEqual( [
			[ 1, 'p1' ],
			[ 2, 'p2' ],
		] );
	} );

	it( 'falls back to one read per parent when the server has no cross-parent route', async () => {
		const getVariations = vi.fn( async ( parentId: number, _page: number, options: { params?: Record< string, unknown > } ) => ( {
			items: String( options.params?.include )
				.split( ',' )
				.map( ( id ) => variation( Number( id ), parentId, { regular_price: '7' } ) ),
			total: 0,
			totalPages: 1,
		} ) );
		const deps = { listProducts: listDeps(), getVariations, getVariationsByIds: vi.fn( async () => null ) } as unknown as HydrateDeps;

		const result = await hydrateSelection( [ variation( 11, 1 ), variation( 21, 2 ) ], [ 'id', 'regular_price' ], deps );

		expect( getVariations ).toHaveBeenCalledTimes( 2 );
		expect( result.missing ).toEqual( [] );
	} );
} );

describe( 'hydrateSelection image size', () => {
	it( 'asks for the list\'s thumbnail size, so a re-read merged over a list row keeps its 150 px image', async () => {
		const listProducts = listDeps();
		const fetcher = vi.fn( async ( query: Record< string, string | number > ) => ( { items: String( query.include ).split( ',' ).map( ( id ) => ( { id: Number( id ), parent_id: 1 } ) as unknown as RawVariation ), totalPages: 1 } ) );

		setAcrossFetch( fetcher );

		await hydrateSelection( [ simple( 5 ), variation( 11, 1 ) ], [ 'id', 'images', 'image' ], { listProducts, getVariations: vi.fn(), getVariationsByIds } as unknown as HydrateDeps );
		await getVariationsOfParents( [ 1 ], { fields: [ 'image' ] } );

		expect( listProducts.mock.calls[ 0 ]?.[ 0 ] ).toMatchObject( { include: '5', image_size: 'thumbnail' } );
		expect( fetcher.mock.calls.map( ( call ) => call[ 0 ].image_size ) ).toEqual( [ 'thumbnail', 'thumbnail' ] );
	} );
} );

describe( 'recheckBases', () => {
	it( 'checks products and the parents of variations in one light request, without reading variations', async () => {
		const listProducts = listDeps( { 1: 'new', 2: 'same', 5: 'moved' }, { 3: 'trash', 4: 'deleted' } );
		const rows = [
			simple( 1, { date_modified_gmt: 'old' } ),
			simple( 2, { date_modified_gmt: 'same' } ),
			simple( 3, { date_modified_gmt: 'x' } ),
			simple( 4, { date_modified_gmt: 'x' } ),
			variation( 51, 5 ),
			variation( 61, 6 ),
		];

		const check = await recheckBases( rows, new Map( [ [ 5, 'before' ] ] ), { listProducts } as unknown as HydrateDeps );

		expect( listProducts ).toHaveBeenCalledTimes( 1 );
		expect( String( listProducts.mock.calls[ 0 ]?.[ 0 ]?._fields ) ).toBe( 'id,status,date_modified_gmt' );
		expect( check.trashed ).toEqual( [ 3 ] );
		expect( check.missing ).toEqual( [ 4 ] );
		// 1 changed; 51's parent moved since its baseline; 61's parent baseline is unknown: never reported.
		expect( check.stale.map( ( row ) => row.id ) ).toEqual( [ 1, 51 ] );
	} );

	it( 'compares a selected variable parent with its own stamp', async () => {
		const check = await recheckBases( [ variable( 7, { date_modified_gmt: 'a' } ) ], new Map(), { listProducts: listDeps( { 7: 'a' } ) } as unknown as HydrateDeps );

		expect( check.stale ).toEqual( [] );
	} );
} );

describe( 'variations-read', () => {
	const raw = ( id: number, parent: number ) => ( { id, parent_id: parent, regular_price: '1' } ) as unknown as RawVariation;

	it( 'reads ids in chunks of 100 under the parent the list knows', async () => {
		const fetcher = vi.fn( async ( query: Record< string, string | number > ) => ( { items: String( query.include ).split( ',' ).map( ( id ) => raw( Number( id ), 9 ) ), totalPages: 1 } ) );

		setAcrossFetch( fetcher );

		const ids = Array.from( { length: 150 }, ( _, index ) => 1000 + index );
		const rows = await getVariationsByIds( ids, new Map( [ [ 1000, 3 ] ] ), { fields: [ 'regular_price' ] } );

		expect( fetcher ).toHaveBeenCalledTimes( 2 );
		expect( String( fetcher.mock.calls[ 0 ]?.[ 0 ]._fields ) ).toContain( 'parent_id' );
		expect( rows ).toHaveLength( 150 );
		expect( rows![ 0 ]!._parentId ).toBe( 3 );
		expect( rows![ 1 ]!._parentId ).toBe( 9 );
		expect( acrossSupported() ).toBe( true );
	} );

	it( 'passes the edit context on to every chunk, and none by default', async () => {
		const fetcher = vi.fn( async ( query: Record< string, string | number > ) => ( { items: String( query.include ).split( ',' ).map( ( id ) => raw( Number( id ), 9 ) ), totalPages: 1 } ) );

		setAcrossFetch( fetcher );

		const ids = Array.from( { length: 150 }, ( _, index ) => 1000 + index );

		await getVariationsByIds( ids, new Map(), { fields: [ 'description' ], context: 'edit' } );
		await getVariationsByIds( [ 1 ], new Map(), { fields: [ 'regular_price' ] } );

		expect( fetcher.mock.calls.map( ( call ) => call[ 0 ].context ) ).toEqual( [ 'edit', 'edit', undefined ] );
	} );

	it( 'remembers a server without the route and answers null from then on', async () => {
		const fetcher = vi.fn( async () => {
			throw Object.assign( new Error( 'No route' ), { code: 'rest_no_route', status: 404 } );
		} );

		setAcrossFetch( fetcher );

		expect( await getVariationsByIds( [ 1 ], new Map(), { fields: [] } ) ).toBeNull();
		expect( await getVariationsOfParents( [ 1 ], { fields: [] } ) ).toBeNull();
		expect( fetcher ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'pages through every variation of the parents and groups them by parent', async () => {
		const fetcher = vi.fn( async ( query: Record< string, string | number > ) => ( {
			items: Number( query.page ) === 1 ? [ raw( 11, 1 ), raw( 21, 2 ) ] : [ raw( 12, 1 ) ],
			totalPages: 2,
		} ) );

		setAcrossFetch( fetcher );

		const byParent = await getVariationsOfParents( [ 1, 2, 3 ], { fields: [ 'regular_price' ] } );

		expect( fetcher ).toHaveBeenCalledTimes( 2 );
		expect( byParent!.get( 1 )!.map( ( row ) => row.id ) ).toEqual( [ 11, 12 ] );
		expect( byParent!.get( 2 )!.map( ( row ) => row.id ) ).toEqual( [ 21 ] );
		expect( byParent!.get( 3 ) ).toEqual( [] );
	} );
} );
