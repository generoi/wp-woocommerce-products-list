import type { Settings } from './types/settings';

let cached: Settings | undefined;

/**
 * The payload src/Bootstrap.php printed before the script. Read once; the
 * app never mutates it (extensions change it server-side through the
 * `wc_products_list/bootstrap` filter).
 */
export function getSettings(): Settings {
	if ( cached ) {
		return cached;
	}

	const settings = window.wcProductsListSettings;

	if ( ! settings || typeof settings !== 'object' ) {
		throw new Error( 'wcProductsListSettings is missing: the script was enqueued without its inline settings.' );
	}

	cached = settings;

	return settings;
}

/** For tests: replace the payload. */
export function setSettings( settings: Settings | undefined ): void {
	cached = undefined;
	window.wcProductsListSettings = settings;
}

export function currentUserCan( cap: keyof Settings[ 'caps' ] ): boolean {
	return getSettings().caps[ cap ] === true;
}
