/**
 * The inline editor's host side, in the main bundle: the screen provides an
 * EditorHost (the session, the rows it edits, close/advance/remove, the
 * leave guard), and the name field renders `InlineEditorCell` into the
 * editor row. The cell stretches its `<td>` over the whole row (colSpan +
 * `hidden` on the sibling cells: DataViews sets neither, and the row
 * unmounts whole on close) and mounts the editor chunk on first use.
 */
import { Button, Notice, Spinner } from '@wordpress/components';
import { ErrorBoundary } from '../ui/error-boundary';
import { createContext, lazy, Suspense, useContext, useLayoutEffect, useRef } from '@wordpress/element';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { ProductField, ProductListItem } from '../types';
import type { EditorSession } from './editor-rows';

/** Resolves true when the editor may close (clean, or the user discarded); false to stay. */
export type LeaveGuard = () => Promise< boolean >;

export interface EditorHost {
	session: EditorSession;
	/** The full field registry; the editor picks what applies. */
	fields: ProductField[];
	/** The edited row (quick), or the live selection (bulk). */
	items: ProductListItem[];
	/** Bulk: how many of `items` are on other pages. */
	offPageCount: number;
	/** Bulk: the selection is every product of the current list ("Select all"). */
	wholeList: boolean;
	close(): void;
	/** "Save & next": reopen on another row. */
	advance( row: ProductListItem ): void;
	/** Bulk: untick one row from the editor's list. */
	removeItem( id: number ): void;
	/** The editor installs its discard-confirm here; the screen asks it before paging, sorting, filtering or opening another editor. */
	setGuard( guard: LeaveGuard | null ): void;
	/** The editor reports a running save: the screen keeps it mounted until the save is done. Optional for older hosts. */
	setBusy?( busy: boolean ): void;
}

const EditorContext = createContext< EditorHost | null >( null );

export const EditorHostProvider = EditorContext.Provider;

export function useEditorHost(): EditorHost | null {
	return useContext( EditorContext );
}

/**
 * The editor (DataForm glue, numeric ops, save flow) loads on first use as
 * its own chunk: the list page stays under the size budget and most visits
 * never open it. Its stylesheet ships with the main bundle (actions/quick-edit.tsx).
 */
const InlineEditor = lazy( () => import( /* webpackChunkName: "edit" */ './inline-editor' ) );

/** The accessible name of the editor region: "Quick edit: Blue boots" / "Bulk edit: 12 items". */
export function editorRegionLabel( host: Pick< EditorHost, 'session' | 'items' > ): string {
	if ( host.session.mode === 'bulk' ) {
		/* translators: %d: number of rows */
		return sprintf( _n( 'Bulk edit: %d item', 'Bulk edit: %d items', host.items.length, 'wp-woocommerce-products-list' ), host.items.length );
	}

	const row = host.items[ 0 ];
	const name = ( row as { name?: string } | undefined )?.name || ( row ? `#${ row.id }` : '' );

	/* translators: %s: product name */
	return sprintf( __( 'Quick edit: %s', 'wp-woocommerce-products-list' ), name );
}

/**
 * Stretch the host cell over the row. Re-applied when the row's cells
 * change (a column shown while the editor is open adds a `<td>`).
 */
export function useEditorRowSpan( ref: React.RefObject< HTMLElement | null > ): void {
	useLayoutEffect( () => {
		const cell = ref.current?.closest( 'td' );
		const row = cell?.parentElement;

		if ( ! cell || ! row ) {
			return;
		}

		const apply = () => {
			const cells = Array.from( row.children ) as HTMLTableCellElement[];

			row.classList.add( 'wc-pl-editor-row' );
			cell.classList.add( 'wc-pl-editor-cell' );
			cell.colSpan = Math.max( 1, cells.length );

			for ( const sibling of cells ) {
				if ( sibling !== cell && ! sibling.hidden ) {
					sibling.hidden = true;
				}
			}
		};

		apply();

		const observer = new MutationObserver( apply );

		observer.observe( row, { childList: true } );

		return () => observer.disconnect();
	}, [ ref ] );
}

