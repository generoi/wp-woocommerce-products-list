import { describe, expect, it } from 'vitest';
import { ApiError } from '../../resources/api/errors';
import { listErrorMessage } from '../../resources/list/products-screen';

describe( 'listErrorMessage', () => {
	it( 'asks for a reload on an expired session and shows the REST message otherwise', () => {
		expect( listErrorMessage( new ApiError( 'Cookie check failed', 'rest_cookie_invalid_nonce', 403 ) ) ).toMatchObject( { reload: true } );
		expect( listErrorMessage( new ApiError( 'Sorry', 'rest_forbidden', 401 ) ) ).toMatchObject( { reload: true } );
		expect( listErrorMessage( new ApiError( 'Gateway timeout', 'http_error', 504 ) ) ).toEqual( { message: 'Gateway timeout', reload: false } );
		expect( listErrorMessage( new Error( '' ) ) ).toMatchObject( { reload: false, message: expect.stringContaining( 'could not be loaded' ) } );
	} );
} );
