/**
 * Snackbars from code that runs outside React (action callbacks, the save
 * flow): the same core/notices API the screen renders with <Notices />.
 */
import { dispatch } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';
import { createNoticesApi } from '../ui/use-notices';
import type { NoticesApi } from '../ui/use-notices';

let api: NoticesApi | undefined;

function notices(): NoticesApi {
	if ( ! api ) {
		api = createNoticesApi( dispatch );
	}

	return api;
}

export const notify = {
	success: ( ...args: Parameters< NoticesApi[ 'success' ] > ) => notices().success( ...args ),
	error: ( ...args: Parameters< NoticesApi[ 'error' ] > ) => notices().error( ...args ),
	info: ( ...args: Parameters< NoticesApi[ 'info' ] > ) => notices().info( ...args ),
	remove: ( id: string ) => void dispatch( noticesStore ).removeNotice( id ),
};
