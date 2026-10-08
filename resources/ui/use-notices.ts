import { useDispatch } from '@wordpress/data';
import { useMemo } from '@wordpress/element';
import { store as noticesStore } from '@wordpress/notices';
import type { ExtensionApi, NoticeOptions } from '../types';

export type NoticesApi = ExtensionApi[ 'notices' ];

function toOptions( options: NoticeOptions | undefined ) {
	return {
		id: options?.id,
		type: options?.type ?? 'snackbar',
		isDismissible: options?.isDismissible ?? true,
		actions: options?.actions,
		// Snackbars hide after a timeout that pauses on hover/focus (ui/notices.tsx); `true` keeps one until dismissed.
		...( options?.explicitDismiss !== undefined ? { explicitDismiss: options.explicitDismiss } : {} ),
	};
}

/** success/error/info on the core/notices store, the shape `window.wcProductsList.notices` exposes. */
export function useNotices(): NoticesApi {
	const { createSuccessNotice, createErrorNotice, createInfoNotice } = useDispatch( noticesStore );

	return useMemo(
		() => ( {
			success: ( message, options ) => void createSuccessNotice( message, toOptions( options ) ),
			error: ( message, options ) => void createErrorNotice( message, { ...toOptions( options ), type: options?.type ?? 'snackbar' } ),
			info: ( message, options ) => void createInfoNotice( message, toOptions( options ) ),
		} ),
		[ createSuccessNotice, createErrorNotice, createInfoNotice ]
	);
}

/** The same API without hooks, for code that runs outside React (the extension API). */
export function createNoticesApi( dispatch: ( store: typeof noticesStore ) => ReturnType< typeof useDispatch< typeof noticesStore > > ): NoticesApi {
	const actions = dispatch( noticesStore );

	return {
		success: ( message, options ) => void actions.createSuccessNotice( message, toOptions( options ) ),
		error: ( message, options ) => void actions.createErrorNotice( message, toOptions( options ) ),
		info: ( message, options ) => void actions.createInfoNotice( message, toOptions( options ) ),
	};
}
