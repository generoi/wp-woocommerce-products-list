import { afterEach, describe, expect, it } from 'vitest';
import { placeholderRow } from '../../resources/hierarchy/flatten';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { getCurrentRows, resetCurrentRows, setCurrentRows } from '../../resources/store/rows';

afterEach( () => resetCurrentRows() );

describe( 'current rows', () => {
	it( 'hands back the rows on screen without placeholders', () => {
		expect( getCurrentRows() ).toEqual( [] );

		const product = normalizeProduct( { id: 1, type: 'variable', wc_products_list: { variation_count: 3, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 } } );
		setCurrentRows( [ product, placeholderRow( 1, 'loading', '…' ) ] );

		expect( getCurrentRows() ).toEqual( [ product ] );
	} );
} );
