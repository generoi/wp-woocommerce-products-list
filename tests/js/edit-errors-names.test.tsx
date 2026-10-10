/**
 * The editor's problem list names a variation by its parent even when that
 * parent is on another page of the list: the editor holds the parent row.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditErrors } from '../../resources/edit/progress';
import { resetCurrentRows, setCurrentRows } from '../../resources/store/rows';
import { simple, variable, variation } from './edit-fixtures';

afterEach( () => resetCurrentRows() );

describe( 'EditErrors', () => {
	it( 'names a variation of an off-page parent by that parent', () => {
		// The page shows other rows; the selected parent is on page 2.
		setCurrentRows( [ simple( 1, { name: 'On screen' } ) ] );
		const parent = variable( 10, { name: 'QA Parent' } );
		const child = variation( 11, 10, { name: 'Mint, 17' } );

		render( <EditErrors errors={ [ { id: 11, message: 'It was deleted meanwhile and was left out.' } ] } items={ [ parent, child ] } fieldLabels={ {} } /> );

		expect( screen.getByText( 'QA Parent – Mint, 17:' ) ).toBeInTheDocument();
	} );
} );
