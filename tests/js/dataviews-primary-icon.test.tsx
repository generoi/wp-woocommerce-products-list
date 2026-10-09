/**
 * patches/@wordpress__dataviews@20.0.0.patch, ButtonTrigger: a primary
 * action with `showIcon` (Quick edit) renders on every table row as a
 * compact icon button named by its label, not as a text button; other
 * primary actions keep their text.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pencil } from '@wordpress/icons';
import type { DataViews as DataViewsComponent, View } from '@wordpress/dataviews';
// @ts-expect-error -- no declaration file next to the bundle
import * as bundle from '../../node_modules/@wordpress/dataviews/build-wp/index.js';

const { DataViews } = bundle as unknown as { DataViews: typeof DataViewsComponent };

type Item = { id: number; name: string };

const items: Item[] = [ 1, 2, 3 ].map( ( id ) => ( { id, name: `Item ${ id }` } ) );
const fields = [ { id: 'name', label: 'Name', getValue: ( { item }: { item: Item } ) => item.name } ];
const view: View = { type: 'table', fields: [], titleField: 'name', perPage: 20, page: 1 };

describe( 'primary actions with showIcon', () => {
	it( 'shows a pencil labelled "Quick edit" on every row, and keeps text buttons for the others', () => {
		const quickEdit = vi.fn();
		const actions = [
			{ id: 'quick-edit', label: 'Quick edit', icon: pencil, isPrimary: true, showIcon: true, callback: quickEdit },
			{ id: 'open', label: 'Open', isPrimary: true, callback: vi.fn() },
		];

		render(
			<DataViews< Item >
				data={ items }
				fields={ fields }
				view={ view }
				onChangeView={ () => undefined }
				actions={ actions as never }
				paginationInfo={ { totalItems: 3, totalPages: 1 } }
				defaultLayouts={ { table: {} } }
				getItemId={ ( item: Item ) => String( item.id ) }
			/>
		);

		const pencils = screen.getAllByRole( 'button', { name: 'Quick edit' } );

		expect( pencils ).toHaveLength( 3 );

		for ( const button of pencils ) {
			expect( button.classList.contains( 'dataviews-primary-action-button' ) ).toBe( true );
			expect( button.querySelector( 'svg' ) ).not.toBeNull();
			expect( button.textContent ).toBe( '' );
		}

		expect( screen.getAllByRole( 'button', { name: 'Open' } )[ 0 ]!.textContent ).toBe( 'Open' );

		fireEvent.click( pencils[ 1 ]! );
		expect( quickEdit ).toHaveBeenCalledWith( [ items[ 1 ] ], expect.anything() );
	} );
} );
