import { dateI18n } from '@wordpress/date';
import { getSettings } from '../../settings';

/** A wc/v3 site-local ISO date in the site's date (and time) format. */
export function DateCell( { value, withTime = false }: { value: unknown; withTime?: boolean } ) {
	if ( typeof value !== 'string' || value === '' ) {
		return <span className="wc-products-list__date wc-products-list__date--empty">—</span>;
	}

	const settings = getSettings();
	const format = withTime ? `${ settings.dateFormat } ${ settings.timeFormat }` : settings.dateFormat;

	return (
		<time className="wc-products-list__date" dateTime={ value }>
			{ dateI18n( format, value, settings.timezone ) }
		</time>
	);
}
