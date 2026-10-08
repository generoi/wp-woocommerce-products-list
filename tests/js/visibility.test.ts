import { describe, expect, it } from 'vitest';
import {
	fieldAppliesTo,
	hasVariableParents,
	hasVariations,
	isParentOwnedField,
	isSellableField,
	leafOf,
	visibleEditFields,
} from '../../resources/edit/visibility';
import type { ProductListItem } from '../../resources/types';
import { coreFields, external, field, placeholder, simple, variable, variation } from './edit-fixtures';

const fields = coreFields();
const idsOf = ( list: Array< { id: string } > ) => list.map( ( f ) => f.id );
const quick = { mode: 'quick' as const, applyToVariations: false };
const bulk = { mode: 'bulk' as const, applyToVariations: false };
const bulkApply = { mode: 'bulk' as const, applyToVariations: true };

describe( 'classification helpers', () => {
	it( 'knows sellable and parent-owned ids, including extension leaves', () => {
		expect( isSellableField( 'sale_price' ) ).toBe( true );
		expect( isSellableField( 'i18n:se.sale_price' ) ).toBe( true );
		expect( isSellableField( 'date_on_sale_to' ) ).toBe( true );
		expect( isSellableField( 'stock_quantity' ) ).toBe( false );
		expect( isParentOwnedField( 'name' ) ).toBe( true );
		expect( isParentOwnedField( 'i18n:se.name' ) ).toBe( true );
		expect( isParentOwnedField( 'status' ) ).toBe( false );
		expect( leafOf( 'i18n:se.name' ) ).toBe( 'name' );
		expect( leafOf( 'name' ) ).toBe( 'name' );
	} );

	it( 'detects selection shapes', () => {
		expect( hasVariations( [ simple( 1 ), variation( 2, 1 ) ] ) ).toBe( true );
		expect( hasVariations( [ simple( 1 ) ] ) ).toBe( false );
		expect( hasVariableParents( [ variable( 1 ) ] ) ).toBe( true );
		expect( hasVariableParents( [ simple( 1 ), variation( 2, 1 ) ] ) ).toBe( false );
	} );

	it( 'applies fields per product type and variation flag', () => {
		const regular = fields.find( ( f ) => f.id === 'regular_price' )!;
		const name = fields.find( ( f ) => f.id === 'name' )!;

		expect( fieldAppliesTo( regular, simple( 1 ) ) ).toBe( true );
		expect( fieldAppliesTo( regular, external( 1 ) ) ).toBe( true );
		expect( fieldAppliesTo( regular, variable( 1 ) ) ).toBe( false );
		expect( fieldAppliesTo( regular, variable( 1 ), true ) ).toBe( true );
		expect( fieldAppliesTo( regular, variation( 2, 1 ) ) ).toBe( true );
		expect( fieldAppliesTo( name, variation( 2, 1 ) ) ).toBe( false );
		expect( fieldAppliesTo( name, variable( 1 ), true ) ).toBe( true );
		expect( fieldAppliesTo( field( 'x', { rest: { fields: [ 'x' ], applies: { product: false, variation: true } } } ), simple( 1 ) ) ).toBe( false );
	} );
} );

