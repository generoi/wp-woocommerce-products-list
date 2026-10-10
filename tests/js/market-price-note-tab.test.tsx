/**
 * The variations note of a language tab whose prices are in a market
 * currency (SEK) never shows the shop-currency (euro) price range, also
 * after the General tab was opened and left (r3-translations-6).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../resources/edit/editor-context';
import type { ProductField, ProductListItem } from '../../resources/types';
import { coreFields, editSettings, variable, variation } from './edit-fixtures';

vi.setConfig( { testTimeout: 20000 } );

const settings = editSettings();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), remove: vi.fn() };

vi.mock( '../../resources/settings', () => ( { getSettings: () => settings } ) );
vi.mock( '../../resources/actions/notices', () => ( { notify } ) );
vi.mock( '../../resources/store/products', () => ( { subscribeDeleted: () => () => {}, patchItems: vi.fn(), removeItems: vi.fn(), invalidateProducts: vi.fn() } ) );
vi.mock( '../../resources/api/client', () => ( {
	logSkipped: vi.fn( async () => undefined ),
	getVariations: vi.fn(),
	listProducts: vi.fn(),
	newBatchId: vi.fn( () => 'batch-sek' ),
	runAction: vi.fn(),
	closeBatch: vi.fn( async () => undefined ),
	isRequestFailure: vi.fn( () => false ),
} ) );
vi.mock( '../../resources/edit/save', () => ( { saveEdits: vi.fn() } ) );
vi.mock( '../../resources/edit/undo', () => ( { undoBatch: vi.fn() } ) );

const { InlineEditor } = await import( '../../resources/edit/inline-editor' );
const client = await import( '../../resources/api/client' );
const getVariations = client.getVariations as unknown as ReturnType< typeof vi.fn >;
const listProducts = client.listProducts as unknown as ReturnType< typeof vi.fn >;

const sek = { code: 'SEK', symbol: 'kr', decimals: 2 };
const fields = coreFields()
	.filter( ( field ) => [ 'status', 'regular_price', 'sale_price', 'i18n:se.regular_price', 'i18n:se.sale_price' ].includes( field.id ) )
	.map( ( field ) => ( field.id.startsWith( 'i18n:se.' ) ? ( { ...field, currency: sek } as ProductField ) : field ) )
	.concat( {
		...coreFields().find( ( field ) => field.id === 'name' )!,
		id: 'i18n:se.short_description',
		label: 'SE short description',
		edit: { group: 'i18n:se', bulk: 'default' as const },
		rest: { fields: [ 'i18n' ], applies: { product: true, variation: false } },
	} as ProductField );

function hostFor( items: ProductListItem[] ): EditorHost {
	return {
		session: { mode: 'quick', id: items[ 0 ]?.id ?? 0, origin: null },
		fields,
		items,
		offPageCount: 0,
		wholeList: false,
		close: vi.fn(),
		advance: vi.fn(),
		removeItem: vi.fn(),
		setGuard: vi.fn(),
	} as EditorHost;
}

afterEach( () => {
	vi.clearAllMocks();
	listProducts.mockReset();
	getVariations.mockReset();
} );

describe( 'the Prices (SEK) variations note', () => {
	it( 'keeps out the euro range after a visit to the General tab', async () => {
		const parent = variable( 41, { name: 'QA V1', _childCount: 2 } );

		listProducts.mockImplementation( async () => ( { items: [ parent ], total: 1, totalPages: 1 } ) );
		getVariations.mockImplementation( async ( parentId: number ) => ( {
			items: [ variation( 411, parentId, { regular_price: '169', sale_price: '120' } ), variation( 412, parentId, { regular_price: '169', sale_price: '' } ) ],
			total: 2,
			totalPages: 1,
		} ) );

		render( <InlineEditor host={ hostFor( [ parent ] ) } /> );
		await screen.findByLabelText( 'Set the price of all its variations' );

		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await waitFor( () => expect( screen.getByRole( 'tabpanel' ) ).toHaveAttribute( 'aria-busy', 'false' ) );
		fireEvent.click( await screen.findByLabelText( 'Set the price of all its variations' ) );
		const note = await screen.findByText( /Prices will change on 2 variations of 1 variable product\./ );
		expect( note.textContent ).not.toMatch( /Regular price now/ );

		// The General tab shows the shop-currency range.
		fireEvent.click( screen.getByRole( 'tab', { name: 'General' } ) );
		await screen.findByText( /Regular price now 169,00 €; 1 is on sale\. Prices will change on 2 variations/ );

		// Back on the SEK tab, the range is gone again.
		fireEvent.click( screen.getByRole( 'tab', { name: 'SE' } ) );
		await waitFor( () => expect( screen.getByRole( 'tabpanel' ) ).toHaveAttribute( 'aria-busy', 'false' ) );
		const back = await screen.findByText( /Prices will change on 2 variations of 1 variable product\./ );
		expect( back.textContent ).not.toMatch( /Regular price now|€/ );
	} );
} );
