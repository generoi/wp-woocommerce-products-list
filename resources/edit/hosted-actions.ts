/**
 * Which extension actions the editor hosts instead of the action menu: an
 * action in a group with a `lang` select is a per-language tool of the
 * editor's `group:lang` tabs (edit/language-tools.tsx). Kept apart from the
 * component so the main bundle's action list can ask without loading it.
 */
import type { DeclarativeAction } from '../types';

/** The `lang` argument that makes an action a per-language tool. */
export const LANG_ARG = 'lang';

/** Whether the editor's language tabs host this action (and the action menu leaves it out). */
export function isEditorHostedAction( def: DeclarativeAction ): boolean {
	return Boolean( def.group ) && def.args.some( ( arg ) => arg.id === LANG_ARG && arg.type === 'select' );
}
