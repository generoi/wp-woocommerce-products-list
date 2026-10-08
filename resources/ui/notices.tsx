import { SnackbarList } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';

type Snackbar = ReturnType< ReturnType< typeof useSelect >[ 'getNotices' ] >[ number ] & { explicitDismiss?: boolean };

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

/** The snackbar stack of the core/notices store, bottom-left like the editor. */
export function Notices() {
	const notices = useSelect( ( select ) => select( noticesStore ).getNotices(), [] );
	const { removeNotice } = useDispatch( noticesStore );
	const snackbars = notices.filter( ( notice ) => notice.type === 'snackbar' ).map( ( notice ) => stickyWhenActionable( notice as Snackbar ) );

	if ( ! snackbars.length ) {
		return null;
	}

	return <SnackbarList className="wc-products-list__notices" notices={ snackbars } onRemove={ removeNotice } />;
}
