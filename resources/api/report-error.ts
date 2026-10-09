/**
 * Sends the app's own browser errors to POST /wc-products-list/v1/client-errors,
 * which writes them to WooCommerce → Status → Logs (source
 * `wc-products-list-client`). Best effort: deduplicated per page load, capped,
 * never throws, never reports its own failures.
 */
import apiFetch from '@wordpress/api-fetch';

export type ClientErrorKind = 'render' | 'uncaught' | 'rejection' | 'api';

const MAX_REPORTS_PER_PAGE = 25;
const PATH = '/wc-products-list/v1/client-errors';
const BUNDLE_MARKER = 'wp-woocommerce-products-list';

const seen = new Set< string >();
let sent = 0;

function describe( error: unknown ): { message: string; stack: string } {
	if ( error instanceof Error ) {
		return { message: `${ error.name }: ${ error.message }`, stack: error.stack ?? '' };
	}

	return { message: typeof error === 'string' ? error : JSON.stringify( error ) ?? String( error ), stack: '' };
}

export function reportClientError( kind: ClientErrorKind, error: unknown, context: Record< string, unknown > = {} ): void {
	try {
		const { message, stack } = describe( error );
		const key = `${ kind }|${ message }|${ JSON.stringify( context ) }`;

		if ( seen.has( key ) || sent >= MAX_REPORTS_PER_PAGE ) {
			return;
		}

		seen.add( key );
		sent++;

		void apiFetch( {
			path: PATH,
			method: 'POST',
			data: { kind, message, stack, context, url: window.location.href },
			keepalive: true,
		} as Parameters< typeof apiFetch >[ 0 ] ).catch( () => undefined );
	} catch {
		// Reporting must never break the app.
	}
}

/** Whether an uncaught error/rejection came from this plugin's bundle. */
function isOurs( stackOrFile: string | undefined ): boolean {
	return !! stackOrFile && stackOrFile.includes( BUNDLE_MARKER );
}

let installed = false;

/** Reports uncaught errors and unhandled rejections thrown from this bundle. */
export function installGlobalErrorReporting(): void {
	if ( installed || typeof window === 'undefined' ) {
		return;
	}

	installed = true;

	window.addEventListener( 'error', ( event ) => {
		const stack = event.error instanceof Error ? event.error.stack : undefined;

		if ( isOurs( event.filename ) || isOurs( stack ) ) {
			reportClientError( 'uncaught', event.error ?? event.message, { file: event.filename, line: event.lineno, column: event.colno } );
		}
	} );

	window.addEventListener( 'unhandledrejection', ( event ) => {
		const reason: unknown = event.reason;
		const stack = reason instanceof Error ? reason.stack : undefined;

		if ( isOurs( stack ) ) {
			reportClientError( 'rejection', reason );
		}
	} );
}

/** Whether a failed REST call is worth reporting: server errors and network failures, not 4xx or aborts. */
export function shouldReportApiError( status: number, code: string, path: string | undefined ): boolean {
	if ( path?.startsWith( PATH ) || code === 'abort' ) {
		return false;
	}

	return status >= 500 || status === 0;
}
