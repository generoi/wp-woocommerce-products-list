import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LogRow } from '../../resources/api/client';
import { conflictFields } from '../../resources/history/history-screen';
import { createLogFields, formatLogValue, historyMessage } from '../../resources/history/log-fields';
import { describeConflict } from '../../resources/history/revert';
import { editSettings } from './edit-fixtures';

const settings = editSettings();
// History's Field column names stock_quantity "Quantity" (the list column); the server's messages say "Stock quantity".
const fieldOptions = [
	{ value: 'name', label: 'Name' },
	{ value: 'regular_price', label: 'Regular price' },
	{ value: 'stock_quantity', label: 'Quantity' },
	{ value: 'low_stock_amount', label: 'Low stock threshold' },
];

function row( overrides: Partial< LogRow > ): LogRow {
	return {
		id: 1,
		batch_id: '00000000-0000-4000-8000-000000000001',
		created_at: '2026-10-10T12:00:00',
		created_at_gmt: '2026-10-10T09:00:00Z',
		user: { id: 1, name: 'admin' },
		source: 'revert',
		action: 'update',
		object_type: 'product',
		object_id: 41000,
		parent_id: 0,
		object_name: 'QA',
		edit_link: null,
		field: 'stock_quantity',
		old_value: '8',
		new_value: '20',
		status: 'ok',
		message: '',
		...overrides,
	};
}

function cell( id: string, item: LogRow ): string {
	const field = createLogFields( settings, { fieldOptions } ).find( ( f ) => f.id === id )!;
	const Render = field.render as ( props: { item: LogRow; field: unknown } ) => JSX.Element;

	// The text a person reads (the markup's own escaping undone once, as the browser does).
	const element = document.createElement( 'div' );
	element.innerHTML = renderToStaticMarkup( <Render item={ item } field={ field } /> );

	return element.textContent ?? '';
}

describe( 'History names a field the way its Field column does', () => {
	const conflict = { id: 7, ok: false, code: 'conflict', name: 'T04', fields: [ 'stock_quantity' ], labels: [ 'Stock quantity' ], current: { stock_quantity: 8 }, batch: { stock_quantity: 20 } };

	it( 'in the "changed again after this batch (…)" summary of a revert pass, as in the list under it', () => {
		const label = ( key: string ) => fieldOptions.find( ( option ) => option.value === key )?.label ?? key;

		expect( conflictFields( { conflicts: [ conflict ] }, fieldOptions ) ).toEqual( [ 'Quantity' ] );
		expect( describeConflict( conflict, label ) ).toBe( 'T04: Quantity 20 → 8 kept' );
		// A key History does not know keeps the server's label.
		expect( conflictFields( { conflicts: [ { ...conflict, fields: [ 'meta_data._foo' ], labels: [ 'Foo' ] } ] }, fieldOptions ) ).toEqual( [ 'Foo' ] );
	} );

	it( 'in the Result text of a row the revert left as it is', () => {
		const skipped = row( { status: 'skipped', message: 'Stock quantity was changed again after this batch (by an order or another edit) and was left as it is.' } );

		expect( cell( 'field', skipped ) ).toBe( 'Quantity' );
		expect( cell( 'status', skipped ) ).toBe( 'Quantity was changed again after this batch (by an order or another edit) and was left as it is.' );
		expect( historyMessage( 'Regular price, Stock quantity were changed again after this batch (by an order or another edit) and were left as they are.', fieldOptions ) ).toBe(
			'Regular price, Quantity were changed again after this batch (by an order or another edit) and were left as they are.'
		);
		expect( historyMessage( 'Low stock amount was changed.', fieldOptions ) ).toBe( 'Low stock threshold was changed.' );
		// Only whole labels: "stock quantity" inside other words is left alone.
		expect( historyMessage( 'Set the stock quantity of 3 items.', fieldOptions ) ).toBe( 'Set the stock quantity of 3 items.' );
		expect( cell( 'status', row( { status: 'error', message: 'Stock quantity could not be saved.' } ) ) ).toBe( 'Error: Quantity could not be saved.' );
	} );
} );

describe( 'History shows names stored with "&amp;" (saved by a shop manager) as text', () => {
	it( 'in the change column, the item column and conflict lines, without touching the stored values', () => {
		const renamed = row( { field: 'name', old_value: 'Tom &amp; Jerry', new_value: 'Tom &amp; Jerry 2', object_name: 'Tom &amp; Jerry 2' } );

		expect( formatLogValue( 'name', 'Tom &amp; Jerry', settings ) ).toBe( 'Tom & Jerry' );
		expect( cell( 'change', renamed ) ).toBe( 'Tom & Jerry→Tom & Jerry 2' );
		expect( cell( 'object', renamed ) ).toBe( 'Tom & Jerry 2' );
		expect( renamed.old_value ).toBe( 'Tom &amp; Jerry' );
		expect( describeConflict( { id: 3, ok: false, code: 'conflict', name: 'Salt &amp; Pepper', fields: [ 'name' ] }, () => 'Name' ) ).toBe( 'Salt & Pepper: Name' );
	} );
} );
