import { describe, expect, it, vi } from 'vitest';
import { destructiveLast, moreActionsFor, withoutFooterBulk } from '../../resources/list/more-actions';
import { fromSplitView, splitViewFields, SPLIT_NAME_STYLE, toSplitView } from '../../resources/list/split-view';
import { withStickyBulkUndo } from '../../resources/actions/notices';
import type { View } from '../../resources/dataviews';
import type { ProductAction, ProductListItem } from '../../resources/types';

const saved = {
	type: 'table',
	fields: [ 'status', 'type', 'sku', 'stock_status', 'price', 'date_created', 'i18n:se.name', 'categories' ],
	layout: { styles: { name: { minWidth: 280 }, sku: { width: 120 } } },
} as unknown as View;

describe( 'split view columns', () => {
	it( 'keeps SKU, price, stock and translation columns, key columns first, and drops the low-value ones', () => {
		expect( splitViewFields( saved.fields ?? [] ) ).toEqual( [ 'sku', 'price', 'stock_status', 'i18n:se.name' ] );
	} );

	it( 'narrows the name column in the shown view only', () => {
		const shown = toSplitView( saved ) as unknown as { fields: string[]; layout: { styles: Record< string, object > } };

		expect( shown.fields ).toEqual( [ 'sku', 'price', 'stock_status', 'i18n:se.name' ] );
		expect( shown.layout.styles.name ).toEqual( { minWidth: SPLIT_NAME_STYLE.minWidth, maxWidth: SPLIT_NAME_STYLE.maxWidth } );
		expect( ( saved as unknown as { layout: { styles: { name: object } } } ).layout.styles.name ).toEqual( { minWidth: 280 } );
	} );

	it( 'leaves grid and list views alone', () => {
		const grid = { type: 'grid', fields: [ 'status' ] } as unknown as View;

		expect( toSplitView( grid ) ).toBe( grid );
	} );

	it( 'maps a sort made in split view back onto the saved columns and widths', () => {
		const next = { ...toSplitView( saved ), sort: { field: 'price', direction: 'desc' } } as View;
		const back = fromSplitView( next, saved ) as unknown as { fields: string[]; sort: object; layout: object };

		expect( back.fields ).toEqual( saved.fields );
		expect( back.sort ).toEqual( { field: 'price', direction: 'desc' } );
		expect( back.layout ).toEqual( ( saved as unknown as { layout: object } ).layout );
	} );

	it( 'applies a column hidden or added in split view to the saved columns', () => {
		const shown = toSplitView( saved );
		const hidden = fromSplitView( { ...shown, fields: [ 'sku', 'stock_status', 'i18n:se.name', 'weight' ] } as View, saved );

		expect( hidden.fields ).toEqual( [ 'status', 'type', 'sku', 'stock_status', 'date_created', 'i18n:se.name', 'categories', 'weight' ] );
	} );
} );

const row = ( id: number ) => ( { id, _kind: 'product', _level: 0 } ) as unknown as ProductListItem;
const action = ( id: string, extra: Partial< ProductAction > = {} ) => ( { id, label: id, supportsBulk: true, callback: vi.fn(), ...extra } ) as unknown as ProductAction;

describe( 'More actions', () => {
	const actions = [ action( 'quick-edit', { isPrimary: true } ), action( 'trash' ), action( 'clear-sale' ), action( 'delete-variations' ), action( 'view', { supportsBulk: false } ), action( 'feature', { isEligible: () => false } ) ];

	it( 'puts destructive actions last', () => {
		expect( destructiveLast( actions ).map( ( a ) => a.id ) ).toEqual( [ 'quick-edit', 'clear-sale', 'view', 'feature', 'trash', 'delete-variations' ] );
	} );

	it( 'offers the eligible non-primary bulk actions, destructive ones apart', () => {
		const { regular, destructive } = moreActionsFor( actions, [ row( 1 ), row( 2 ) ] );

		expect( regular.map( ( a ) => a.id ) ).toEqual( [ 'clear-sale' ] );
		expect( destructive.map( ( a ) => a.id ) ).toEqual( [ 'trash', 'delete-variations' ] );
	} );

	it( 'keeps only the primary bulk actions in the footer', () => {
		const footer = withoutFooterBulk( actions ).filter( ( a ) => a.supportsBulk ).map( ( a ) => a.id );

		expect( footer ).toEqual( [ 'quick-edit' ] );
	} );
} );

describe( 'withStickyBulkUndo', () => {
	const undo = { label: 'Undo', onClick: () => {} };
	const history = { label: 'View in History', url: '/history?batch=1' };

	it( 'keeps a bulk save snackbar (Undo plus its History link) until dismissed', () => {
		expect( withStickyBulkUndo( { id: 'saved', actions: [ undo, history ] } )?.explicitDismiss ).toBe( true );
	} );

	it( 'leaves a quick save Undo, plain notices and explicit choices alone', () => {
		expect( withStickyBulkUndo( { id: 'saved', actions: [ undo ] } )?.explicitDismiss ).toBeUndefined();
		expect( withStickyBulkUndo( { id: 'x' } )?.explicitDismiss ).toBeUndefined();
		expect( withStickyBulkUndo( undefined ) ).toBeUndefined();
		expect( withStickyBulkUndo( { actions: [ undo, history ], explicitDismiss: false } )?.explicitDismiss ).toBe( false );
	} );
} );
