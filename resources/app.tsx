import { useMemo, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { DataViews } from './dataviews';
import type { Field, View } from './dataviews';
import { getSettings } from './settings';
import { getItemId } from './types/product';
import type { ProductListItem } from './types/product';

/**
 * Scaffold: a table over three fixed rows to prove the bundle, the styles
 * and the React 18 runtime. The real screen (list/products-screen.tsx)
 * replaces this.
 */
const SAMPLE: ProductListItem[] = [
	{ id: 1, name: 'Saga wide toe boot', type: 'variable', sku: 'SAGA', status: 'publish', price: '189', _kind: 'product', _level: 0, _parentId: null, _hasChildren: true, _childCount: 3 },
	{ id: 2, name: 'Vilja sandal', type: 'simple', sku: 'VILJA', status: 'publish', price: '129', _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0 },
	{ id: 3, name: 'Aino sneaker', type: 'simple', sku: 'AINO', status: 'draft', price: '149', _kind: 'product', _level: 0, _parentId: null, _hasChildren: false, _childCount: 0 },
];

const DEFAULT_VIEW: View = {
	type: 'table',
	perPage: 20,
	page: 1,
	titleField: 'name',
	fields: [ 'sku', 'type', 'status', 'price' ],
};

export function App() {
	const settings = getSettings();
	const [ view, setView ] = useState< View >( DEFAULT_VIEW );

	const fields = useMemo< Field< ProductListItem >[] >(
		() => [
			{ id: 'name', label: __( 'Name', 'wp-woocommerce-products-list' ), enableHiding: false },
			{ id: 'sku', label: __( 'SKU', 'wp-woocommerce-products-list' ) },
			{
				id: 'type',
				label: __( 'Type', 'wp-woocommerce-products-list' ),
				elements: settings.productTypes,
			},
			{
				id: 'status',
				label: __( 'Status', 'wp-woocommerce-products-list' ),
				elements: settings.statuses,
			},
			{
				id: 'price',
				label: __( 'Price', 'wp-woocommerce-products-list' ),
				render: ( { item } ) => `${ item.price ?? '' } ${ settings.currency.symbol }`,
			},
		],
		[ settings ]
	);

	return (
		<div className="wc-products-list">
			<DataViews< ProductListItem >
				data={ SAMPLE }
				fields={ fields }
				view={ view }
				onChangeView={ setView }
				getItemId={ getItemId }
				paginationInfo={ { totalItems: SAMPLE.length, totalPages: 1 } }
				defaultLayouts={ { table: {} } }
				actions={ [] }
			/>
		</div>
	);
}
