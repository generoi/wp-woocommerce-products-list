import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MIXED_VALUE } from '../../resources/edit/merge';
import { effectiveEdits, useEditState } from '../../resources/edit/use-edit-state';
import type { ProductListItem } from '../../resources/types';
import { coreFields, field, simple } from './edit-fixtures';

const fields = coreFields();

describe( 'useEditState', () => {
	it( 'drops the edits when the selection key changes, so nothing typed for one product reaches the next', () => {
		const first = [ simple( 35049 ) ];
		const second = [ simple( 34390 ) ];
		const { result, rerender } = renderHook( ( { items, key }: { items: ProductListItem[]; key: string } ) => useEditState( items, fields, key ), {
			initialProps: { items: first, key: '35049' },
		} );

		act( () => result.current.setFields( { 'i18n:se.name': 'Svenska' } ) );

		expect( result.current.edits ).toEqual( { 'i18n:se.name': 'Svenska' } );
		expect( result.current.isDirty ).toBe( true );

		// The same selection reloaded with full values keeps what was typed.
		rerender( { items: [ simple( 35049, { sku: 'full' } ) ], key: '35049' } );
		expect( result.current.edits ).toEqual( { 'i18n:se.name': 'Svenska' } );

		rerender( { items: second, key: '34390' } );
		expect( result.current.edits ).toEqual( {} );
		expect( result.current.isDirty ).toBe( false );
		expect( result.current.hasInput ).toBe( false );
		expect( result.current.data[ 'i18n:se.name' ] ).toBe( '' );
	} );

	it( 'tells input apart from effective change', () => {
		const { result } = renderHook( () => useEditState( [ simple( 1, { status: 'publish' } ) ], fields, '1' ) );

		act( () => result.current.setField( 'status', 'publish' ) );

		expect( result.current.hasInput ).toBe( true );
		expect( result.current.isDirty ).toBe( false );
	} );
} );

describe( 'effectiveEdits', () => {
	it( 'treats the Mixed sentinel of a select as no edit', () => {
		const stock = field( 'stock_status', { elements: [ { value: 'instock', label: 'In stock' } ] } );
		const base = { stock_status: MIXED_VALUE };
		const mixed = { stock_status: { isMixed: true, isEmpty: false, placeholder: 'Mixed' } };

		expect( effectiveEdits( { stock_status: MIXED_VALUE }, base, mixed ) ).toEqual( {} );
		expect( effectiveEdits( { stock_status: 'instock' }, base, mixed ) ).toEqual( { stock_status: 'instock' } );
		expect( stock.elements ).toHaveLength( 1 );
	} );
} );
