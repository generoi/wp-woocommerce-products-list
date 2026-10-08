/**
 * Rows reach the modal as the list loaded them: only the visible columns'
 * fields (the list asks for nothing else, that is what keeps it fast). The
 * form shows every editable field and the relative numeric ops read the
 * current values, so the selection is reloaded with the full edit field
 * set when the modal opens: one request per hundred products, one per
 * parent for variations, four at a time.
 */
import { getVariations, listProducts } from '../api/client';
import { createLimiter } from '../hierarchy/use-hierarchy';
import type { ProductField, ProductListItem } from '../types';
import { isVariation, parentIdOf } from './field-value';
import { visibleEditFields } from './visibility';

/** Always fetched: what the row identity, the actions and the summary need. */
export const EDIT_BASE_FIELDS = [ 'id', 'type', 'status', 'parent_id', 'wc_products_list', 'name', 'permalink' ] as const;

/** The projected sale < regular check reads both prices whichever one is edited. */
export const PRICE_SIBLING_FIELDS = [ 'price', 'regular_price', 'sale_price', 'date_on_sale_from', 'date_on_sale_to' ] as const;

/** Every status, trash included: a selection may hold rows of any tab. */
export const ANY_STATUS = 'publish,future,draft,pending,private,trash';

/**
 * The `_fields` the modal needs for a selection: the base keys plus the
 * fields the form could show for these rows (with "apply to variations"
 * on, so the sellable fields of variable parents are there too).
 */
export function editFetchFields( fields: ProductField[], items: ProductListItem[], mode: 'quick' | 'bulk' ): string[] {
	const keys = new Set< string >( [ ...EDIT_BASE_FIELDS, ...PRICE_SIBLING_FIELDS ] );

	for ( const field of visibleEditFields( fields, items, { mode, applyToVariations: true } ) ) {
		for ( const key of field.rest?.fields ?? [] ) {
			keys.add( key );
		}
	}

	return Array.from( keys ).sort();
}

export interface HydrateDeps {
	listProducts: typeof listProducts;
	getVariations: typeof getVariations;
}

const DEFAULT_DEPS: HydrateDeps = { listProducts, getVariations };

/**
 * The same rows with the fetched values merged in (row order and the
 * hierarchy keys kept). Rows the server no longer returns stay as they
 * are; the save reports them.
 */
export async function hydrateItems( items: ProductListItem[], fields: string[], deps: HydrateDeps = DEFAULT_DEPS, chunk = 100 ): Promise< ProductListItem[] > {
	const limit = createLimiter( 4 );
	const byId = new Map< number, ProductListItem >();
	const products: number[] = [];
	const variations = new Map< number, number[] >();

	for ( const item of items ) {
		if ( item._placeholder ) {
			continue;
		}

		if ( isVariation( item ) ) {
			const parentId = parentIdOf( item );

			if ( parentId > 0 ) {
				variations.set( parentId, [ ...( variations.get( parentId ) ?? [] ), item.id ] );
			}
		} else {
			products.push( item.id );
		}
	}

	const jobs: Array< Promise< void > > = [];
	const _fields = fields.join( ',' );

	for ( let i = 0; i < products.length; i += chunk ) {
		const ids = products.slice( i, i + chunk );

		jobs.push(
			limit( async () => {
				const result = await deps.listProducts( { include: ids.join( ',' ), per_page: ids.length, include_status: ANY_STATUS, _fields } );

				result.items.forEach( ( row ) => byId.set( row.id, row ) );
			} )
		);
	}

	for ( const [ parentId, ids ] of variations ) {
		for ( let i = 0; i < ids.length; i += chunk ) {
			const slice = ids.slice( i, i + chunk );

			jobs.push(
				limit( async () => {
					const result = await deps.getVariations( parentId, 1, { perPage: slice.length, fields, params: { include: slice.join( ',' ) } } );

					result.items.forEach( ( row ) => byId.set( row.id, row ) );
				} )
			);
		}
	}

	await Promise.all( jobs );

	return items.map( ( item ) => {
		const full = byId.get( item.id );

		return full ? ( { ...item, ...full } as ProductListItem ) : item;
	} );
}
