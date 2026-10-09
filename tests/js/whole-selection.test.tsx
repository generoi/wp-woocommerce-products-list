import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { extendToWholeSelection, withWholeSelection } from '../../resources/list/whole-selection';
import type { ProductAction, ProductListItem } from '../../resources/types';

function product( id: number ): ProductListItem {
	return normalizeProduct( { id, type: 'simple', name: `P${ id }` } );
}

const onPageRows = [ product( 1 ), product( 2 ) ];
const offPage = [ product( 7 ), product( 8 ) ];
const whole = { onPage: [ '1', '2' ], offPage };

describe( 'extendToWholeSelection', () => {
	it( 'adds the other pages\' rows when the items are the page\'s whole selection', () => {
		expect( extendToWholeSelection( onPageRows, whole ).map( ( row ) => row.id ) ).toEqual( [ 1, 2, 7, 8 ] );
		expect( extendToWholeSelection( [ onPageRows[ 1 ]!, onPageRows[ 0 ]! ], whole ).map( ( row ) => row.id ) ).toEqual( [ 2, 1, 7, 8 ] );
	} );

	it( 'leaves a single row\'s action, a different set, or a page-only selection alone', () => {
		const one = [ onPageRows[ 0 ]! ];
		expect( extendToWholeSelection( one, whole ) ).toBe( one );
		const other = [ onPageRows[ 0 ]!, product( 3 ) ];
		expect( extendToWholeSelection( other, whole ) ).toBe( other );
		expect( extendToWholeSelection( onPageRows, { onPage: [ '1', '2' ], offPage: [] } ) ).toBe( onPageRows );
	} );
} );

describe( 'withWholeSelection', () => {
	it( 'widens bulk callbacks, modals and labels; leaves single-row actions as they are', () => {
		const callback = vi.fn();
		const RenderModal = ( { items }: { items: ProductListItem[] } ) => <p>{ items.map( ( item ) => item.id ).join( ',' ) }</p>;
		const actions: ProductAction[] = [
			{ id: 'bulk-cb', label: ( items ) => `Do ${ items.length }`, supportsBulk: true, callback },
			{ id: 'bulk-modal', label: 'Edit', supportsBulk: true, RenderModal, modalHeader: ( items ) => `Edit ${ items.length } items` },
			{ id: 'single', label: 'View', callback: vi.fn() },
		];
		const wrapped = withWholeSelection( actions, () => whole );

		expect( wrapped[ 2 ] ).toBe( actions[ 2 ] );

		const cb = wrapped[ 0 ] as ProductAction & { callback: ( items: ProductListItem[], context: unknown ) => void; label: ( items: ProductListItem[] ) => string };
		cb.callback( onPageRows, {} );
		expect( callback ).toHaveBeenCalledWith( expect.arrayContaining( [ ...onPageRows, ...offPage ] ), {} );
		expect( callback.mock.calls[ 0 ]?.[ 0 ] ).toHaveLength( 4 );
		expect( cb.label( onPageRows ) ).toBe( 'Do 4' );
		expect( cb.label( [ onPageRows[ 0 ]! ] ) ).toBe( 'Do 1' );

		// A count-labelled action on one row stays on that row, label and callback alike (a row's label never goes stale).
		const sole = { onPage: [ '1' ], offPage };
		const soleWrapped = withWholeSelection( actions, () => sole )[ 0 ] as typeof cb;
		callback.mockClear();
		expect( soleWrapped.label( [ onPageRows[ 0 ]! ] ) ).toBe( 'Do 1' );
		soleWrapped.callback( [ onPageRows[ 0 ]! ], {} );
		expect( callback.mock.calls[ 0 ]?.[ 0 ] ).toHaveLength( 1 );

		const modal = wrapped[ 1 ] as ProductAction & { RenderModal: typeof RenderModal; modalHeader: ( items: ProductListItem[] ) => string };
		expect( modal.modalHeader( onPageRows ) ).toBe( 'Edit 4 items' );
		render( <modal.RenderModal items={ onPageRows } closeModal={ () => {} } /> );
		expect( screen.getByText( '1,2,7,8' ) ).toBeInTheDocument();
	} );
} );
