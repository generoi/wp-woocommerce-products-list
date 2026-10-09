/**
 * NameCell and Chevron subscribe to their own row of the hierarchy view
 * (context.tsx useHierarchyRowView): expanding one parent, or a slice of
 * Expand all landing, re-renders that parent's cell only, not every name
 * cell of a 600-row page.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { memo, useState } from '@wordpress/element';
import { describe, expect, it, vi } from 'vitest';
import { HierarchyViewProvider, NameCell } from '../../resources/hierarchy';
import type { ChildrenState } from '../../resources/hierarchy/flatten';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import type { ProductListItem, RawProduct } from '../../resources/types';

const renders = vi.fn< ( id: number ) => void >();

const parents = Array.from( { length: 5 }, ( _, index ) =>
	normalizeProduct( { id: index + 1, name: `Boot ${ index + 1 }`, type: 'variable', variations: [ 1, 2, 3 ] } as unknown as RawProduct )
);

/** A memoised row, like the patched DataViews TableRow: it renders only when its own props change. */
const Row = memo( function Row( { item }: { item: ProductListItem } ) {
	return (
<NameCell item={ item } />
	);
} );

/** Called by the chevron on every render of its cell: a render probe. */
function hasChildren( item: ProductListItem ): boolean {
	renders( item.id );

	return true;
}

function Harness() {
	const [ expandedItemIds, setExpanded ] = useState< number[] >( [] );
	const [ childrenState, setChildren ] = useState< ReadonlyMap< number, ChildrenState > >( () => new Map() );

	return (
		<>
			<button type="button" onClick={ () => setChildren( new Map( [ [ 2, { status: 'loaded', items: [], total: 3 } ] ] ) ) }>
				load 2
			</button>
			<HierarchyViewProvider
				value={ {
					getItemParentId: () => null,
					getItemHasChildren: hasChildren,
					expandedItemIds,
					onChangeExpandedItemIds: setExpanded,
					childrenState,
				} }
			>
				{ parents.map( ( item ) => (
					<Row key={ item.id } item={ item } />
				) ) }
			</HierarchyViewProvider>
		</>
	);
}

describe( 'name cells subscribe per row', () => {
	it( 'expanding one parent re-renders that parent’s cell, not the others', () => {
		render( <Harness /> );
		renders.mockClear();

		fireEvent.click( screen.getAllByRole( 'button', { name: /Expand 3 variations/ } )[ 1 ] as HTMLElement );

		expect( screen.getAllByRole( 'button', { name: /Collapse 3 variations/ } ) ).toHaveLength( 1 );
		expect( new Set( renders.mock.calls.map( ( [ id ] ) => id ) ) ).toEqual( new Set( [ 2 ] ) );
	} );

	it( 'a children state change re-renders the parent it belongs to only, and a click reads the latest expanded ids', () => {
		render( <Harness /> );
		fireEvent.click( screen.getAllByRole( 'button', { name: /Expand 3 variations/ } )[ 1 ] as HTMLElement );
		renders.mockClear();

		fireEvent.click( screen.getByRole( 'button', { name: 'load 2' } ) );
		expect( new Set( renders.mock.calls.map( ( [ id ] ) => id ) ) ).toEqual( new Set( [ 2 ] ) );

		// Parent 4's cell has not re-rendered since 2 expanded; its click must keep 2 open.
		fireEvent.click( screen.getAllByRole( 'button', { name: /Expand 3 variations/ } )[ 2 ] as HTMLElement );
		expect( screen.getAllByRole( 'button', { name: /Collapse 3 variations/ } ) ).toHaveLength( 2 );
	} );
} );
