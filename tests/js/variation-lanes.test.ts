/**
 * A parent's variations never go out in two requests at the same time: the
 * server syncs the parent's price and stock once per request, and two
 * parallel syncs would race on half-written variations.
 */
import { describe, expect, it } from 'vitest';
import { packVariationLanes } from '../../resources/edit/save-runner';

const rows = ( parent: number, count: number ) => Array.from( { length: count }, ( _, index ) => ( { parent, id: parent * 1000 + index } ) );

describe( 'packVariationLanes', () => {
	it( 'packs whole parents into shared requests and never splits a small parent', () => {
		const lanes = packVariationLanes( [ rows( 1, 60 ), rows( 2, 30 ), rows( 3, 20 ), rows( 4, 5 ) ], 100 );

		expect( lanes.map( ( lane ) => lane.map( ( group ) => group.length ) ) ).toEqual( [ [ 90 ], [ 25 ] ] );
	} );

	it( 'gives a parent larger than a request a lane of its own, chunked in order', () => {
		const lanes = packVariationLanes( [ rows( 1, 10 ), rows( 2, 182 ), rows( 3, 10 ) ], 100 );

		expect( lanes.map( ( lane ) => lane.map( ( group ) => group.length ) ) ).toEqual( [ [ 100, 82 ], [ 20 ] ] );
	} );

	it( 'has no parent in two lanes', () => {
		const lanes = packVariationLanes( [ rows( 1, 99 ), rows( 2, 2 ), rows( 3, 250 ), rows( 4, 1 ), rows( 5, 100 ) ], 100 );
		const laneOf = new Map< number, number >();

		lanes.forEach( ( lane, index ) =>
			lane.flat().forEach( ( row ) => {
				expect( laneOf.get( row.parent ) ?? index ).toBe( index );
				laneOf.set( row.parent, index );
			} )
		);
		expect( lanes.flat( 2 ) ).toHaveLength( 452 );
		expect( lanes.every( ( lane ) => lane.every( ( group ) => group.length <= 100 ) ) ).toBe( true );
	} );
} );
