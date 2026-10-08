/**
 * The title column: the hierarchy's NameCell (indent, chevron with the
 * variation count, placeholder rows) around the name as a link to the
 * editor.
 */
import { decodeEntities } from '@wordpress/html-entities';
import { NameCell as HierarchyNameCell } from '../../hierarchy/chevron';
import type { ProductListItem } from '../../types';

export function NameCell( { item }: { item: ProductListItem } ) {
	const name = decodeEntities( item.name ?? '' ) || `#${ item.id }`;
	const meta = item.wc_products_list;

	return (
		<HierarchyNameCell item={ item }>
			{ meta?.edit_link && meta.can_edit !== false ? (
				<a className="wc-products-list__name-link" href={ meta.edit_link }>
					{ name }
				</a>
			) : (
				<span className="wc-products-list__name-text">{ name }</span>
			) }
		</HierarchyNameCell>
	);
}
