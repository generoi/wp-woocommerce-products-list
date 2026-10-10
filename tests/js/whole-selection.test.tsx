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

describe( 'extendToWholeSelection with an eligibility rule', () => {
	it( 'widens the eligible part of the page\'s selection: DataViews leaves out the selected rows an action does not apply to', () => {
		const featured = { ...product( 3 ), featured: true };
		const rows = [ product( 1 ), product( 2 ), featured ];
		const selectAll = { onPage: [ '1', '2', '3' ], offPage, onPageRows: rows };
		const notFeatured = ( item: ProductListItem ) => ! item.featured;

		// "Mark as featured" over a whole-list selection: DataViews hands it rows 1 and 2 (3 is featured already).
		expect( extendToWholeSelection( [ rows[ 0 ]!, rows[ 1 ]! ], selectAll, notFeatured ).map( ( row ) => row.id ) ).toEqual( [ 1, 2, 7, 8 ] );
		// A row's own menu on one of them is still that row alone.
		expect( extendToWholeSelection( [ rows[ 0 ]! ], selectAll, notFeatured ).map( ( row ) => row.id ) ).toEqual( [ 1 ] );
		// Without the page's rows the ids decide, as before.
		expect( extendToWholeSelection( [ rows[ 0 ]!, rows[ 1 ]! ], { onPage: [ '1', '2', '3' ], offPage }, notFeatured ).map( ( row ) => row.id ) ).toEqual( [ 1, 2 ] );
	} );

	it( 'wraps a bulk action with its own isEligible', () => {
		const callback = vi.fn();
		const rows = [ product( 1 ), { ...product( 2 ), featured: true } ];
		const [ wrapped ] = withWholeSelection( [ { id: 'feature', label: 'Feature', supportsBulk: true, isEligible: ( item ) => ! item.featured, callback } ], () => ( { onPage: [ '1', '2' ], offPage, onPageRows: rows } ) ) as Array< ProductAction & { callback: ( items: ProductListItem[], context: unknown ) => void } >;

		wrapped!.callback( [ rows[ 0 ]! ], {} );
		expect( ( callback.mock.calls[ 0 ]?.[ 0 ] as ProductListItem[] ).map( ( row ) => row.id ) ).toEqual( [ 1, 7, 8 ] );
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
