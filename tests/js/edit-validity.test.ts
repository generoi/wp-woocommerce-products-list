import { describe, expect, it } from 'vitest';
import { humanizeError } from '../../resources/edit/errors';
import { collectInvalidFields, revealInvalidControls } from '../../resources/edit/validity';
import { describeBatchScope, summarizeBatch } from '../../resources/history/batch-scope';
import type { LogRow } from '../../resources/api/client';

describe( 'collectInvalidFields', () => {
	it( 'walks DataForm’s validity tree through card groups and names the rule', () => {
		const validity = {
			'group:general': { children: { name: { required: { type: 'invalid' } } } },
			'group:organization': { children: { categories: { custom: { type: 'invalid', message: 'Every value must be a string.' } }, tags: { elements: { type: 'validating' } } } },
			sale_price: { custom: { type: 'invalid', message: 'Too high.' } },
		};

		expect( collectInvalidFields( validity ) ).toEqual( [
			{ field: 'name', message: 'This field is required.' },
			{ field: 'categories', message: 'Every value must be a string.' },
			{ field: 'sale_price', message: 'Too high.' },
		] );
		expect( collectInvalidFields( undefined ) ).toEqual( [] );
	} );
} );

describe( 'revealInvalidControls', () => {
	it( 'fires invalid on the controls the browser rejects', () => {
		const root = document.createElement( 'div' );

		root.innerHTML = '<input required value=""><input value="ok"><select required><option value="">-</option></select>';

		const seen: string[] = [];

		root.querySelectorAll( 'input, select' ).forEach( ( control ) => control.addEventListener( 'invalid', () => seen.push( control.tagName ) ) );

		expect( revealInvalidControls( root ) ).toBe( 2 );
		expect( seen ).toEqual( [ 'INPUT', 'SELECT' ] );
		expect( revealInvalidControls( null ) ).toBe( 0 );
	} );
} );

describe( 'humanizeError', () => {
	it( 'maps the wc/v3 codes a save can return and falls back to the message', () => {
		expect( humanizeError( 'woocommerce_rest_product_invalid_id', 'Invalid ID.' ) ).toMatch( /no longer exists/ );
		expect( humanizeError( 'woocommerce_rest_cannot_batch', 'Sorry' ) ).toMatch( /edit_others_products/ );
		expect( humanizeError( 'rest_forbidden', 'x' ) ).toMatch( /not allowed/ );
		expect( humanizeError( 'rest_invalid_param', 'sale_price is not of type string.' ) ).toMatch( /rejected.*sale_price/ );
		expect( humanizeError( 'something_else', 'Raw text' ) ).toBe( 'Raw text' );
		expect( humanizeError( undefined, '' ) ).toMatch( /could not be saved/ );
	} );
} );

describe( 'batch scope', () => {
	const row = ( overrides: Partial< LogRow > ): LogRow =>
		( {
			id: 1,
			batch_id: 'b',
			created_at: '',
			created_at_gmt: '',
			user: { id: 1, name: 'admin' },
			source: 'bulk',
			action: 'update',
			object_type: 'product',
			object_id: 1,
			parent_id: 0,
			object_name: '',
			edit_link: null,
			field: 'stock_quantity',
			old_value: '9',
			new_value: '0',
			status: 'ok',
			message: '',
			...overrides,
		} ) as LogRow;

	it( 'counts changes, distinct items and fields; flags a partial page', () => {
		const rows = [ row( { id: 1, object_id: 206 } ), row( { id: 2, object_id: 210 } ), row( { id: 3, object_id: 210, field: 'stock_status' } ), row( { id: 4, object_id: 255, action: 'trash', field: '' } ) ];
		const scope = summarizeBatch( rows, 4 );

		// The trash row put nothing in place: three changes, not four.
		expect( scope ).toEqual( { changes: 3, objects: 2, fields: [ 'stock_quantity', 'stock_status' ], partial: false } );
		expect( describeBatchScope( scope ) ).toBe( 'This will put back 3 changes on 2 items: stock_quantity, stock_status.' );
		// An error row recorded no change either.
		expect( summarizeBatch( [ ...rows, row( { id: 5, object_id: 300, status: 'error', message: 'Invalid ID.' } ) ], 5 ).changes ).toBe( 3 );
		expect( describeBatchScope( summarizeBatch( rows.slice( 0, 1 ), 120 ) ) ).toMatch( /120 changes on 1 item\+: stock_quantity\./ );
	} );
} );
