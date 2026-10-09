import { describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn( ( _options: unknown ) => Promise.resolve( {} ) );
vi.mock( '@wordpress/api-fetch', () => ( { default: apiFetch } ) );

const { reportClientError, shouldReportApiError } = await import( '../../resources/api/report-error' );

describe( 'reportClientError', () => {
	it( 'posts once per distinct error', () => {
		reportClientError( 'render', new Error( 'boom' ), { context: 'list' } );
		reportClientError( 'render', new Error( 'boom' ), { context: 'list' } );
		expect( apiFetch ).toHaveBeenCalledTimes( 1 );
		expect( apiFetch.mock.calls[ 0 ]![ 0 ] ).toMatchObject( { path: '/wc-products-list/v1/client-errors', method: 'POST', data: { kind: 'render', message: 'Error: boom' } } );
	} );

	it( 'reports server and network errors only, never its own endpoint or aborts', () => {
		expect( shouldReportApiError( 500, 'internal', '/wc/v3/products' ) ).toBe( true );
		expect( shouldReportApiError( 0, 'fetch_error', '/wc/v3/products' ) ).toBe( true );
		expect( shouldReportApiError( 400, 'rest_invalid_param', '/wc/v3/products' ) ).toBe( false );
		expect( shouldReportApiError( 0, 'abort', '/wc/v3/products' ) ).toBe( false );
		expect( shouldReportApiError( 500, 'internal', '/wc-products-list/v1/client-errors' ) ).toBe( false );
	} );
} );
