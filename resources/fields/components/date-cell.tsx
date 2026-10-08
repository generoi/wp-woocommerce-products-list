import { getSettings } from '../../settings';
import { formatSiteDate } from '../site-date';

/** A wc/v3 site-local ISO date (with its `_gmt` twin when the row has it) in the site's date (and time) format. */
export function DateCell( { value, gmt, withTime = false }: { value: unknown; gmt?: unknown; withTime?: boolean } ) {
	if ( typeof value !== 'string' || value === '' ) {
		return <span className="wc-products-list__date wc-products-list__date--empty">—</span>;
	}

	const settings = getSettings();
	const format = withTime ? `${ settings.dateFormat } ${ settings.timeFormat }` : settings.dateFormat;

	return (
		<time className="wc-products-list__date" dateTime={ value }>
			{ formatSiteDate( format, value, typeof gmt === 'string' ? gmt : undefined, settings ) }
		</time>
	);
}