describe( 'visibleEditFields', () => {
	it( 'returns nothing for an empty or placeholder-only selection', () => {
		expect( visibleEditFields( fields, [], quick ) ).toEqual( [] );
		expect( visibleEditFields( fields, [ placeholder( 1 ) ], quick ) ).toEqual( [] );
	} );

	it( 'never offers read-only fields', () => {
		expect( idsOf( visibleEditFields( fields, [ simple( 1 ) ], quick ) ) ).not.toContain( 'readonly_thing' );
	} );

	it( 'quick edit of one simple product shows every simple field incl. sku and prices', () => {
		const ids = idsOf( visibleEditFields( fields, [ simple( 1 ) ], quick ) );

		expect( ids ).toEqual( [
			'name',
			'sku',
			'status',
			'regular_price',
			'sale_price',
			'date_on_sale_from',
			'date_on_sale_to',
			'stock_quantity',
			'manage_stock',
			'featured',
			'categories',
			'dimensions',
			'i18n:se.name',
			'i18n:se.sale_price',
			'i18n:se.regular_price',
		] );
	} );

	it( 'external-only fields show only when every item is external', () => {
		expect( idsOf( visibleEditFields( fields, [ external( 1 ) ], quick ) ) ).toContain( 'external_url' );
		expect( idsOf( visibleEditFields( fields, [ external( 1 ), simple( 2 ) ], bulk ) ) ).not.toContain( 'external_url' );
	} );

	it( 'bulk drops sku and fields with bulk: false', () => {
		const withNoBulk = [ ...fields, field( 'menu_order', { edit: { group: 'general', bulk: false } } ) ];
		const ids = idsOf( visibleEditFields( withNoBulk, [ simple( 1 ), simple( 2 ) ], bulk ) );

		expect( ids ).not.toContain( 'sku' );
		expect( ids ).not.toContain( 'menu_order' );
		expect( ids ).toContain( 'regular_price' );

		// Two rows are bulk even when the caller says quick.
		expect( idsOf( visibleEditFields( fields, [ simple( 1 ), simple( 2 ) ], quick ) ) ).not.toContain( 'sku' );
		// One row in bulk mode drops sku as well.
		expect( idsOf( visibleEditFields( fields, [ simple( 1 ) ], bulk ) ) ).not.toContain( 'sku' );
	} );

	it( 'variations in the selection drop parent-owned fields', () => {
		const ids = idsOf( visibleEditFields( fields, [ variation( 11, 1 ) ], quick ) );

		expect( ids ).toEqual( [ 'sku', 'status', 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to', 'stock_quantity', 'manage_stock', 'i18n:se.sale_price', 'i18n:se.regular_price' ] );

		const mixed = idsOf( visibleEditFields( fields, [ simple( 1 ), variation( 11, 1 ) ], bulk ) );

		expect( mixed ).toEqual( [ 'status', 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to', 'stock_quantity', 'manage_stock', 'i18n:se.sale_price', 'i18n:se.regular_price' ] );
	} );

	it( 'variable parents hide sellable fields unless applied to their variations', () => {
		const alone = idsOf( visibleEditFields( fields, [ variable( 1 ) ], quick ) );

		expect( alone ).toEqual( [ 'name', 'sku', 'status', 'stock_quantity', 'manage_stock', 'featured', 'categories', 'dimensions', 'i18n:se.name' ] );

		const applied = idsOf( visibleEditFields( fields, [ variable( 1 ) ], { mode: 'quick', applyToVariations: true } ) );

		expect( applied ).toContain( 'regular_price' );
		expect( applied ).toContain( 'sale_price' );
		expect( applied ).toContain( 'date_on_sale_from' );
		expect( applied ).toContain( 'i18n:se.sale_price' );
		expect( applied ).toContain( 'name' );
	} );

	it( 'mixed selections: the matrix', () => {
		const cases: Array< { items: ProductListItem[]; options: typeof bulk; expect: { has: string[]; not: string[] } } > = [
			{
				items: [ simple( 1 ), variable( 2 ) ],
				options: bulk,
				expect: { has: [ 'name', 'status', 'stock_quantity', 'featured' ], not: [ 'sku', 'regular_price', 'sale_price', 'external_url' ] },
			},
			{
				items: [ simple( 1 ), variable( 2 ) ],
				options: bulkApply,
				expect: { has: [ 'name', 'status', 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to' ], not: [ 'sku' ] },
			},
			{
				items: [ variable( 2 ), variation( 21, 2 ) ],
				options: bulk,
				expect: { has: [ 'status', 'stock_quantity' ], not: [ 'name', 'regular_price', 'featured', 'categories' ] },
			},
			{
				items: [ variable( 2 ), variation( 21, 2 ) ],
				options: bulkApply,
				expect: { has: [ 'status', 'stock_quantity', 'regular_price', 'sale_price' ], not: [ 'name', 'featured' ] },
			},
			{
				items: [ simple( 1 ), external( 3 ), variation( 21, 2 ) ],
				options: bulk,
				expect: { has: [ 'status', 'regular_price', 'sale_price', 'stock_quantity' ], not: [ 'name', 'external_url', 'sku' ] },
			},
			{
				items: [ simple( 1 ), simple( 4 ) ],
				options: bulk,
				// A translated name identifies one product: never offered in bulk (it would be copied onto every row).
				expect: { has: [ 'name', 'regular_price', 'sale_price', 'featured' ], not: [ 'sku', 'i18n:se.name' ] },
			},
		];

		for ( const testCase of cases ) {
			const ids = idsOf( visibleEditFields( fields, testCase.items, testCase.options ) );

			for ( const id of testCase.expect.has ) {
				expect( ids, `${ id } expected for ${ testCase.items.map( ( i ) => ( i as { type?: string } ).type ).join( '+' ) }` ).toContain( id );
			}

			for ( const id of testCase.expect.not ) {
				expect( ids, `${ id } not expected for ${ testCase.items.map( ( i ) => ( i as { type?: string } ).type ).join( '+' ) }` ).not.toContain( id );
			}
		}
	} );

	it( 'honours a field isVisible callback for every row', () => {
		const onlyFeatured = field( 'promo', { isVisible: ( item ) => ( item as { featured?: boolean } ).featured === true } );

		expect( idsOf( visibleEditFields( [ onlyFeatured ], [ simple( 1, { featured: true } ) ], quick ) ) ).toContain( 'promo' );
		expect( idsOf( visibleEditFields( [ onlyFeatured ], [ simple( 1, { featured: true } ), simple( 2 ) ], bulk ) ) ).not.toContain( 'promo' );
	} );

	it( 'unknown product types count as simple', () => {
		expect( idsOf( visibleEditFields( fields, [ simple( 1, { type: 'subscription' } ) ], quick ) ) ).toContain( 'regular_price' );
	} );
} );
