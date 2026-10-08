import { afterEach, describe, expect, it } from 'vitest';
import { currentUserCan, getSettings, setSettings } from '../../resources/settings';
import type { Settings } from '../../resources/types';

export function sampleSettings( overrides: Partial< Settings > = {} ): Settings {
	return {
		version: '0.1.0',
		locale: 'fi',
		currency: { code: 'EUR', symbol: '€', position: 'right_space', decimals: 2, decimalSeparator: ',', thousandSeparator: ' ' },
		units: { weight: 'kg', dimension: 'cm' },
		dateFormat: 'j.n.Y',
		timeFormat: 'H:i',
		timezone: 'Europe/Helsinki',
		user: { id: 1, name: 'admin' },
		caps: { edit: true, editOthers: true, publish: true, delete: true, deleteOthers: true, manageWoocommerce: true, manageTerms: true },
		statuses: [ { value: 'publish', label: 'Published' }, { value: 'draft', label: 'Draft' } ],
		productTypes: [ { value: 'simple', label: 'Simple' }, { value: 'variable', label: 'Variable' } ],
		stockStatuses: [ { value: 'instock', label: 'In stock' } ],
		catalogVisibility: [ { value: 'visible', label: 'Shop and search' } ],
		backorders: [ { value: 'no', label: 'Do not allow' } ],
		taxStatuses: [ { value: 'taxable', label: 'Taxable' } ],
		taxClasses: [ { value: '', label: 'Standard' } ],
		shippingClasses: [],
		taxonomies: [ { name: 'product_cat', label: 'Categories', restKey: 'categories', hierarchical: true, attribute: false } ],
		features: { cogs: false, brands: false, reviews: true, hardDelete: false },
		limits: { perPageMax: 100, maxChildrenPerParent: 1000, batchSize: 50, actionBatchSize: 100 },
		links: { admin: '/wp/wp-admin/', rest: '/wp-json/', page: '', history: '', legacyList: '', newProduct: '', editProduct: '/wp/wp-admin/post.php?post=%d&action=edit', assets: '' },
		fields: [],
		filters: [],
		actions: [],
		languages: null,
		...overrides,
	};
}

describe( 'settings', () => {
	afterEach( () => setSettings( undefined ) );

	it( 'throws when the inline payload is missing', () => {
		expect( () => getSettings() ).toThrow( /wcProductsListSettings/ );
	} );

	it( 'reads the payload once and answers capability checks', () => {
		setSettings( sampleSettings( { caps: { ...sampleSettings().caps, delete: false } } ) );

		expect( getSettings().currency.code ).toBe( 'EUR' );
		expect( currentUserCan( 'edit' ) ).toBe( true );
		expect( currentUserCan( 'delete' ) ).toBe( false );
		expect( getSettings() ).toBe( getSettings() );
	} );
} );
