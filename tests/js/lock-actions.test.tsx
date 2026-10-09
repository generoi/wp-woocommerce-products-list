/**
 * A row rendered while a save locked it, and never written (held back for a
 * clash, re-read during the lock), gets its edit actions back when the save
 * ends: DataViews memoises a row's actions on [actions, item], so the list
 * rebuilds its actions on the save activity's lock version (products-screen.tsx).
 * Runs against the patched `build-wp` DataViews bundle the app uses.
 */
import { act, render, screen } from '@testing-library/react';
import { useMemo } from '@wordpress/element';
import { pencil } from '@wordpress/icons';
import { describe, expect, it } from 'vitest';
import type { DataViews as DataViewsComponent, View } from '@wordpress/dataviews';
// @ts-expect-error -- no declaration file next to the bundle
import * as bundle from '../../node_modules/@wordpress/dataviews/build-wp/index.js';
import { beginSaveJob, finishSaveJob, getLockVersion, isRowPending, markRowsSaved, updateSaveJob, useLockVersion } from '../../resources/store/save-activity';

const { DataViews } = bundle as unknown as { DataViews: typeof DataViewsComponent };

type Item = { id: number; name: string };

const fields = [ { id: 'name', label: 'Name', getValue: ( { item }: { item: Item } ) => item.name } ];
const view: View = { type: 'table', fields: [], titleField: 'name', perPage: 20, page: 1 };
const getItemId = ( item: Item ) => String( item.id );
const baseActions = [ { id: 'quick-edit', label: 'Quick edit', icon: pencil, isPrimary: true, isEligible: ( item: Item ) => ! isRowPending( item.id ), callback: () => {} } ];

function List( { data }: { data: Item[] } ) {
	const lockVersion = useLockVersion();
	// eslint-disable-next-line react-hooks/exhaustive-deps -- as in products-screen.tsx
	const actions = useMemo( () => baseActions.map( ( action ) => ( { ...action } ) ), [ lockVersion ] );

	return (
		<DataViews
			data={ data }
			fields={ fields }
			view={ view }
			onChangeView={ () => {} }
			actions={ actions }
			getItemId={ getItemId }
			paginationInfo={ { totalItems: data.length, totalPages: 1 } }
			defaultLayouts={ { table: {} } }
		/>
	);
}

describe( 'row actions and save locks', () => {
	it( 'a row hydrated during the lock and held back is eligible for quick edit after the save ends', () => {
		const data: Item[] = [
			{ id: 1, name: 'Saved row' },
			{ id: 2, name: 'Held back row' },
		];
		const { rerender } = render( <List data={ data } /> );

		expect( screen.getAllByRole( 'button', { name: 'Quick edit' } ) ).toHaveLength( 2 );

		let job = 0;

		act( () => {
			job = beginSaveJob( data.map( ( item ) => ( { id: item.id, parent_id: 0 } ) ) );
		} );
		// The pre-save re-check hydrates both rows: new objects, rendered while locked.
		const hydrated = data.map( ( item ) => ( { ...item } ) );
		rerender( <List data={ hydrated } /> );
		expect( screen.queryAllByRole( 'button', { name: 'Quick edit' } ) ).toHaveLength( 0 );

		// Row 1 is written (a new object arrives); row 2 is held back and never written.
		act( () => {
			updateSaveJob( job, 1, 1 );
			markRowsSaved( job, [ 1 ] );
		} );
		rerender( <List data={ [ { ...hydrated[ 0 ]! }, hydrated[ 1 ]! ] } /> );

		const before = getLockVersion();

		act( () => finishSaveJob( job ) );
		expect( getLockVersion() ).toBeGreaterThan( before );
		expect( screen.getAllByRole( 'button', { name: 'Quick edit' } ) ).toHaveLength( 2 );
	} );

	it( 'progress alone does not change the lock version (row actions are not rebuilt per chunk)', () => {
		const job = beginSaveJob( [ { id: 9, parent_id: 0 } ] );
		const version = getLockVersion();

		updateSaveJob( job, 1, 10 );
		updateSaveJob( job, 5, 10 );
		expect( getLockVersion() ).toBe( version );

		finishSaveJob( job );
		expect( getLockVersion() ).toBe( version + 1 );
	} );
} );
