import { Button, SnackbarList } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { store as noticesStore } from '@wordpress/notices';

type StoredNotice = ReturnType< ReturnType< typeof useSelect >[ 'getNotices' ] >[ number ];
type Snackbar = StoredNotice & { explicitDismiss?: boolean; status?: string };

/**
 * Snackbars shown at once; the oldest go when a newer one arrives (their
 * batches stay revertable in History).
 */
export const MAX_SNACKBARS = 3;

/** How long a snackbar with an action (Undo) stays, in ms, not counting time under the pointer or focus. */
export const ACTION_TIMEOUT = 10000;

/**
 * Undo notices of destructive actions (Move to Trash) by id prefix: they
 * stay until dismissed or superseded by a newer Undo, not ACTION_TIMEOUT,
 * since History cannot put a trashed batch back. (A notice may also ask
 * for this itself with `explicitDismiss: true`.)
 */
export const STICKY_UNDO_PREFIXES: readonly string[] = [ 'wc-pl-trash-' ];

/**
 * Id prefix of a save outcome that is the only record on screen of what
 * failed or was held back (a background save, its panel closed): one id per
 * save, so a later save's notice does not replace it, and it is neither
 * superseded by a newer Undo nor dropped by the cap (overflowingNotices).
 */
export const OUTCOME_NOTICE_PREFIX = 'wc-pl-outcome-';

let outcomeSerial = 0;

/** The id of a save's durable outcome notice: its batch id, or a fresh one when it has none. */
export function outcomeNoticeId( batchId: string | undefined ): string {
	outcomeSerial += 1;

	return `${ OUTCOME_NOTICE_PREFIX }${ batchId || `local-${ outcomeSerial }` }`;
}

function isOutcome( notice: NoticeLike ): boolean {
	return notice.id.startsWith( OUTCOME_NOTICE_PREFIX );
}

/** How long a plain snackbar stays, in ms (core's own snackbar timeout). */
export const PLAIN_TIMEOUT = 6000;

interface NoticeLike {
	id: string;
	status?: string;
	actions?: unknown[];
	explicitDismiss?: boolean;
}

function hasActions( notice: NoticeLike ): boolean {
	return Array.isArray( notice.actions ) && notice.actions.length > 0;
}

/**
 * How long a snackbar stays before it hides itself, or null when it stays
 * until dismissed: an error (it names what failed), or a notice its creator
 * asked to keep (`explicitDismiss: true`), or the Undo of a destructive
 * action (STICKY_UNDO_PREFIXES). Another success with an Undo hides after
 * ACTION_TIMEOUT; the Undo stays reachable from History.
 */
export function snackbarTimeout( notice: NoticeLike ): number | null {
	if ( notice.explicitDismiss === true || notice.status === 'error' ) {
		return null;
	}

	if ( hasActions( notice ) && STICKY_UNDO_PREFIXES.some( ( prefix ) => notice.id.startsWith( prefix ) ) ) {
		return null;
	}

	return hasActions( notice ) ? ACTION_TIMEOUT : PLAIN_TIMEOUT;
}

/**
 * The ids of snackbars to drop: older Undo-style notices once a newer one
 * is shown (a stray click on an old Undo must not revert an earlier
 * campaign), then the oldest beyond the cap. The store lists notices
 * oldest first. Notices that stay until dismissed are never dropped and do
 * not count toward the cap: errors (they name what failed), notices asked
 * to stay (`explicitDismiss`, e.g. "Reverting…") and save outcomes
 * (OUTCOME_NOTICE_PREFIX). Errors and save outcomes are not superseded
 * either; a sticky success Undo (Move to Trash) still is.
 */
