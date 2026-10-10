/**
 * Layout round 2: a quick edit of a variable product runs a price campaign on
 * all its variations with the bulk operations; the apply box goes when every
 * variation is selected anyway; a variable product's stock status, which
 * WooCommerce derives from its variations, is never offered or sent.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { EditorSession } from '../../resources/edit/editor-session';
import type { ProductListItem } from '../../resources/types';
import { coreFields, editSettings, field, simple, variable, variation } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };
const saveEdits = vi.fn();

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { subscribeDeleted: () => () => {}, patchItems: vi.fn(), removeItems: vi.fn(), invalidateProducts: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn(),
	listProducts: vi.fn(),
	newBatchId: vi.fn( () => 'batch-shared' ),
	runAction: vi.fn(),
	closeBatch: vi.fn( async () => undefined ),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: ( ...args: unknown[] ) => saveEdits( ...args ) } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const client = await import( '../../resources/api/client' );
const getVariations = client.getVariations as unknown as ReturnType< typeof vi.fn >;
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;

const seName = {
	...coreFields().find( ( field ) => field.id === 'name' )!,
	id: 'i18n:se.short_description',
	label: 'SE short description',
	edit: { group: 'i18n:se', bulk: 'default' as const },
	rest: { fields: [ 'i18n' ], applies: { product: true, variation: false } },
};
const priced = [ ...coreFields().filter( ( field ) => [ 'status', 'regular_price', 'sale_price' ].includes( field.id ) ), seName ] as ReturnType< typeof coreFields >;

function hostFor( items: ProductListItem[], fields = priced, session: Partial< EditorSession > = {} ): EditorHost {
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

function answerLists( rows: ProductListItem[] ) {
	listProducts.mockImplementation( async ( query: Record< string, unknown > ) => {
		const ids = String( query.include ).split( ',' ).map( Number );

		return { items: ids.map( ( id ) => rows.find( ( row ) => row.id === id ) ?? simple( id ) ), total: ids.length, totalPages: 1 };
	} );
}

afterEach( () => {
	vi.clearAllMocks();
	listProducts.mockReset();
	getVariations.mockReset();
} );

const options = [ { value: 'instock', label: 'In stock' }, { value: 'outofstock', label: 'Out of stock' } ];
const stocked = [
	...priced,
	field( 'stock_status', { elements: options, rest: { fields: [ 'stock_status' ], applies: { product: true, variation: true } }, edit: { group: 'inventory', bulk: 'default' } } ),
	field( 'tax_status', { elements: [ { value: 'taxable', label: 'Taxable' } ], rest: { fields: [ 'tax_status' ], applies: { product: true, variation: true } }, edit: { group: 'tax', bulk: 'default' } } ),
] as ReturnType< typeof coreFields >;

describe( 'a campaign on all of a variable product’s variations from its quick edit', () => {
	it( 'offers the bulk price operations, shows what the variations cost now and saves the operation for them', async () => {
		const parent = variable( 31, { name: 'Koel Q', _childCount: 2 } );

		answerLists( [ parent ] );
		getVariations.mockImplementation( async ( parentId: number ) => ( {
			items: [ variation( parentId * 10 + 1, parentId, { regular_price: '20' } ), variation( parentId * 10 + 2, parentId, { regular_price: '30' } ) ],
			total: 2,
			totalPages: 1,
		} ) );
		saveEdits.mockResolvedValue( { updated: [], errors: [], batchId: 'b1', unchanged: 0, stockSkipped: 0, saleSkipped: 0, replacedSales: 0 } );

		render( <InlineEditor host={ hostFor( [ parent ] ) } /> );
		fireEvent.click( await screen.findByLabelText( 'Set the price of all its variations' ) );
		await screen.findByText( /Regular price now .*20.*30.*Prices will change on 2 variations of 1 variable product\./ );

		const operation = ( await screen.findByLabelText( 'sale_price: operation' ) ) as HTMLSelectElement;

		expect( Array.from( operation.options ).map( ( option ) => option.value ) ).toContain( 'regular_minus_percent' );
		fireEvent.change( operation, { target: { value: 'regular_minus_percent' } } );
		fireEvent.change( screen.getByLabelText( 'sale_price: value' ), { target: { value: '20' } } );
		fireEvent.click( screen.getByRole( 'button', { name: /^Update/ } ) );

		await waitFor( () => expect( saveEdits ).toHaveBeenCalled() );

		const [ , edits, , options ] = saveEdits.mock.calls[ 0 ] as [ unknown, Record< string, unknown >, unknown, { applyToVariations: boolean } ];

		expect( edits.sale_price ).toMatchObject( { operation: 'regular_minus', percent: true, value: '20' } );
		expect( options.applyToVariations ).toBe( true );
	} );
} );

describe( 'the variation price note', () => {
	it( 'counts the variations whose price the edit changes, not every variation', async () => {
		const parent = variable( 32, { name: 'Koel R', _childCount: 3 } );

		answerLists( [ parent ] );
		getVariations.mockImplementation( async ( parentId: number ) => ( {
			items: [ variation( 321, parentId, { regular_price: '20' } ), variation( 322, parentId, { regular_price: '30' } ), variation( 323, parentId, { regular_price: '20' } ) ],
			total: 3,
			totalPages: 1,
		} ) );

		render( <InlineEditor host={ hostFor( [ parent ] ) } /> );
		fireEvent.click( await screen.findByLabelText( 'Set the price of all its variations' ) );
		await screen.findByText( /Prices will change on 3 variations of 1 variable product\./ );

		fireEvent.change( await screen.findByLabelText( 'regular_price: operation' ), { target: { value: 'set' } } );
		fireEvent.change( screen.getByLabelText( 'regular_price: value' ), { target: { value: '20' } } );
		await screen.findByText( /Prices will change on 1 variation of 1 variable product\./ );

		fireEvent.change( screen.getByLabelText( 'regular_price: value' ), { target: { value: '25' } } );
		await screen.findByText( /Prices will change on 3 variations of 1 variable product\./ );
	} );
} );

describe( 'a variable product selected with every one of its variations', () => {
	it( 'has no apply-to-variations box: the price fields reach those variations already', async () => {
		const parent = variable( 41, { _childCount: 2 } );
		const rows = [ parent, variation( 411, 41 ), variation( 412, 41 ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 3 items' } );
		await screen.findByLabelText( 'regular_price: operation' );

		expect( screen.queryByLabelText( /Also apply to the variations/ ) ).not.toBeInTheDocument();
	} );

	it( 'still offers it while some of the variations are not selected', async () => {
		const parent = variable( 42, { _childCount: 3 } );
		const rows = [ parent, variation( 421, 42 ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows ) } /> );

		expect( await screen.findByLabelText( /Also apply to the variations/ ) ).toBeInTheDocument();
	} );
} );

describe( 'stock status of variable products', () => {
	it( 'is not offered when every selected item is a variable product', async () => {
		const rows = [ variable( 51 ), variable( 52 ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows, stocked ) } /> );
		await screen.findByRole( 'heading', { name: 'Bulk edit 2 items' } );
		await screen.findByLabelText( 'tax_status' );

		expect( screen.queryByLabelText( 'stock_status' ) ).not.toBeInTheDocument();
	} );

	it( 'says that variable products are skipped in a mixed selection', async () => {
		const rows = [ variable( 53 ), simple( 54 ) ];

		answerLists( rows );
		render( <InlineEditor host={ hostFor( rows, stocked ) } /> );

		await screen.findByLabelText( 'stock_status' );
		expect( screen.getByText( /Skipped for variable products \(their variations decide it\)/ ) ).toBeInTheDocument();
	} );
} );
