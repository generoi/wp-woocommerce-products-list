/**
 * wc/v3 dates come in pairs: `date_x` is a site-local string without an
 * offset ("2026-11-01T00:00:00"), `date_x_gmt` the same instant in UTC.
 * `dateI18n` hands a plain string to moment, which reads it in the
 * browser's zone, so a Helsinki browser showed a UTC site's 1 November
 * 00:00 as 31 October. The GMT string is exact; a site-local string is
 * read in the site's zone (`getDate`), never the browser's.
 */
import { dateI18n, getDate } from '@wordpress/date';
import type { Settings } from '../types';

export function formatSiteDate( format: string, local: string, gmt: string | null | undefined, settings: Pick< Settings, 'timezone' > ): string {
	if ( gmt ) {
		return dateI18n( format, `${ gmt }Z`, settings.timezone );
	}

	return dateI18n( format, getDate( local ), settings.timezone );
}
