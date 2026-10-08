/**
 * How the editor names a row: a variation by its parent and its attributes
 * ("Koel Gavien – Black, 36"), never by "#id" when the list knows it, so
 * the same "Black, 36" of two products can be told apart in the bulk list,
 * the summary and the error reports.
 */
import { decodeEntities } from '@wordpress/html-entities';
import { getCurrentRows } from '../store/rows';
import type { ProductListItem } from '../types';
import { isVariation, parentIdOf } from './field-value';

function plainName( item: ProductListItem | undefined ): string | null {
	const name = ( item as { name?: unknown } | undefined )?.name;

	if ( typeof name !== 'string' || name === '' || name === `#${ item?.id }` ) {
		return null;
	}

	return decodeEntities( name );
}

/** The parent's name of a variation row: carried by the row, else the parent row on screen. */
export function parentNameOf( item: ProductListItem, rows: ProductListItem[] = getCurrentRows() ): string | null {
	if ( ! isVariation( item ) ) {
		return null;
	}

	// The row's own, else the one the list carries for it (a hydrated copy may have lost it).
	for ( const row of [ item, rows.find( ( entry ) => entry.id === item.id ) ] ) {
		const own = ( row as { _parentName?: unknown } | undefined )?._parentName;

		if ( typeof own === 'string' && own !== '' ) {
			return decodeEntities( own );
		}
	}

	const parentId = parentIdOf( item );

	return parentId > 0 ? plainName( rows.find( ( row ) => row.id === parentId ) ) : null;
}

/** The row's own short name ("Black, 36" for a variation); "#id" only when nothing better is known. */
export function shortNameOf( item: ProductListItem, rows: ProductListItem[] = getCurrentRows() ): string {
	return plainName( item ) ?? plainName( rows.find( ( row ) => row.id === item.id ) ) ?? `#${ item.id }`;
}

/** "Parent – Black, 36" for a variation, the name for a product. */
export function itemLabel( item: ProductListItem, rows: ProductListItem[] = getCurrentRows() ): string {
	const name = shortNameOf( item, rows );
	const parent = parentNameOf( item, rows );

	return parent && ! name.startsWith( parent ) ? `${ parent } – ${ name }` : name;
}

/** The SKU, when the row carries one. */
export function skuOf( item: ProductListItem ): string | null {
	const sku = ( item as { sku?: unknown } ).sku;

	return typeof sku === 'string' && sku.trim() !== '' ? sku.trim() : null;
}
