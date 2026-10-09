/**
 * The screen's editor mount (list/products-screen.tsx EditorMount): the
 * session lives in a store outside the screen's state, the mount builds the
 * host from it, and a session whose row left the list closes.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { ProductListItem, ProductRow } from '../../resources/types';
import { simple } from './edit-fixtures';

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };

vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/edit/inline-editor', () => ( {
	default: ( { host }: { host: EditorHost } ) => <p data-testid="editor">{ host.items.map( ( item ) => item.id ).join( ',' ) }</p>,
} ) );

const { EditorMount, createSessionStore } = await import( '../../resources/list/products-screen' );

const rows = [ simple( 1 ), simple( 2 ) ] as ProductListItem[];

function mount( store: ReturnType< typeof createSessionStore >, shown: ProductListItem[], selectedRows: ProductListItem[] = [] ) {
	return (
		<EditorMount
			store={ store }
			fields={ [] }
			rows={ shown }
			childrenState={ new Map() }
			parents={ shown as ProductRow[] }
			selected={ { rows: selectedRows, offPageCount: 0 } }
			listTotal={ shown.length }
			advance={ vi.fn() }
			removeItem={ vi.fn() }
			setGuard={ vi.fn() }
		/>
	);
}

describe( 'EditorMount', () => {
	it( 'shows the panel for the store\'s session and closes a quick edit whose row left the list', async () => {
		const store = createSessionStore();
		const view = render( mount( store, rows ) );

		expect( screen.queryByRole( 'region' ) ).toBeNull();

		act( () => store.set( { mode: 'quick', id: 2, origin: null } ) );
		expect( screen.getByRole( 'region', { name: 'Quick edit: Simple 2' } ) ).toBeInTheDocument();
		expect( await screen.findByTestId( 'editor' ) ).toHaveTextContent( '2' );

		// The row was trashed: the list no longer has it.
		view.rerender( mount( store, [ rows[ 0 ]! ] ) );
		expect( store.get() ).toBeNull();
		expect( screen.queryByRole( 'region' ) ).toBeNull();
		expect( notify.info ).toHaveBeenCalledWith( expect.stringContaining( 'no longer in the list' ) );
	} );

	it( 'follows the live selection for a bulk edit and closes when it empties', () => {
		const store = createSessionStore();
		const view = render( mount( store, rows, rows ) );

		act( () => store.set( { mode: 'bulk', origin: null } ) );
		expect( screen.getByRole( 'region', { name: 'Bulk edit: 2 items' } ) ).toBeInTheDocument();

		view.rerender( mount( store, rows, [ rows[ 1 ]! ] ) );
		expect( screen.getByRole( 'region', { name: 'Bulk edit: 1 item' } ) ).toBeInTheDocument();

		view.rerender( mount( store, rows, [] ) );
		expect( store.get() ).toBeNull();
		expect( screen.queryByRole( 'region' ) ).toBeNull();
	} );

	it( 'notifies subscribers only when the session changes', () => {
		const store = createSessionStore();
		const listener = vi.fn();
		const unsubscribe = store.subscribe( listener );
		const session = { mode: 'bulk' as const, origin: null };

		store.set( session );
		store.set( session );
		store.set( null );
		unsubscribe();
		store.set( session );

		expect( listener ).toHaveBeenCalledTimes( 2 );
	} );
} );
