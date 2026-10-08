/**
 * The inline editor's host side, in the main bundle: the screen provides an
 * EditorHost (the session, the rows it edits, close/advance/remove, the
 * leave guard), and the name field renders `InlineEditorCell` into the
 * editor row. The cell stretches its `<td>` over the whole row (colSpan +
 * `hidden` on the sibling cells: DataViews sets neither, and the row
 * unmounts whole on close) and mounts the editor chunk on first use.
 */
import { Spinner } from '@wordpress/components';
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

/** What the name field renders for the editor row. */
export function InlineEditorCell( { item }: { item: ProductListItem } ) {
	const host = useEditorHost();
	const ref = useRef< HTMLDivElement >( null );

	useEditorRowSpan( ref );

	if ( ! host || ! item._editor ) {
		return null;
	}

	return (
		<div ref={ ref } className={ `wc-pl-inline-edit-host is-${ host.session.mode } is-level-${ item._level }` } role="region" aria-label={ editorRegionLabel( host ) }>
			<Suspense
				fallback={
					<div className="wc-pl-inline-edit__loading" role="status">
						<Spinner /> { __( 'Opening the editor…', 'wp-woocommerce-products-list' ) }
					</div>
				}
			>
				<InlineEditor host={ host } />
			</Suspense>
		</div>
	);
}