/** The nearest ancestor that scrolls sideways (the table's wrapper), or null. */
export function horizontalScroller( from: HTMLElement | null ): HTMLElement | null {
	let node = from?.parentElement ?? null;

	while ( node && node !== document.body ) {
		const overflow = window.getComputedStyle( node ).overflowX;

		if ( overflow === 'auto' || overflow === 'scroll' ) {
			return node;
		}

		node = node.parentElement;
	}

	return null;
}

/**
 * Keep the editor inside the visible part of the table. The editor's cell
 * spans the whole table, which a few wide columns make wider than its
 * scrolling wrapper; laid out at that width the right-hand column is cut
 * off, and focusing a field there scrolls the wrapper sideways (the item
 * list and the Name column leave the screen, and stay out after Update).
 * The host is sized to the wrapper's visible width and sticks to its left
 * edge; the wrapper is scrolled back to the start when the editor opens
 * and when it closes.
 */
export function useEditorFitsScroller( ref: React.RefObject< HTMLElement | null > ): void {
	useLayoutEffect( () => {
		const host = ref.current;
		const cell = host?.closest( 'td' ) ?? null;
		const scroller = horizontalScroller( cell );

		if ( ! host || ! cell || ! scroller ) {
			return;
		}

		const fit = () => {
			const style = window.getComputedStyle( cell );
			const left = parseFloat( style.paddingLeft ) || 0;
			const right = parseFloat( style.paddingRight ) || 0;
			const width = scroller.clientWidth - left - right;

			if ( width > 0 ) {
				host.style.setProperty( '--wc-pl-editor-width', `${ width }px` );
				host.style.setProperty( '--wc-pl-editor-left', `${ left }px` );
				host.classList.add( 'is-fitted' );
			}
		};

		fit();
		scroller.scrollLeft = 0;

		const observer = typeof ResizeObserver === 'function' ? new ResizeObserver( fit ) : null;

		observer?.observe( scroller );

		return () => {
			observer?.disconnect();
			// The row the editor stood in comes back where it was, Name column and checkboxes in view.
			scroller.scrollLeft = 0;
		};
	}, [ ref ] );
}

/** What the name field renders for the editor row. */
export function InlineEditorCell( { item }: { item: ProductListItem } ) {
	const host = useEditorHost();
	const ref = useRef< HTMLDivElement >( null );

	useEditorRowSpan( ref );
	useEditorFitsScroller( ref );

	if ( ! host || ! item._editor ) {
		return null;
	}

	return (
		<div ref={ ref } className={ `wc-pl-inline-edit-host is-${ host.session.mode } is-level-${ item._level }` } role="region" aria-label={ editorRegionLabel( host ) }>
			<ErrorBoundary
				context="editor"
				fallback={ ( { isChunkError, retry } ) => (
					<Notice status="error" isDismissible={ false } className="wc-pl-inline-edit__failed">
						{ isChunkError
							? __( 'The editor could not be loaded. The plugin may have been updated, or the connection dropped.', 'wp-woocommerce-products-list' )
							: __( 'Something went wrong in the editor.', 'wp-woocommerce-products-list' ) }{ ' ' }
						{ isChunkError ? (
							<Button variant="link" onClick={ () => window.location.reload() }>
								{ __( 'Reload the page', 'wp-woocommerce-products-list' ) }
							</Button>
						) : (
							<Button variant="link" onClick={ retry }>
								{ __( 'Try again', 'wp-woocommerce-products-list' ) }
							</Button>
						) }{ ' ' }
						<Button variant="secondary" size="compact" onClick={ () => host.close() }>
							{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
						</Button>
					</Notice>
				) }
			>
				<Suspense
					fallback={
						<div className="wc-pl-inline-edit__loading" role="status">
							<Spinner /> { __( 'Opening the editor…', 'wp-woocommerce-products-list' ) }
						</div>
					}
				>
					<InlineEditor host={ host } />
				</Suspense>
			</ErrorBoundary>
		</div>
	);
}
