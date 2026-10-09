import { describe, expect, it, vi } from 'vitest';
import { finishSaveJob, isRowPending, markRowsSaved, startSaveJob, updateSaveJob } from '../../resources/store/save-activity';

describe( 'save activity', () => {
	it( 'locks rows until they are written and warns before leaving while a save runs', () => {
		const add = vi.spyOn( window, 'addEventListener' );
		const remove = vi.spyOn( window, 'removeEventListener' );
		const job = startSaveJob( [ 1, 2, 3 ] );

		expect( add ).toHaveBeenCalledWith( 'beforeunload', expect.any( Function ) );
		updateSaveJob( job, 1, 3 );
		markRowsSaved( job, [ 1 ] );
		expect( isRowPending( 1 ) ).toBe( false );
		expect( isRowPending( 2 ) ).toBe( true );

		finishSaveJob( job );
		expect( isRowPending( 2 ) ).toBe( false );
		expect( remove ).toHaveBeenCalledWith( 'beforeunload', expect.any( Function ) );
	} );
} );
