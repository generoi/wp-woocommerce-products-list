import { SnackbarList } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { useEffect } from '@wordpress/element';
import { store as noticesStore } from '@wordpress/notices';

type Snackbar = ReturnType< ReturnType< typeof useSelect >[ 'getNotices' ] >[ number ] & { explicitDismiss?: boolean };

/**
 * Snackbars shown at once. Sticky ones (an Undo) never expire, so five quick
 * edits in a row would stack five "1 item updated. Undo" bars; the oldest
 * go when a newer one arrives (their batches stay revertable in History).
 */
export const MAX_SNACKBARS = 3;

/**
 * A notice that offers something to undo stays until the user dismisses
 * it (a dismiss button is shown): "2 products moved to the Trash. Undo"
 * must not expire while the user is still looking, or while the tab is
 * busy rendering a large table. Plain notices keep the usual timeout.
 */
export function stickyWhenActionable< T extends { actions?: unknown[]; explicitDismiss?: boolean } >( notice: T ): T {
	// core/notices stores `explicitDismiss: false` on every notice it creates,
	// so "unspecified" cannot be told from an opt-out: a snackbar with an
	// action (Undo) is always kept until the user dismisses it.
	if ( notice.explicitDismiss === true || ! Array.isArray( notice.actions ) || notice.actions.length === 0 ) {
		return notice;
	}

	return { ...notice, explicitDismiss: true };
}

/** The ids of the oldest snackbars beyond the cap (the store lists notices oldest first). */
export function overflowingNotices< T extends { id: string } >( notices: T[], max: number = MAX_SNACKBARS ): string[] {
	return notices.length > max ? notices.slice( 0, notices.length - max ).map( ( notice ) => notice.id ) : [];
}

/** The snackbar stack of the core/notices store, bottom-left like the editor. */
export function Notices() {
	const notices = useSelect( ( select ) => select( noticesStore ).getNotices(), [] );
	const { removeNotice } = useDispatch( noticesStore );
	const snackbars = notices.filter( ( notice ) => notice.type === 'snackbar' ).map( ( notice ) => stickyWhenActionable( notice as Snackbar ) );
	const overflow = overflowingNotices( snackbars ).join( ',' );

	useEffect( () => {
		if ( overflow ) {
			overflow.split( ',' ).forEach( ( id ) => void removeNotice( id ) );
		}
	}, [ overflow, removeNotice ] );

	if ( ! snackbars.length ) {
		return null;
	}

	return <SnackbarList className="wc-products-list__notices" notices={ snackbars } onRemove={ removeNotice } />;
}
