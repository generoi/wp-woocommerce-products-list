/**
 * The progress of the saves in flight, above the list: a bulk update keeps
 * running after its editor panel is closed, so the list says it is working,
 * how far it is and about how long is left. The rows of the save are locked
 * meanwhile (their name cell says "Updating…") until the save ends.
 *
 * The count and the time left are visible text that changes every second;
 * screen readers get one polite region that speaks only at milestones (the
 * start, every 25 %), not on every tick. The outcome is announced by the
 * save's own snackbar.
 */
import { ProgressBar } from '@wordpress/components';
import { useEffect, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { timeLeft } from '../edit/progress';
import { useSaveActivity } from '../store/save-activity';

/** What the live region says: changes only at the start and at each quarter of the rows written. */
export function saveAnnouncement( done: number, total: number ): string {
	if ( ! total ) {
		return __( 'Preparing the update…', 'wp-woocommerce-products-list' );
	}

	const quarter = Math.min( 4, Math.floor( ( done / total ) * 4 ) );

	if ( quarter === 0 ) {
		return sprintf(
			/* translators: %s: rows in total */
			__( 'Updating %s rows.', 'wp-woocommerce-products-list' ),
			total.toLocaleString()
		);
	}

	if ( quarter === 4 ) {
		return __( 'All rows written; finishing the update…', 'wp-woocommerce-products-list' );
	}

	return sprintf(
		/* translators: %d: percentage of the rows written (25, 50 or 75) */
		__( 'Update %d %% done.', 'wp-woocommerce-products-list' ),
		quarter * 25
	);
}

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
		<div className="wc-products-list__save-activity">
			<span className="screen-reader-text" role="status" aria-live="polite" aria-atomic="true">
				{ saveAnnouncement( done, total ) }
			</span>
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
				{ __( 'Rows marked “Updating…” are locked until the update is done. The update runs in this tab: leaving the page stops it.', 'wp-woocommerce-products-list' ) }
			</span>
			{ total ? <ProgressBar value={ value } /> : <ProgressBar /> }
		</div>
	);
}
