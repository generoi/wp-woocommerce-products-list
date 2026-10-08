import { describe, expect, it } from 'vitest';
import { normalizeProduct, normalizeVariation, stripMeta, variationName } from '../../resources/hierarchy/normalize';
import type { RawProduct, RawVariation } from '../../resources/types';

const parentRaw: RawProduct = {
	id: 10,
	name: 'Saga &amp; Co boot',
	type: 'variable',
	status: 'publish',
	categories: [ { id: 1, name: 'Boots', slug: 'boots' } ],
	tags: [ { id: 2, name: 'Wide', slug: 'wide' } ],
	wc_products_list: { variation_count: 3, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 },
};

describe( 'normalizeProduct', () => {
	it( 'marks a variable product with variations as a parent', () => {
		const row = normalizeProduct( parentRaw );

		expect( row ).toMatchObject( { _kind: 'product', _level: 0, _parentId: null, _hasChildren: true, _childCount: 3 } );
	} );

	it( 'does not expand a variable product with zero variations', () => {
		const row = normalizeProduct( { ...parentRaw, wc_products_list: { ...parentRaw.wc_products_list!, variation_count: 0 } } );

		expect( row._hasChildren ).toBe( false );
		expect( row._childCount ).toBe( 0 );
	} );

	it( 'keeps a variable product expandable when the count was not requested', () => {
		const row = normalizeProduct( { id: 11, type: 'variable' } );

		expect( row._hasChildren ).toBe( true );
		expect( row._childCount ).toBe( 0 );
	} );

	it( 'falls back to the variations array for the count', () => {
		const row = normalizeProduct( { id: 11, type: 'variable', variations: [ 1, 2 ] } );

		expect( row._childCount ).toBe( 2 );
	} );

	it( 'never gives a simple product children', () => {
		const row = normalizeProduct( { id: 12, type: 'simple', wc_products_list: { variation_count: 5, edit_link: '', can_edit: true, can_delete: true, parent_id: 0 } } );

		expect( row._hasChildren ).toBe( false );
		expect( row.type ).toBe( 'simple' );
	} );

	it( 'defaults a missing type to simple', () => {
		expect( normalizeProduct( { id: 13 } ).type ).toBe( 'simple' );
	} );
} );

describe( 'normalizeVariation', () => {
	const raw: RawVariation = {
		id: 101,
		name: 'Saga &amp; Co boot - Blue, 42',
		status: 'publish',
		sku: 'SAGA-BL-42',
		image: { id: 5, src: 'https://x/5.jpg' },
		attributes: [
			{ id: 1, name: 'Colour', option: 'Blue' },
			{ id: 2, name: 'Size', option: '42' },
		],
	};

	it( 'builds the row from the attributes and the parent', () => {
		const parent = normalizeProduct( parentRaw );
		const row = normalizeVariation( raw, parent );

		expect( row ).toMatchObject( {
			id: 101,
			type: 'variation',
			name: 'Blue, 42',
			parent_id: 10,
			status: 'publish',
			images: [ { id: 5, src: 'https://x/5.jpg' } ],
			categories: parentRaw.categories,
			tags: parentRaw.tags,
			_kind: 'variation',
			_level: 1,
			_parentId: 10,
			_hasChildren: false,
			_childCount: 0,
		} );
	} );

	it( 'accepts a bare parent id and then copies nothing', () => {
		const row = normalizeVariation( raw, 10 );

		expect( row._parentId ).toBe( 10 );
		expect( row.parent_id ).toBe( 10 );
		expect( row.categories ).toBeUndefined();
	} );

	it( 'keeps the variation taxonomies when the raw row carries them', () => {
		const parent = normalizeProduct( parentRaw );
		const row = normalizeVariation( { ...raw, categories: [ { id: 9, name: 'Own', slug: 'own' } ] } as RawVariation, parent );

		expect( row.categories ).toEqual( [ { id: 9, name: 'Own', slug: 'own' } ] );
	} );

	it( 'maps status to publish or private only', () => {
		expect( normalizeVariation( { ...raw, status: 'private' }, 10 ).status ).toBe( 'private' );
		expect( normalizeVariation( { ...raw, status: 'draft' }, 10 ).status ).toBe( 'publish' );
		expect( normalizeVariation( { id: 1 }, 10 ).status ).toBeUndefined();
	} );

	it( 'turns a missing image into an empty list', () => {
		expect( normalizeVariation( { ...raw, image: null }, 10 ).images ).toEqual( [] );
		expect( normalizeVariation( { id: 1 }, 10 ).images ).toEqual( [] );
	} );

	it( 'keeps the shown images when a write response patches image: null', () => {
		// Write responses are serialised in the edit context, where a
		// variation without an image of its own gets null; reads fall back
		// to the parent's image, which the row already shows.
		const shown = normalizeVariation( { ...raw, image: { id: 5, src: 'parent.jpg' } }, 10 );

		expect( normalizeVariation( { ...shown, image: null }, 10 ).images ).toEqual( [ { id: 5, src: 'parent.jpg' } ] );
	} );

	it( 'is idempotent and lets a patched image win over the stale list', () => {
		const once = normalizeVariation( raw, 10 );
		const twice = normalizeVariation( once, 10 );

		expect( twice ).toEqual( once );

		const patched = normalizeVariation( { ...once, image: { id: 6, src: 'https://x/6.jpg' } }, 10 );

		expect( patched.images ).toEqual( [ { id: 6, src: 'https://x/6.jpg' } ] );
	} );
} );

describe( 'variationName', () => {
	it( 'joins the attribute options and decodes entities', () => {
		expect( variationName( { id: 1, attributes: [ { id: 1, name: 'a', option: 'Black &amp; White' }, { id: 2, name: 'b', option: ' 42 ' } ] } ) ).toBe( 'Black & White, 42' );
	} );

	it( 'skips attributes without an option', () => {
		expect( variationName( { id: 1, attributes: [ { id: 1, name: 'a', option: '' }, { id: 2, name: 'b', option: 'M' } ] } ) ).toBe( 'M' );
	} );

	it( 'strips the parent name from the wc/v3 name when attributes are missing', () => {
		expect( variationName( { id: 1, name: 'Saga - Blue, 42' }, 'Saga' ) ).toBe( 'Blue, 42' );
		expect( variationName( { id: 1, name: 'Saga - Blue - 42' }, 'Saga' ) ).toBe( 'Blue - 42' );
	} );

	it( 'strips up to the first dash without a parent name', () => {
		expect( variationName( { id: 1, name: 'Saga boot - Blue' } ) ).toBe( 'Blue' );
		expect( variationName( { id: 1, name: 'Saga boot' } ) ).toBe( 'Saga boot' );
	} );

	it( 'falls back to the id', () => {
		expect( variationName( { id: 7 } ) ).toBe( '#7' );
	} );
} );

describe( 'stripMeta', () => {
	it( 'removes the list meta and nothing else', () => {
		const row = normalizeVariation( { id: 1, sku: 'A' }, 10 );

		expect( stripMeta( row ) ).toEqual( { id: 1, sku: 'A', type: 'variation', name: '#1', parent_id: 10, status: undefined, images: [] } );
	} );
} );