export function overflowingNotices< T extends NoticeLike >( notices: T[], max: number = MAX_SNACKBARS ): string[] {
	const actionable = notices.filter( ( notice ) => hasActions( notice ) && notice.status !== 'error' && ! isOutcome( notice ) );
	const superseded = new Set( actionable.slice( 0, -1 ).map( ( notice ) => notice.id ) );
	const capped = notices.filter( ( notice ) => ! superseded.has( notice.id ) && notice.status !== 'error' && notice.explicitDismiss !== true && ! isOutcome( notice ) );
	const overflow = capped.length > max ? capped.slice( 0, capped.length - max ).map( ( notice ) => notice.id ) : [];

	return [ ...superseded, ...overflow ];
}

export interface DismissTimers {
	/** Start timers for new notices, forget removed ones. */
	sync( notices: Array< { id: string; timeout: number | null } > ): void;
	pause(): void;
	resume(): void;
	dispose(): void;
}

/**
 * Per-notice auto-dismiss timers that pause together (while the pointer is
 * over the snackbars or focus is inside them) and resume with the time that
 * was left. Core's Snackbar timeout cannot pause, so every snackbar is
 * rendered with `explicitDismiss` (a close button, no click-anywhere
 * dismiss) and expires through these timers instead.
 */
export function createDismissTimers( onExpire: ( id: string ) => void, now: () => number = () => Date.now() ): DismissTimers {
	const timers = new Map< string, { remaining: number; startedAt: number; handle: ReturnType< typeof setTimeout > | null } >();
	let paused = false;

	const start = ( id: string ) => {
		const timer = timers.get( id );

		if ( ! timer ) {
			return;
		}

		timer.startedAt = now();
		timer.handle = setTimeout( () => {
			timers.delete( id );
			onExpire( id );
		}, timer.remaining );
	};

	const stop = ( id: string ) => {
		const timer = timers.get( id );

		if ( timer?.handle ) {
			clearTimeout( timer.handle );
			timer.remaining = Math.max( 0, timer.remaining - ( now() - timer.startedAt ) );
			timer.handle = null;
		}
	};

	return {
		sync( notices ) {
			const ids = new Set( notices.map( ( notice ) => notice.id ) );

			for ( const id of Array.from( timers.keys() ) ) {
				if ( ! ids.has( id ) ) {
					stop( id );
					timers.delete( id );
				}
			}

			for ( const notice of notices ) {
				if ( notice.timeout === null || timers.has( notice.id ) ) {
					continue;
				}

				timers.set( notice.id, { remaining: notice.timeout, startedAt: now(), handle: null } );

				if ( ! paused ) {
					start( notice.id );
				}
			}
		},
		pause() {
			if ( paused ) {
				return;
			}

			paused = true;
			timers.forEach( ( _timer, id ) => stop( id ) );
		},
		resume() {
			if ( ! paused ) {
				return;
			}

			paused = false;
			timers.forEach( ( _timer, id ) => start( id ) );
		},
		dispose() {
			timers.forEach( ( timer ) => timer.handle && clearTimeout( timer.handle ) );
			timers.clear();
		},
	};
}

interface NoticeAction {
	label: string;
	onClick?: () => void;
	url?: string;
	/** Clicking it leaves the notice up (core's Snackbar removes it on a click of its own action). */
	keepsNotice?: boolean;
}

/**
 * Core's Snackbar renders only its first action, and removes the notice
 * when it is clicked. The rest (Undo plus "View in History") go into the
 * content as link buttons, so no action is lost; so does an action that
 * keeps the notice (`keepsNotice`: "Select the 2 failed", whose message the
 * user still needs after selecting).
 */
