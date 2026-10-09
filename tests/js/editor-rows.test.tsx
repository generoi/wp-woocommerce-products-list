/**
 * Where the inline editor sits in the table (edit/editor-rows.ts), how
 * its cell takes the row (edit/editor-context.tsx) and how the fields
 * treat the editor row (hierarchy/hierarchical-dataviews.tsx).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import { getItemId, isEditorRow } from '../../resources/types';
import type { ProductField, ProductListItem } from '../../resources/types';
import { placeholder, simple, variation } from './edit-fixtures';

vi.mock( '../../resources/edit/inline-editor', () => ( {
	default: ( { host }: { host: EditorHost } ) => <p data-testid="editor">{ host.items.map( ( item ) => item.id ).join( ',' ) }</p>,
} ) );

const { EDITOR_ROW_ID, editorRow, findEditedRow, viewChangesRows, withEditorRow } = await import( '../../resources/edit/editor-rows' );
const { EditorHostProvider, InlineEditorCell, editorRegionLabel } = await import( '../../resources/edit/editor-context' );
const { withEditorRenders, withoutPlaceholderIds, isActionableRow } = await import( '../../resources/hierarchy/hierarchical-dataviews' );
const { focusOriginForRow } = await import( '../../resources/list/products-screen' );
const { setCurrentRows, getCurrentRows, resetCurrentRows } = await import( '../../resources/store/rows' );

const rows: ProductListItem[] = [ simple( 1 ), simple( 5, { type: 'variable', _hasChildren: true } ), variation( 11, 5 ), placeholder( 5 ), simple( 2 ) ];

describe( 'editorRow / withEditorRow', () => {
	it( 'puts a quick edit in the edited row\'s place, at its level', () => {
		const data = withEditorRow( rows, { mode: 'quick', id: 11, origin: null } );

		expect( data ).toHaveLength( rows.length );
		expect( data[ 2 ] ).toMatchObject( { id: EDITOR_ROW_ID, _kind: 'editor', _level: 1, _parentId: 5, _editor: { mode: 'quick', targetId: 11 } } );
		expect( isEditorRow( data[ 2 ]! ) ).toBe( true );
		expect( getItemId( data[ 2 ]! ) ).toBe( 'editor:11' );
		expect( data.filter( isEditorRow ) ).toHaveLength( 1 );
		expect( data[ 1 ] ).toBe( rows[ 1 ] );
	} );

	it( 'puts the bulk editor first', () => {
		const data = withEditorRow( rows, { mode: 'bulk', origin: null } );

		expect( data ).toHaveLength( rows.length + 1 );
		expect( data[ 0 ] ).toMatchObject( { _kind: 'editor', _level: 0, _parentId: null, _editor: { mode: 'bulk', targetId: null } } );
		expect( getItemId( data[ 0 ]! ) ).toBe( 'editor:bulk' );
		expect( data.slice( 1 ) ).toEqual( rows );
	} );

	it( 'leaves the rows alone without a session or when the edited row is not on screen', () => {
		expect( withEditorRow( rows, null ) ).toBe( rows );
		expect( withEditorRow( rows, { mode: 'quick', id: 999, origin: null } ) ).toBe( rows );
		expect( editorRow( { mode: 'quick', id: 999, origin: null }, rows ) ).toBeNull();
		// A placeholder row shares the parent's (negated) id space: never a target.
		expect( findEditedRow( rows, -5 ) ).toBeUndefined();
		expect( findEditedRow( rows, 5 ) ).toBe( rows[ 1 ] );
	} );

	it( 'is never a real row for the selection, the actions or getItems()', () => {
		expect( withoutPlaceholderIds( [ '1', 'editor:1', '5:loading', 'editor:bulk' ] ) ).toEqual( [ '1' ] );
		expect( isActionableRow( editorRow( { mode: 'bulk', origin: null }, rows )! ) ).toBe( false );

		setCurrentRows( withEditorRow( rows, { mode: 'bulk', origin: null } ) );
		expect( getCurrentRows().map( ( row ) => row.id ) ).toEqual( [ 1, 5, 11, 2 ] );
		resetCurrentRows();
	} );
} );

describe( 'viewChangesRows', () => {
	const base = { page: 1, perPage: 20, search: '', sort: { field: 'name', direction: 'asc' }, filters: [] };

	it( 'is true for page, page size, search, sort, filters and the layout type; false for column or density changes', () => {
		expect( viewChangesRows( base, { ...base, page: 2 } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, perPage: 50 } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, search: 'boot' } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, sort: { field: 'sku', direction: 'asc' } } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, sort: { field: 'name', direction: 'desc' } } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, filters: [ { field: 'status', value: 'draft' } ] } ) ).toBe( true );
		expect( viewChangesRows( base, { ...base, fields: [ 'sku' ], layout: { density: 'compact' } } as typeof base ) ).toBe( false );
		expect( viewChangesRows( { ...base, search: undefined }, { ...base, search: '' } ) ).toBe( false );
		// A layout switch takes the table (and its editor row) away: it goes through the leave guard.
		expect( viewChangesRows( { ...base, type: 'table' }, { ...base, type: 'grid' } ) ).toBe( true );
		expect( viewChangesRows( { ...base, type: 'table' }, { ...base, type: 'list' } ) ).toBe( true );
		expect( viewChangesRows( { ...base, type: undefined }, { ...base, type: 'table' } ) ).toBe( false );
	} );
} );

describe( 'withEditorRenders', () => {
	const Name = ( { item }: { item: ProductListItem } ) => <span>name:{ item.id }</span>;
	const Sku = ( { item }: { item: ProductListItem } ) => <span>sku:{ item.id }</span>;
	const fields = [
		{ id: 'name', label: 'Name', render: Name } as unknown as ProductField,
		{ id: 'sku', label: 'SKU', render: Sku } as unknown as ProductField,
		{ id: 'plain', label: 'Plain' } as unknown as ProductField,
	];
	const editor = editorRow( { mode: 'bulk', origin: null }, rows )!;

	it( 'renders the editor cell from the host field and nothing from the others, real rows as before', () => {
		const wrapped = withEditorRenders( fields, 'name' );
		const Render = ( field: ProductField, item: ProductListItem ) => {
			const Component = field.render as unknown as ( props: { item: ProductListItem; field: ProductField } ) => JSX.Element;

			return <Component item={ item } field={ field } />;
		};

		expect( wrapped[ 2 ] ).toBe( fields[ 2 ] );

		const { container, rerender } = render( Render( wrapped[ 1 ]!, editor ) );

		expect( container ).toBeEmptyDOMElement();

		rerender( Render( wrapped[ 1 ]!, rows[ 0 ]! ) );
		expect( container ).toHaveTextContent( 'sku:1' );

		// Without a host in context the editor cell renders nothing either (a stray editor row cannot crash the table).
		rerender( Render( wrapped[ 0 ]!, editor ) );
		expect( container ).toBeEmptyDOMElement();
	} );
} );

describe( 'InlineEditorCell', () => {
	function host( overrides: Partial< EditorHost > = {} ): EditorHost {
		return {
			session: { mode: 'bulk', origin: null },
			fields: [],
			items: [ simple( 1 ), simple( 2 ) ],
			offPageCount: 0,
			wholeList: false,
			close: vi.fn(),
			advance: vi.fn(),
			removeItem: vi.fn(),
			setGuard: vi.fn(),
			...overrides,
		};
	}

	it( 'names the region and stretches its cell over the row, hiding the sibling cells, also for cells added later', async () => {
		const editor = editorRow( { mode: 'bulk', origin: null }, rows )!;
		const { container, rerender } = render(
			<EditorHostProvider value={ host() }>
				<table>
					<tbody>
						<tr>
							<td className="dataviews-view-table__checkbox-column">x</td>
							<td>
								<InlineEditorCell item={ editor } />
							</td>
							<td>c</td>
						</tr>
					</tbody>
				</table>
			</EditorHostProvider>
		);

		const region = screen.getByRole( 'region', { name: 'Bulk edit: 2 items' } );
		const cell = region.closest( 'td' )!;
		const row = cell.parentElement!;

		expect( cell.colSpan ).toBe( 3 );
		expect( cell.classList.contains( 'wc-pl-editor-cell' ) ).toBe( true );
		expect( row.classList.contains( 'wc-pl-editor-row' ) ).toBe( true );
		expect( Array.from( row.children ).filter( ( child ) => ( child as HTMLElement ).hidden ).map( ( child ) => child.textContent ) ).toEqual( [ 'x', 'c' ] );
		// The chunk mounts into the cell.
		expect( await screen.findByTestId( 'editor' ) ).toHaveTextContent( '1,2' );

		rerender(
			<EditorHostProvider value={ host() }>
				<table>
					<tbody>
						<tr>
							<td className="dataviews-view-table__checkbox-column">x</td>
							<td>
								<InlineEditorCell item={ editor } />
							</td>
							<td>c</td>
							<td>d</td>
						</tr>
					</tbody>
				</table>
			</EditorHostProvider>
		);

		await waitFor( () => expect( cell.colSpan ).toBe( 4 ) );
		expect( container.querySelectorAll( 'td[hidden]' ) ).toHaveLength( 3 );
	} );

	it( 'labels a quick edit with the row\'s name', () => {
		const row = normalizeProduct( { id: 3, name: 'Blue boots' } );

		expect( editorRegionLabel( { session: { mode: 'quick', id: 3, origin: null }, items: [ row ] } ) ).toBe( 'Quick edit: Blue boots' );
		expect( editorRegionLabel( { session: { mode: 'bulk', origin: null }, items: [ row ] } ) ).toBe( 'Bulk edit: 1 item' );
	} );
} );

describe( 'focusOriginForRow', () => {
	it( 'remembers the row\'s position in the table body, so focus can return to its actions button', () => {
		document.body.innerHTML = '<table class="dataviews-view-table"><tbody><tr><td><div id="wc-pl-row-1"></div></td></tr><tr><td><div id="wc-pl-row-7"></div><button>Actions</button></td></tr></tbody></table>';

		expect( focusOriginForRow( simple( 7 ) ) ).toMatchObject( { rowIndex: 1, label: null } );
		expect( focusOriginForRow( simple( 99 ) ).rowIndex ).toBeNull();
		document.body.innerHTML = '';
	} );
} );
