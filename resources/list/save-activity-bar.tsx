/**
 * The progress of the saves in flight, above the list: a bulk update keeps
 * running after its editor panel is closed, so the list says it is working,
 * how far it is and about how long is left. The rows not written yet are
 * locked meanwhile (their name cell says "Updating…").
 */
import { ProgressBar } from '@wordpress/components';
import { useEffect, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { timeLeft } from '../edit/progress';
import { useSaveActivity } from '../store/save-activity';

export function SaveActivityBar() {
	const activity = useSaveActivity();
	const [ now, setNow ] = useState( () => Date.now() );

	useEffect( () => {
		if ( ! activity ) {
			return undefined;
		}

		const timer = window.setInterval( () => setNow( Date.now() ), 1000 );

		return () => window.clearInterval( timer );
	}, [ activity !== null ] ); // eslint-disable-line react-hooks/exhaustive-deps

	if ( ! activity ) {
		return null;
	}

	const { done, total } = activity;
	const value = total ? Math.round( ( done / total ) * 100 ) : 0;
	const left = total ? timeLeft( done, total, now - activity.startedAt ) : null;

	return (
		<div className="wc-products-list__save-activity" role="status" aria-live="polite">
			<span className="wc-products-list__save-activity-label">
				<span className="wc-pl-spinner" aria-hidden="true" />
				<strong>
					{ total
						? sprintf(
								/* translators: 1: rows written, 2: rows in total */
								__( 'Updating %1$s of %2$s rows…', 'wp-woocommerce-products-list' ),
								done.toLocaleString(),
								total.toLocaleString()
						  )
						: __( 'Preparing the update…', 'wp-woocommerce-products-list' ) }
				</strong>
				{ total ? ` ${ value } %` : '' }
				{ left ? ` · ${ left }` : '' }
				{ ' · ' }
				{ __( 'Rows marked “Updating…” are locked until they are saved. The update runs in this tab: leaving the page stops it.', 'wp-woocommerce-products-list' ) }
			</span>
			{ total ? <ProgressBar value={ value } /> : <ProgressBar /> }
		</div>
	);
}
