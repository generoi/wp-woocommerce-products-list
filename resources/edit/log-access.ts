import { getSettings } from '../settings';

/**
 * Whether this user may use the change log (History, Undo, Revert): the log
 * routes need `wc_products_list/log_capability` (caps.viewLog). Settings
 * without the key (older servers) allow it.
 */
export function canUndo(): boolean {
	try {
		return getSettings().caps.viewLog !== false;
	} catch {
		return true;
	}
}
