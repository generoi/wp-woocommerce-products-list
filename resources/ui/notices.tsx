import { SnackbarList } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';

/** The snackbar stack of the core/notices store, bottom-left like the editor. */
export function Notices() {
	const notices = useSelect( ( select ) => select( noticesStore ).getNotices(), [] );
	const { removeNotice } = useDispatch( noticesStore );
	const snackbars = notices.filter( ( notice ) => notice.type === 'snackbar' );

	if ( ! snackbars.length ) {
		return null;
	}

	return <SnackbarList className="wc-products-list__notices" notices={ snackbars } onRemove={ removeNotice } />;
}
