import { describe, expect, it } from 'vitest';
import { mergeItems, mergeReference, mergeValues, MIXED_LABEL } from '../../resources/edit/merge';
import { coreFields, field, placeholder, simple, variation } from './edit-fixtures';

describe( 'mergeValues', () => {
	it( 'keeps a shared value', () => {
		expect( mergeValues( [ 'publish', 'publish' ] ) ).toEqual( { value: 'publish', isMixed: false } );
		expect( mergeValues( [ 5, 5 ] ) ).toEqual( { value: 5, isMixed: false } );
		expect( mergeValues( [ [ 1 ], [ 1 ] ] ) ).toEqual( { value: [ 1 ], isMixed: false } );
	} );

	it( 'falls back by type when values differ', () => {
		expect( mergeValues( [ 'a', 'b' ] ) ).toEqual( { value: '', isMixed: true } );
		expect( mergeValues( [ [ 1 ], [ 2 ] ] ) ).toEqual( { value: [], isMixed: true } );
		expect( mergeValues( [ null, 'x' ] ) ).toEqual( { value: '', isMixed: true } );
		expect( mergeValues( [ null, null, 3 ] ) ).toEqual( { value: undefined, isMixed: true } );
		expect( mergeValues( [ null, undefined ] ) ).toEqual( { value: null, isMixed: true } );
		expect( mergeValues( [ true, false ] ) ).toEqual( { value: undefined, isMixed: true } );
		expect( mergeValues( [ 1, 2 ] ) ).toEqual( { value: undefined, isMixed: true } );
	} );

	it( 'keeps undefined apart from null', () => {
		expect( mergeValues( [ undefined, null ] ).isMixed ).toBe( true );
		expect( mergeValues( [ undefined, undefined ] ) ).toEqual( { value: undefined, isMixed: false } );
	} );

	it( 'merges objects key by key (dimensions)', () => {
		const merged = mergeValues( [
			{ length: '10', width: '5', height: '2' },
			{ length: '10', width: '6', height: '2' },
		] );

		expect( merged.isMixed ).toBe( true );
		expect( merged.value ).toEqual( { length: '10', width: '', height: '2' } );
	} );
} );

describe( 'mergeItems', () => {
	const fields = coreFields();

	it( 'builds a flat record keyed by field id for one item', () => {
		const { data, mixed } = mergeItems( [ simple( 1, { regular_price: '10', sale_price: '' } ) ], fields );

		expect( data.regular_price ).toBe( '10' );
		expect( data.sale_price ).toBe( '' );
		expect( mixed.regular_price ).toEqual( { isMixed: false, isEmpty: false, placeholder: '' } );
		expect( mixed.sale_price ).toEqual( { isMixed: false, isEmpty: true, placeholder: '' } );
	} );

	it( 'marks differing values as mixed with the Mixed placeholder', () => {
		const { data, mixed } = mergeItems( [ simple( 1, { regular_price: '10', featured: true } ), simple( 2, { regular_price: '20', featured: false } ) ], fields );

		expect( data.regular_price ).toBe( '' );
		expect( mixed.regular_price ).toEqual( { isMixed: true, isEmpty: false, placeholder: MIXED_LABEL } );
		expect( data.featured ).toBeUndefined();
		expect( mixed.featured?.isMixed ).toBe( true );
		expect( data.status ).toBe( 'publish' );
		expect( mixed.status?.isMixed ).toBe( false );
	} );

	it( 'reads extension values through rest.read, flat under the field id', () => {
		const items = [
			simple( 1, { i18n: { se: { name: { value: 'Saga', source: 'Saga fi' } } } } ),
			simple( 2, { i18n: { se: { name: { value: 'Saga', source: 'Saga fi 2' } } } } ),
		];
		const { data, mixed } = mergeItems( items, fields );

		expect( data[ 'i18n:se.name' ] ).toBe( 'Saga' );
		expect( mixed[ 'i18n:se.name' ]?.isMixed ).toBe( false );
		expect( mergeReference( items, fields.find( ( f ) => f.id === 'i18n:se.name' )! ) ).toBe( MIXED_LABEL );
		expect( mergeReference( [ items[ 0 ]! ], fields.find( ( f ) => f.id === 'i18n:se.name' )! ) ).toBe( 'Saga fi' );
		expect( mergeReference( items, fields.find( ( f ) => f.id === 'name' )! ) ).toBeNull();
	} );

	it( 'uses getValue when the field has one and no rest.read', () => {
		const custom = field( 'custom', { getValue: ( { item } ) => `v${ item.id }` } );

		expect( mergeItems( [ simple( 1 ) ], [ custom ] ).data.custom ).toBe( 'v1' );
		expect( mergeItems( [ simple( 1 ), simple( 2 ) ], [ custom ] ).mixed.custom?.isMixed ).toBe( true );
	} );

	it( 'ignores placeholder rows and empty selections', () => {
		expect( mergeItems( [ simple( 1, { sku: 'A' } ), placeholder( 1 ) ], fields ).data.sku ).toBe( 'A' );
		expect( mergeItems( [], fields ).data.sku ).toBeUndefined();
	} );

	it( 'merges a product with its variation', () => {
		const { data, mixed } = mergeItems( [ simple( 1, { stock_quantity: 3 } ), variation( 11, 1, { stock_quantity: 3 } ) ], fields );

		expect( data.stock_quantity ).toBe( 3 );
		expect( mixed.stock_quantity?.isMixed ).toBe( false );
		expect( mixed.name?.isMixed ).toBe( true );
	} );
} );