export function withExtraActions< N extends { content?: unknown; actions?: unknown[] } >( notice: N ): N {
	const actions = ( Array.isArray( notice.actions ) ? notice.actions : [] ) as NoticeAction[];
	const first = actions.find( ( action ) => ! action.keepsNotice );

	if ( actions.length < 2 && ! actions.some( ( action ) => action.keepsNotice ) ) {
		return notice;
	}

	const rest = actions.filter( ( action ) => action !== first );

	return {
		...notice,
		actions: first ? [ first ] : [],
		content: (
			<>
				{ notice.content as string }
				{ rest.map( ( action ) => (
					<Button
						key={ action.label }
						variant="link"
						className="wc-products-list__notice-action"
						href={ action.url }
						onClick={ ( event: { stopPropagation(): void } ) => {
							event.stopPropagation();
							action.onClick?.();
						} }
					>
						{ action.label }
					</Button>
				) ) }
			</>
		),
	};
}

/** The CSS custom property the list pads its bottom with, so the last rows scroll clear of the snackbars. */
export const NOTICES_HEIGHT_VAR = '--wc-pl-notices-height';

/** The snackbar stack of the core/notices store, bottom-left like the editor. */
export function Notices() {
	const notices = useSelect( ( select ) => select( noticesStore ).getNotices(), [] );
	const { removeNotice } = useDispatch( noticesStore );
	const snackbars = useMemo( () => ( notices as Snackbar[] ).filter( ( notice ) => notice.type === 'snackbar' ), [ notices ] );
	const overflow = overflowingNotices( snackbars ).join( ',' );
	const removeRef = useRef( removeNotice );
	const hasSnackbars = snackbars.length > 0;
	const [ timers ] = useState( () => createDismissTimers( ( id ) => void removeRef.current( id ) ) );
	const hoveredRef = useRef( false );
	const focusedRef = useRef( false );
	const containerRef = useRef< HTMLDivElement >( null );

	useEffect( () => {
		removeRef.current = removeNotice;
	}, [ removeNotice ] );

	useEffect( () => () => timers.dispose(), [ timers ] );

	useEffect( () => {
		if ( overflow ) {
			overflow.split( ',' ).forEach( ( id ) => void removeNotice( id ) );
		}
	}, [ overflow, removeNotice ] );

	useEffect( () => {
		timers.sync( snackbars.map( ( notice ) => ( { id: notice.id, timeout: snackbarTimeout( notice ) } ) ) );
	}, [ snackbars, timers ] );

	// Pad the list by the stack's height so it never covers the bottom row's controls.
	useLayoutEffect( () => {
		const root = typeof document !== 'undefined' ? document.documentElement : null;
		const node = containerRef.current;

		if ( ! root ) {
			return undefined;
		}

		if ( ! node ) {
			root.style.removeProperty( NOTICES_HEIGHT_VAR );

			return undefined;
		}

		const update = () => root.style.setProperty( NOTICES_HEIGHT_VAR, `${ Math.ceil( node.getBoundingClientRect().height ) }px` );
		update();

		if ( typeof ResizeObserver === 'undefined' ) {
			return () => root.style.removeProperty( NOTICES_HEIGHT_VAR );
		}

		const observer = new ResizeObserver( update );
		observer.observe( node );

		return () => {
			observer.disconnect();
			root.style.removeProperty( NOTICES_HEIGHT_VAR );
		};
	}, [ hasSnackbars ] );

	if ( ! snackbars.length ) {
		return null;
	}

	const sync = () => ( hoveredRef.current || focusedRef.current ? timers.pause() : timers.resume() );

	return (
		<div
			ref={ containerRef }
			className="wc-products-list__notices"
			onMouseEnter={ () => {
				hoveredRef.current = true;
				sync();
			} }
			onMouseLeave={ () => {
				hoveredRef.current = false;
				sync();
			} }
			onFocus={ () => {
				focusedRef.current = true;
				sync();
			} }
			onBlur={ ( event ) => {
				if ( ! event.currentTarget.contains( event.relatedTarget as Node | null ) ) {
					focusedRef.current = false;
					sync();
				}
			} }
		>
			<SnackbarList notices={ snackbars.map( ( notice ) => withExtraActions( { ...notice, explicitDismiss: true } ) ) as typeof snackbars } onRemove={ removeNotice } />
		</div>
	);
}
