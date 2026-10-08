import { describe, expect, it } from 'vitest';
import { EMPTY_CHILDREN, flattenHierarchy, placeholderRow, projectedChildRows } from '../../resources/hierarchy/flatten';
import type { ChildrenState } from '../../resources/hierarchy/flatten';
import { normalizeProduct, normalizeVariation } from '../../resources/hierarchy/normalize';
import { getItemId } from '../../resources/types';
import type { ProductRow, VariationRow } from '../../resources/types';

function parent( id: number, count = 2 ): ProductRow {
	return normalizeProduct( {
		id,
		type: count > 0 ? 'variable' : 'simple',
		name: `P${ id }`,
		wc_products_list: { variation_count: count, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 },
	} );
}

function variations( parentId: number, ids: number[] ): VariationRow[] {
	return ids.map( ( id ) => normalizeVariation( { id, attributes: [ { id: 1, name: 'Size', option: String( id ) } ] }, parentId ) );
}

function loaded( parentId: number, ids: number[], total = ids.length ): ChildrenState {
	return { status: 'loaded', items: variations( parentId, ids ), total };
}

const ids = ( rows: ReturnType< typeof flattenHierarchy > ) => rows.map( getItemId );

describe( 'flattenHierarchy', () => {
	it( 'returns the parents in order when nothing is expanded', () => {
		const rows = flattenHierarchy( [ parent( 1 ), parent( 2, 0 ), parent( 3 ) ], new Set(), new Map(), 1000 );

		expect( ids( rows ) ).toEqual( [ '1', '2', '3' ] );
	} );

	it( 'splices loaded children at level 1 in server order under their parent', () => {
		const children = new Map( [ [ 1, loaded( 1, [ 13, 11, 12 ] ) ] ] );
		const rows = flattenHierarchy( [ parent( 1 ), parent( 2 ) ], new Set( [ 1 ] ), children, 1000 );

		expect( ids( rows ) ).toEqual( [ '1', '13', '11', '12', '2' ] );
		expect( rows[ 1 ] ).toMatchObject( { _level: 1, _parentId: 1, _kind: 'variation' } );
	} );

	it( 'ignores expanded ids of simple products and of parents not on the page', () => {
		const children = new Map( [ [ 2, loaded( 2, [ 21 ] ) ], [ 9, loaded( 9, [ 91 ] ) ] ] );
		const rows = flattenHierarchy( [ parent( 1 ), parent( 2, 0 ) ], new Set( [ 2, 9 ] ), children, 1000 );

		expect( ids( rows ) ).toEqual( [ '1', '2' ] );
	} );

	it( 'adds a loading placeholder while children are not loaded yet', () => {
		for ( const children of [ new Map(), new Map( [ [ 1, EMPTY_CHILDREN ] ] ), new Map( [ [ 1, { status: 'loading', items: [], total: 0 } as ChildrenState ] ] ) ] ) {
			const rows = flattenHierarchy( [ parent( 1 ), parent( 2 ) ], new Set( [ 1 ] ), children, 1000 );

			expect( ids( rows ) ).toEqual( [ '1', '1:loading', '2' ] );
			expect( rows[ 1 ] ).toMatchObject( { id: -1, _placeholder: 'loading', _parentId: 1, _level: 1, _placeholderMessage: 'Loading variations…' } );
		}
	} );

	it( 'shows the pages loaded so far followed by the loading placeholder', () => {
		const children = new Map( [ [ 1, { status: 'loading', items: variations( 1, [ 11, 12 ] ), total: 150 } as ChildrenState ] ] );
		const rows = flattenHierarchy( [ parent( 1 ) ], new Set( [ 1 ] ), children, 1000 );

		expect( ids( rows ) ).toEqual( [ '1', '11', '12', '1:loading' ] );
	} );

	it( 'adds an error placeholder with the message after any partial rows', () => {
		const children = new Map( [ [ 1, { status: 'error', items: variations( 1, [ 11 ] ), total: 5, error: 'Nope' } as ChildrenState ] ] );
		const rows = flattenHierarchy( [ parent( 1 ) ], new Set( [ 1 ] ), children, 1000 );

		expect( ids( rows ) ).toEqual( [ '1', '11', '1:error' ] );
		expect( rows[ 2 ] ).toMatchObject( { _placeholder: 'error', _placeholderMessage: 'Nope' } );

		const generic = flattenHierarchy( [ parent( 1 ) ], new Set( [ 1 ] ), new Map( [ [ 1, { status: 'error', items: [], total: 0 } as ChildrenState ] ] ), 1000 );

		expect( generic[ 1 ]?._placeholderMessage ).toBe( 'The variations could not be loaded.' );
	} );

	it( 'caps the children per parent and says how many are hidden', () => {
		const children = new Map( [ [ 1, loaded( 1, [ 11, 12, 13, 14 ], 10 ) ] ] );
		const rows = flattenHierarchy( [ parent( 1 ), parent( 2 ) ], new Set( [ 1 ] ), children, 2 );

		expect( ids( rows ) ).toEqual( [ '1', '11', '12', '1:more', '2' ] );
		expect( rows[ 3 ] ).toMatchObject( { _placeholder: 'more', _placeholderMessage: '8 more variations are not shown.' } );
	} );

	it( 'uses the singular for one hidden row and nothing when everything fits', () => {
		const one = flattenHierarchy( [ parent( 1 ) ], new Set( [ 1 ] ), new Map( [ [ 1, loaded( 1, [ 11, 12 ], 3 ) ] ] ), 1000 );

		expect( one[ 3 ]?._placeholderMessage ).toBe( '1 more variation is not shown.' );

		const all = flattenHierarchy( [ parent( 1 ) ], new Set( [ 1 ] ), new Map( [ [ 1, loaded( 1, [ 11, 12 ] ) ] ] ), 1000 );

		expect( ids( all ) ).toEqual( [ '1', '11', '12' ] );
	} );

	it( 'treats a non-positive cap as unlimited', () => {
		const rows = flattenHierarchy( [ parent( 1 ) ], new Set( [ 1 ] ), new Map( [ [ 1, loaded( 1, [ 11, 12, 13 ] ) ] ] ), 0 );

		expect( ids( rows ) ).toEqual( [ '1', '11', '12', '13' ] );
	} );

	it( 'is pure: does not touch its inputs and is stable for equal inputs', () => {
		const parents = [ parent( 1 ) ];
		const children = new Map( [ [ 1, loaded( 1, [ 11 ] ) ] ] );
		const expanded = new Set( [ 1 ] );
		const snapshot = JSON.stringify( [ parents, Array.from( children ), Array.from( expanded ) ] );

		const a = flattenHierarchy( parents, expanded, children, 1000 );
		const b = flattenHierarchy( parents, expanded, children, 1000 );

		expect( a ).toEqual( b );
		expect( JSON.stringify( [ parents, Array.from( children ), Array.from( expanded ) ] ) ).toBe( snapshot );
	} );

	it( 'handles 1000 parents with 100 children each quickly', () => {
		const parents = Array.from( { length: 1000 }, ( _, i ) => parent( i + 1, 100 ) );
		const children = new Map( parents.map( ( p ) => [ p.id, loaded( p.id, Array.from( { length: 100 }, ( _, j ) => p.id * 1000 + j ) ) ] ) );
		const start = performance.now();
		const rows = flattenHierarchy( parents, new Set( parents.map( ( p ) => p.id ) ), children, 1000 );

		expect( rows ).toHaveLength( 101000 );
		expect( performance.now() - start ).toBeLessThan( 200 );
	} );
} );

describe( 'placeholderRow', () => {
	it( 'uses the negated parent id and a composite item id', () => {
		const row = placeholderRow( 42, 'more', 'x' );

		expect( row.id ).toBe( -42 );
		expect( getItemId( row ) ).toBe( '42:more' );
		expect( row._kind ).toBe( 'variation' );
	} );
} );

describe( 'projectedChildRows', () => {
	it( 'sums counts, preferring loaded totals, capped per parent', () => {
		const children = new Map( [ [ 1, loaded( 1, [ 11 ], 7 ) ] ] );

		expect( projectedChildRows( [ parent( 1, 2 ), parent( 2, 50 ), parent( 3, 0 ) ], children, 10 ) ).toBe( 7 + 10 );
	} );
} );
