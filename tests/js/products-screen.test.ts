import { describe, expect, it } from 'vitest';
import { ApiError } from '../../resources/api/errors';
import { listErrorMessage } from '../../resources/list/products-screen';

describe( 'listErrorMessage', () => {
	it( 'asks for a reload only on a nonce the server refused, and shows the REST message otherwise', () => {
		expect( listErrorMessage( new ApiError( 'Cookie check failed', 'rest_cookie_invalid_nonce', 403 ) ) ).toMatchObject( { reload: true, message: expect.stringContaining( 'session has expired' ) } );
		// A real 403 is the server's reason (a capability the user lacks), never "session expired".
		expect( listErrorMessage( new ApiError( 'Sorry, you are not allowed to list products.', 'rest_forbidden', 403 ) ) ).toEqual( { message: 'Sorry, you are not allowed to list products.', reload: false } );
		expect( listErrorMessage( new ApiError( '', 'rest_forbidden', 401 ) ) ).toMatchObject( { reload: false, message: expect.stringContaining( 'not allowed' ) } );
		expect( listErrorMessage( new ApiError( 'Gateway timeout', 'http_error', 504 ) ) ).toEqual( { message: 'Gateway timeout', reload: false } );
		expect( listErrorMessage( new Error( '' ) ) ).toMatchObject( { reload: false, message: expect.stringContaining( 'could not be loaded' ) } );
	} );
} );
