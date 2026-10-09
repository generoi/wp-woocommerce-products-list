/**
 * Snackbars from code that runs outside React (action callbacks, the save
 * flow): the same core/notices API the screen renders with <Notices />.
 */
import { dispatch } from '@wordpress/data';
import { store as noticesStore } from '@wordpress/notices';
import { createNoticesApi } from '../ui/use-notices';
import type { NoticesApi } from '../ui/use-notices';
import type { NoticeOptions } from '../types';

let api: NoticesApi | undefined;

function notices(): NoticesApi {
	if ( ! api ) {
		api = createNoticesApi( dispatch );
	}

	return api;
}

/**
 * A bulk save's snackbar (an Undo next to its "View in History" link) stays
 * until it is dismissed or a newer Undo replaces it (ui/notices.tsx), not the
 * 10 s an Undo gets otherwise: a store manager checks a bulk change in the
 * list before deciding to keep it. A notice that says otherwise keeps its say.
 */
export function withStickyBulkUndo( options: NoticeOptions | undefined ): NoticeOptions | undefined {
	if ( ! options || options.explicitDismiss !== undefined || ! options.actions?.length ) {
		return options;
	}

	const undo = options.actions.some( ( action ) => typeof action.onClick === 'function' );
	const history = options.actions.some( ( action ) => typeof action.url === 'string' && action.url !== '' );

	return undo && history ? { ...options, explicitDismiss: true } : options;
}

export const notify = {
	success: ( message: string, options?: NoticeOptions ) => notices().success( message, withStickyBulkUndo( options ) ),
	error: ( ...args: Parameters< NoticesApi[ 'error' ] > ) => notices().error( ...args ),
	info: ( ...args: Parameters< NoticesApi[ 'info' ] > ) => notices().info( ...args ),
	remove: ( id: string ) => void dispatch( noticesStore ).removeNotice( id ),
};
