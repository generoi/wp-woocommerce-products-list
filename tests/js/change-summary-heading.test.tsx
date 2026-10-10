import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChangeSummary } from '../../resources/edit/change-summary';
import { withScheduleSale } from '../../resources/edit/form-layouts';
import { coreFields, editSettings, variation } from './edit-fixtures';

const settings = editSettings();
const fields = withScheduleSale( coreFields() );

describe( 'ChangeSummary heading', () => {
	it( 'does not count a field whose change reaches no row (every row skipped as already having a sale)', () => {
		const targets = [ variation( 11, 1, { name: 'Sock 36', regular_price: '10', sale_price: '8' } ), variation( 12, 1, { name: 'Sock 37', regular_price: '12', sale_price: '9' } ) ];

		render(
			<ChangeSummary
				edits={ { regular_price: { operation: 'set', value: '20' }, sale_price: { operation: 'increase', value: '1' } } }
				fields={ fields }
				targets={ targets }
				settings={ settings }
				applyToVariations
				options={ { skipExistingSales: true } }
			/>
		);

		expect( screen.getByText( '1 field will change on 2 rows:' ) ).toBeInTheDocument();
		// The skipped field is still listed, with its 0 rows.
		expect( screen.getByText( '(0 rows)' ) ).toBeInTheDocument();
	} );
} );
