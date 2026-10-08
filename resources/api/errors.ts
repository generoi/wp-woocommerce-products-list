/**
 * The one error shape the app handles. Every failed request, whatever
 * apiFetch threw (a parsed WP_Error body, a raw Response when `parse` was
 * false, a network TypeError, an AbortError), becomes an ApiError.
 */
export class ApiError extends Error {
	code: string;

	status: number;

	data?: unknown;

	constructor( message: string, code = 'unknown_error', status = 0, data?: unknown ) {
		super( message );
		this.name = 'ApiError';
		this.code = code;
		this.status = status;
		this.data = data;
	}

	get isAbort(): boolean {
		return this.code === 'abort';
	}

	get isForbidden(): boolean {
		return this.status === 401 || this.status === 403 || this.code === 'rest_forbidden';
	}
}

interface WpErrorBody {
	code?: string;
	message?: string;
	data?: { status?: number } & Record< string, unknown >;
}

function isWpErrorBody( value: unknown ): value is WpErrorBody {
	return typeof value === 'object' && value !== null && ( 'code' in value || 'message' in value );
}

export function isAbortError( error: unknown ): boolean {
	return (
		( error instanceof ApiError && error.isAbort ) ||
		( typeof error === 'object' && error !== null && 'name' in error && ( error as { name?: string } ).name === 'AbortError' )
	);
}

/** Turn whatever apiFetch rejected with into an ApiError (async: a raw Response has to be read). */
export async function toApiError( error: unknown ): Promise< ApiError > {
	if ( error instanceof ApiError ) {
		return error;
	}

	if ( isAbortError( error ) ) {
		return new ApiError( 'Request aborted', 'abort', 0 );
	}

	if ( typeof Response !== 'undefined' && error instanceof Response ) {
		let body: unknown;

		try {
			body = await error.clone().json();
		} catch {
			body = undefined;
		}

		if ( isWpErrorBody( body ) ) {
			return new ApiError( body.message ?? error.statusText, body.code ?? 'unknown_error', body.data?.status ?? error.status, body.data );
		}

		return new ApiError( error.statusText || `HTTP ${ error.status }`, 'http_error', error.status );
	}

	if ( isWpErrorBody( error ) ) {
		return new ApiError( error.message ?? 'Unknown error', error.code ?? 'unknown_error', error.data?.status ?? 0, error.data );
	}

	if ( error instanceof Error ) {
		return new ApiError( error.message, 'fetch_error', 0 );
	}

	return new ApiError( 'An unknown error occurred.', 'unknown_error', 0 );
}
