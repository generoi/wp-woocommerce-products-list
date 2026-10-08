/**
 * Paged helpers over `products/{id}/variations`. The hierarchy fetches a
 * parent's children page by page; bulk edit needs just the ids of every
 * variation of the selected variable products.
 */
import { getSettings } from '../settings';
import type { ProductListItem, QueryParams } from '../types';
import { getVariations } from './client';
import type { RequestOptions } from './client';

export interface VariationPage {
	items: ProductListItem[];
	page: number;
	totalPages: number;
	total: number;
}

export interface FetchAllOptions extends RequestOptions {
	fields?: string[];
	params?: QueryParams;
	/** Stop after this many rows (the `maxChildrenPerParent` cap). */
	max?: number;
	/** Called after every page, so the UI can show rows as they arrive. */
	onPage?: ( page: VariationPage ) => void;
}

/** Every variation of one parent, 100 per request, pages in order. */
export async function fetchAllVariations( parentId: number, options: FetchAllOptions = {} ): Promise< VariationPage > {
	const perPage = getSettings().limits.perPageMax;
	const max = options.max ?? getSettings().limits.maxChildrenPerParent;
	const items: ProductListItem[] = [];
	let page = 1;
	let totalPages = 1;
	let total = 0;

	do {
		const result = await getVariations( parentId, page, { ...options, perPage } );
		items.push( ...result.items );
		totalPages = result.totalPages;
		total = result.total;
		options.onPage?.( { items, page, totalPages, total } );
		page += 1;
	} while ( page <= totalPages && items.length < max );

	return { items, page: page - 1, totalPages, total };
}

/** Run `fn` over `inputs` with at most `concurrency` in flight. */
export async function mapWithConcurrency< In, Out >( inputs: In[], concurrency: number, fn: ( input: In ) => Promise< Out > ): Promise< Out[] > {
	const results: Out[] = new Array( inputs.length );
	let next = 0;

	async function worker(): Promise< void > {
		while ( next < inputs.length ) {
			const index = next++;
			results[ index ] = await fn( inputs[ index ] as In );
		}
	}

	await Promise.all( Array.from( { length: Math.max( 1, Math.min( concurrency, inputs.length ) ) }, worker ) );

	return results;
}

/** The ids of every variation of the given parents (`_fields=id`), 4 parents at a time. */
export async function variationIdsOf( parentIds: number[], options: RequestOptions = {} ): Promise< number[] > {
	const pages = await mapWithConcurrency( parentIds, 4, ( parentId ) =>
		fetchAllVariations( parentId, { ...options, fields: [ 'id', 'parent_id', 'wc_products_list' ] } )
	);

	return pages.flatMap( ( page ) => page.items.map( ( item ) => item.id ) );
}
