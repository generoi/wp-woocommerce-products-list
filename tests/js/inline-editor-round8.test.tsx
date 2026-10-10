/**
 * Round 8: term fields are typed and suggested by name and keep ids (a typed
 * name is never saved as `{id: null}`), a taken SKU names its owner and flags
 * the SKU field, "Update & next" shows its shortcut, and removing an item from
 * the bulk list keeps the keyboard focus in the list.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataFormControlProps } from '../../resources/dataviews';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { FormData } from '../../resources/edit/form-fields';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, field, simple } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { subscribeDeleted: () => () => {}, patchItems: vi.fn(), removeItems: vi.fn(), invalidateProducts: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn( async () => ( { items: [], total: 0, totalPages: 1 } ) ),
	listProducts: vi.fn( async ( query: Record< string, unknown > ) => ( {
		items: String( query.include )
			.split( ',' )
			.map( ( id ) => simple( Number( id ), { name: `Row ${ id }`, sku: `S-${ id }` } ) ),
		total: 0,
		totalPages: 1,
	} ) ),
	newBatchId: vi.fn( () => 'batch-8' ),
	runAction: vi.fn(),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const { createTermTokensControl, termTokenMaps, tokensToIds } = await import( '../../resources/edit/term-tokens-control' );
const { toFormFields } = await import( '../../resources/edit/form-fields' );
const { mergeItems } = await import( '../../resources/edit/merge' );
const { fieldOfErrorCode, humanizeError } = await import( '../../resources/edit/errors' );
const { setCurrentRows, resetCurrentRows } = await import( '../../resources/store/rows' );

const TERMS = [
	{ value: '102', label: 'Ballerinat' },
	{ value: '15', label: 'Chelsea boots' },
	{ value: '200', label: 'Droppi' },
	{ value: '201', label: 'Droppi' },
	{ value: '7', label: 'Kids &amp; Teens' },
];

function hostFor( items: ProductListItem[], fields: ReturnType< typeof coreFields >, session: Partial< EditorSession > = {} ): EditorHost {
	const base: EditorSession = items.length > 1 ? { mode: 'bulk', origin: null } : { mode: 'quick', id: items[ 0 ]?.id ?? 0, origin: null };

	return {
		session: { ...base, ...session } as EditorSession,
		fields,
		items,
		offPageCount: 0,
		wholeList: false,
		close: vi.fn(),
		advance: vi.fn(),
		removeItem: vi.fn(),
		setGuard: vi.fn(),
	};
}

afterEach( () => {
	vi.clearAllMocks();
	resetCurrentRows();
} );

describe( 'term tokens by name', () => {
	it( 'maps names to ids both ways, case-insensitively, telling apart terms that share a name', () => {
		const maps = termTokenMaps( TERMS );

		expect( maps.suggestions ).toEqual( [ 'Ballerinat', 'Chelsea boots', 'Droppi (#200)', 'Droppi (#201)', 'Kids & Teens' ] );
		expect( tokensToIds( [ 'ballerinat', 'Droppi (#201)', 'Kids & Teens' ], maps, [] ) ).toEqual( [ '102', '201', '7' ] );
		// A typed name that is no term, or an id typed as text, never becomes a token.
		expect( tokensToIds( [ 'Droppi', 'Nope', '15' ], maps, [] ) ).toEqual( [] );
		// A term the list does not know (shown as its id) stays when it was already there.
		expect( tokensToIds( [ '999', 'Ballerinat' ], maps, [ '999' ] ) ).toEqual( [ '999', '102' ] );
	} );

	it( 'suggests by name (not by id) and refuses a typed name that is not a term', async () => {
		const Control = createTermTokensControl();
		const onChange = vi.fn();
		const formField = {
			id: 'categories',
			label: 'Categories',
			elements: TERMS,
			getValue: ( { item }: { item: FormData } ) => item.categories,
			setValue: ( { value }: { value: unknown } ) => ( { categories: value } ),
			isDisabled: () => false,
		} as unknown as DataFormControlProps< FormData >[ 'field' ];

		render( <Control data={ { categories: [ '15' ] } } field={ formField } onChange={ onChange } /> );

		// The row's term shows by name.
		expect( screen.getByText( 'Chelsea boots' ) ).toBeInTheDocument();

		const input = screen.getByRole( 'combobox', { name: 'Categories' } );

		fireEvent.change( input, { target: { value: 'Bal' } } );
		expect( await screen.findByRole( 'option', { name: 'Ballerinat' } ) ).toBeInTheDocument();

		// Typing an id finds nothing.
		fireEvent.change( input, { target: { value: '1' } } );
		expect( screen.queryByRole( 'option', { name: 'Ballerinat' } ) ).not.toBeInTheDocument();

		// A name that is no term, confirmed with Enter, is refused: nothing changes.
		fireEvent.change( input, { target: { value: 'Nonexistent' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( onChange ).not.toHaveBeenCalled();

		// A term's name typed in full and confirmed with Enter adds its id.
		fireEvent.change( input, { target: { value: 'ballerinat' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		await waitFor( () => expect( onChange ).toHaveBeenCalledWith( { categories: [ '15', '102' ] } ) );
	} );

	it( 'the form field uses the name control and never keeps a non-id token', () => {
		const categories = field( 'categories', {
			type: 'array',
			getElements: async () => TERMS,
			getValue: ( { item } ) => ( ( item as { categories?: Array< { id: number } > } ).categories ?? [] ).map( ( term ) => term.id ) as unknown as string[],
			edit: { group: 'organization', bulk: 'default' },
		} );
		const item = simple( 1, { categories: [ { id: 15, name: 'Chelsea boots' } ] } );
		const merged = mergeItems( [ item ], [ categories ] );
		const [ form ] = toFormFields( [ categories ], { bulk: false, items: [ item ], base: merged.data, mixed: merged.mixed, settings } );

		expect( form!.Edit ).toBeTypeOf( 'function' );
		expect( form!.setValue!( { item: merged.data, value: [ '15', 'Droppi', '102', '0' ] } ) ).toEqual( { categories: [ 15, 102 ] } );
	} );
} );

describe( 'SKU errors', () => {
	it( 'keeps the server message that names the owner and ties the code to the SKU field', () => {
		expect( humanizeError( 'product_invalid_sku', 'The SKU "4002092500457" is already used by "Collonil Organic Cover" (#206).' ) ).toBe( 'The SKU "4002092500457" is already used by "Collonil Organic Cover" (#206).' );
		expect( humanizeError( 'product_invalid_sku', 'Invalid or duplicated SKU.' ) ).toBe( 'This SKU is already used by another product.' );
		expect( fieldOfErrorCode( 'product_invalid_sku' ) ).toBe( 'sku' );
		expect( fieldOfErrorCode( 'woocommerce_rest_product_invalid_id' ) ).toBeUndefined();
	} );

	it( 'a quick edit failing on the SKU flags the SKU input and links the problem to it', async () => {
		const fields = coreFields().filter( ( entry ) => [ 'name', 'sku' ].includes( entry.id ) );
		const message = 'The SKU "X1" is already used by "Other" (#206).';

		saveEdits.mockResolvedValueOnce( { updated: [], errors: [ { id: 1, code: 'product_invalid_sku', message } ], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		render( <InlineEditor host={ hostFor( [ simple( 1, { name: 'Row 1', sku: 'S-1' } ) ], fields ) } /> );

		const sku = await screen.findByLabelText( 'sku' );

		fireEvent.change( sku, { target: { value: 'X1' } } );
		fireEvent.click( screen.getByRole( 'button', { name: /^Update/ } ) );

		await screen.findAllByText( message );
		await waitFor( () => expect( screen.getByLabelText( 'sku' ) ).toHaveAttribute( 'aria-invalid', 'true' ) );

		const describedBy = screen.getByLabelText( 'sku' ).getAttribute( 'aria-describedby' ) ?? '';

		expect( describedBy.split( ' ' ).map( ( id ) => document.getElementById( id )?.textContent ) ).toContain( message );

		// The problem list names the field as a button that moves focus to it.
		fireEvent.click( screen.getByRole( 'button', { name: 'sku' } ) );
		await waitFor( () => expect( document.activeElement ).toBe( screen.getByLabelText( 'sku' ) ) );
	} );
} );

describe( 'a refused duplicate SKU in History', () => {
	it( 'posts no second "failed" row for an error the server logged itself', async () => {
		const client = await import( '../../resources/api/client' );
		const logSkipped = client.logSkipped as unknown as ReturnType< typeof vi.fn >;
		const fields = coreFields().filter( ( entry ) => [ 'name', 'sku' ].includes( entry.id ) );
		const message = 'The SKU "X1" is already used by "Other" (#206).';

		logSkipped.mockClear();
		saveEdits.mockResolvedValueOnce( { updated: [], errors: [ { id: 1, code: 'product_invalid_sku', message, logged: true } ], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		render( <InlineEditor host={ hostFor( [ simple( 1, { name: 'Row 1', sku: 'S-1' } ) ], fields ) } /> );
		fireEvent.change( await screen.findByLabelText( 'sku' ), { target: { value: 'X1' } } );
		fireEvent.click( screen.getByRole( 'button', { name: /^Update/ } ) );
		await screen.findAllByText( message );

		expect( logSkipped ).not.toHaveBeenCalled();
	} );
} );

describe( 'keyboard', () => {
	it( '"Update & next" announces and shows its shortcut', async () => {
		const fields = coreFields().filter( ( entry ) => entry.id === 'name' );

		setCurrentRows( [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ) ] );
		render( <InlineEditor host={ hostFor( [ simple( 1, { name: 'One' } ) ], fields ) } /> );

		const next = await screen.findByRole( 'button', { name: 'Update & next' } );

		expect( next ).toHaveAttribute( 'aria-keyshortcuts', 'Shift+Enter' );
		expect( next.querySelector( 'kbd' )?.textContent ).toBe( 'Shift+Enter' );
	} );

	it( 'removing an item from the bulk list moves focus to the x now in its place, then to the last one', async () => {
		const fields = coreFields().filter( ( entry ) => entry.id === 'name' );
		const rows = [ simple( 1, { name: 'One' } ), simple( 2, { name: 'Two' } ), simple( 3, { name: 'Three' } ) ];
		const host = hostFor( rows, fields );
		const view = render( <InlineEditor host={ host } /> );

		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		fireEvent.click( screen.getByRole( 'button', { name: 'Remove Row 2 from the selection' } ) );
		expect( host.removeItem ).toHaveBeenCalledWith( 2 );

		await act( async () => {
			view.rerender( <InlineEditor host={ { ...host, items: [ rows[ 0 ]!, rows[ 2 ]! ] } } /> );
		} );
		expect( document.activeElement ).toBe( screen.getByRole( 'button', { name: 'Remove Row 3 from the selection' } ) );

		fireEvent.click( screen.getByRole( 'button', { name: 'Remove Row 3 from the selection' } ) );
		await act( async () => {
			view.rerender( <InlineEditor host={ { ...host, items: [ rows[ 0 ]! ] } } /> );
		} );
		await waitFor( () => expect( document.activeElement ).not.toBe( document.body ) );
	} );
} );
