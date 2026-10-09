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

describe( 'save jobs started before the writes', () => {
	it( 'locks the rows and the parents of variations; the time estimate starts at the first write', async () => {
		const { beginSaveJob, pendingRowIds, useSaveActivity } = await import( '../../resources/store/save-activity' );

		expect( Array.from( pendingRowIds( [ { id: 10, parent_id: 0 }, { id: 21, parent_id: 20 } ] ) ).sort() ).toEqual( [ 10, 20, 21 ] );

		vi.useFakeTimers();
		vi.setSystemTime( 1000 );
		const job = beginSaveJob( [ { id: 21, parent_id: 20 } ] );

		expect( isRowPending( 20 ) ).toBe( true );
		vi.setSystemTime( 5000 );
		updateSaveJob( job, 0, 10 );

		let started = 0;
		const { renderHook } = await import( '@testing-library/react' );
		const { result } = renderHook( () => useSaveActivity() );

		started = result.current?.startedAt ?? 0;
		expect( started ).toBe( 5000 );
		finishSaveJob( job );
		vi.useRealTimers();
		expect( isRowPending( 20 ) ).toBe( false );
	} );
} );
