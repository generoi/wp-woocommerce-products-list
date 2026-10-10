/**
 * The editor never loses what a row is: a language tab's partial load must
 * not turn a variable parent into "simple" or a variation chip into "#221",
 * and the bulk list names a variation by its parent and its SKU.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateSelection, mergeHydrated, recheckStatuses, rootKeysOf, withoutUnaskedIdentity } from '../../resources/edit/hydrate';
import type { HydrateDeps } from '../../resources/edit/hydrate';
import { itemLabel, parentNameOf, skuOf } from '../../resources/edit/item-label';
import { resetCurrentRows, setCurrentRows } from '../../resources/store/rows';
import { normalizeProduct } from '../../resources/hierarchy/normalize';
import type { ProductListItem, RawProduct } from '../../resources/types';
import { simple, variable, variation } from './edit-fixtures';

afterEach( () => resetCurrentRows() );

describe( 'a partial (per-tab) load', () => {
	it( 'merges only the keys it asked for: type, name and the hierarchy keys stay', () => {
		const row = variable( 219, { name: 'Omaking Fresh', i18n: { se: { name: { value: 'Omaking SE' } } } } );
		// What the client hands back for `_fields=i18n.se.*,id,status`: normalised, so `type` defaulted to simple.
		const fetched = normalizeProduct( { id: 219, status: 'publish', i18n: { se: { meta_title: { value: 'Titel' } } } } as unknown as RawProduct );

		expect( fetched.type ).toBe( 'simple' );

		const merged = mergeHydrated( row as Record< string, unknown >, fetched as Record< string, unknown >, rootKeysOf( [ 'i18n.se.meta_title', 'id', 'status' ] ) ) as ProductListItem & Record< string, unknown >;

		expect( merged.type ).toBe( 'variable' );
		expect( merged._hasChildren ).toBe( true );
		expect( merged._childCount ).toBe( 2 );
		expect( merged.name ).toBe( 'Omaking Fresh' );
		// The language keys merge object by object.
		expect( merged.i18n ).toEqual( { se: { name: { value: 'Omaking SE' }, meta_title: { value: 'Titel' } } } );
	} );

	it( 'never lets undefined replace a value', () => {
		const merged = mergeHydrated( variation( 221, 219, { name: '25-34', _parentName: 'Omaking Fresh' } ) as Record< string, unknown >, { id: 221, _parentName: undefined } );

		expect( merged._parentName ).toBe( 'Omaking Fresh' );
	} );

	it( 'keeps the variation names through a hydrate that did not ask for them', async () => {
		const deps: HydrateDeps = {
			listProducts: vi.fn(),
			getVariations: vi.fn( async () => ( { items: [ { id: 221, parent_id: 219, status: 'publish', name: '#221', _kind: 'variation', _level: 1, _parentId: 219, _hasChildren: false, _childCount: 0 } as ProductListItem ], total: 1, totalPages: 1 } ) ),
		};
		const { items } = await hydrateSelection( [ variation( 221, 219, { name: '25-34', _parentName: 'Omaking Fresh' } ) ], [ 'i18n.se.regular_price', 'id' ], deps );
		const only = rootKeysOf( [ 'i18n.se.regular_price', 'id', 'status' ] );
		const merged = mergeHydrated( variation( 221, 219, { name: '25-34' } ) as Record< string, unknown >, items[ 0 ] as Record< string, unknown >, only );

		expect( merged.name ).toBe( '25-34' );
	} );
} );

describe( 'a narrow re-read (conflict, unknown outcome)', () => {
	it( 'keeps a variable parent variable with its children when `type` was not asked for', async () => {
		const deps: HydrateDeps = {
			// The client normalises a row read with `_fields=id,status,date_modified_gmt`: type simple, no children.
			listProducts: vi.fn( async () => ( { items: [ normalizeProduct( { id: 219, status: 'private', date_modified_gmt: '2026-10-10T10:00:00' } as unknown as RawProduct ) ], total: 1, totalPages: 1 } ) ),
			getVariations: vi.fn(),
		};
		const { items } = await hydrateSelection( [ variable( 219, { name: 'Omaking Fresh' } ) ], [ 'date_modified_gmt', 'id', 'status' ], deps );

		expect( items[ 0 ] ).toMatchObject( { type: 'variable', name: 'Omaking Fresh', status: 'private', _hasChildren: true, _childCount: 2, date_modified_gmt: '2026-10-10T10:00:00' } );
	} );

	it( 'takes `type` and `name` when asked, keeps the hierarchy keys, and fills keys the row lacks', () => {
		const fetched = { id: 1, type: 'variable', name: 'New', _hasChildren: false, _childCount: 0 };

		expect( withoutUnaskedIdentity( fetched, [ 'id', 'type', 'name' ], { id: 1, type: 'simple', name: 'Old', _hasChildren: true, _childCount: 3 } ) ).toEqual( { id: 1, type: 'variable', name: 'New' } );
		expect( withoutUnaskedIdentity( fetched, [ 'id' ], { id: 1 } ) ).toEqual( fetched );
		expect( withoutUnaskedIdentity( fetched, [ 'id', 'status' ] ) ).toEqual( { id: 1 } );
	} );
} );

describe( 'recheckStatuses', () => {
	it( 'finds the products trashed or deleted since the editor loaded them, in one light request', async () => {
		const listProducts = vi.fn( async () => ( { items: [ simple( 1 ), simple( 2, { status: 'trash' } ) ], total: 2, totalPages: 1 } ) );
		const changes = await recheckStatuses( [ simple( 1 ), simple( 2 ), simple( 3 ), variation( 41, 1 ) ], { listProducts } as unknown as HydrateDeps );

		expect( changes ).toEqual( { trashed: [ 2 ], missing: [ 3 ] } );
		expect( listProducts ).toHaveBeenCalledTimes( 1 );
		expect( listProducts ).toHaveBeenCalledWith( expect.objectContaining( { include: '1,2,3', _fields: 'id,status' } ) );
	} );
} );

describe( 'itemLabel', () => {
	it( 'names a variation by its parent, from the row or from the list', () => {
		expect( itemLabel( variation( 39891, 39889, { name: 'Black, 36', _parentName: 'Koel Gavien' } ) ) ).toBe( 'Koel Gavien – Black, 36' );

		setCurrentRows( [ simple( 39889, { name: 'Koel Dry' } ) ] );
		expect( parentNameOf( variation( 39891, 39889, { name: 'Black, 36' } ) ) ).toBe( 'Koel Dry' );
		expect( itemLabel( variation( 39891, 39889, { name: 'Black, 36' } ) ) ).toBe( 'Koel Dry – Black, 36' );
	} );

	it( 'falls back to the list row before "#id", and reads the SKU', () => {
		setCurrentRows( [ variation( 40569, 1, { name: 'Black, 36', _parentName: 'Skinners' } ) ] );

		expect( itemLabel( variation( 40569, 1, { name: '#40569' } ) ) ).toBe( 'Skinners – Black, 36' );
		expect( itemLabel( simple( 7, { name: '' } ) ) ).toBe( '#7' );
		expect( skuOf( simple( 7 ) ) ).toBe( 'S7' );
		expect( skuOf( simple( 7, { sku: ' ' } ) ) ).toBeNull();
	} );
} );
