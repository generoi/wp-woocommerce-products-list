import { describe, expect, it } from 'vitest';
import { collectInvalidFields, validateFormData } from '../../resources/edit/validity';

describe( 'validateFormData', () => {
	const fields = [
		{ id: 'name', isValid: { required: true } },
		{ id: 'sale_price', isValid: { custom: ( item: Record< string, unknown > ) => ( item.sale_price === '' || Number( item.sale_price ) < Number( item.regular_price ) ? null : 'The sale price must be lower than the regular price.' ) } },
		{ id: 'stock_quantity', isValid: { custom: ( item: Record< string, unknown > ) => ( Number( item.stock_quantity ) < 0 ? 'The quantity cannot be negative.' : null ) } },
		{ id: 'status', isValid: { elements: true }, elements: [ { value: 'publish' }, { value: 'draft' } ] },
		{ id: 'date_on_sale_from', isValid: { required: true }, isVisible: ( item: Record< string, unknown > ) => item.schedule_sale === true },
		{ id: 'async', isValid: { custom: () => Promise.resolve( 'later' ) } },
	];

	it( 'reports the rules against the current values, on visible fields only', () => {
		expect( validateFormData( { name: 'A', regular_price: '14', sale_price: '20', stock_quantity: 1, status: 'publish' }, fields ) ).toEqual( [ { field: 'sale_price', message: 'The sale price must be lower than the regular price.' } ] );

		// The sale price fixed and the quantity broken: the list follows.
		expect( validateFormData( { name: 'A', regular_price: '14', sale_price: '', stock_quantity: -5, status: 'publish' }, fields ) ).toEqual( [ { field: 'stock_quantity', message: 'The quantity cannot be negative.' } ] );

		expect( validateFormData( { name: '', regular_price: '14', sale_price: '', stock_quantity: 0, status: 'nope', schedule_sale: true, date_on_sale_from: '' }, fields ).map( ( entry ) => entry.field ) ).toEqual( [ 'name', 'status', 'date_on_sale_from' ] );
		// Hidden: the empty date is not required.
		expect( validateFormData( { name: 'A', sale_price: '', stock_quantity: 0, status: 'draft', schedule_sale: false, date_on_sale_from: '' }, fields ) ).toEqual( [] );
	} );
} );

describe( 'collectInvalidFields', () => {
	it( 'reads DataForm validity trees, groups included', () => {
		expect( collectInvalidFields( { name: { required: { type: 'invalid', message: 'Required' } }, group: { children: { sku: { custom: { type: 'invalid' } } } } } ) ).toEqual( [
			{ field: 'name', message: 'Required' },
			{ field: 'sku', message: 'This value is not valid.' },
		] );
	} );
} );
