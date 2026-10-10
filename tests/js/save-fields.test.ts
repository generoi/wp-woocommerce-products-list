import { describe, expect, it, vi } from 'vitest';
import { editSettings } from './edit-fixtures';

const settings = editSettings();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );

const { saveFields } = await import( '../../resources/edit/save' );
const { createCoreFields } = await import( '../../resources/fields/registry' );

describe( 'saveFields', () => {
	const fields = createCoreFields( settings );
	const visible = [ 'name', 'sku', 'price' ];

	it( 'asks back the shipping data WooCommerce clears when an item becomes virtual', () => {
		// Without them the row kept its old weight, and the next quick edit said someone else had emptied it.
		const returned = saveFields( fields, { virtual: true }, visible );

		expect( returned ).toEqual( expect.arrayContaining( [ 'virtual', 'weight', 'dimensions', 'shipping_class' ] ) );
	} );

	it( 'asks back the stock fields WooCommerce clears with stock management', () => {
		const returned = saveFields( fields, { manage_stock: false }, visible );

		expect( returned ).toEqual( expect.arrayContaining( [ 'manage_stock', 'stock_quantity', 'stock_status', 'backorders', 'low_stock_amount' ] ) );
	} );

	it( 'asks back only the edited and visible fields otherwise', () => {
		const returned = saveFields( fields, { name: 'x' }, visible );

		expect( returned ).not.toContain( 'weight' );
		expect( returned ).not.toContain( 'low_stock_amount' );
	} );
} );
