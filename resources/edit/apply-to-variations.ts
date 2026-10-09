/**
 * "Apply price/sale fields to all variations of the selected variable products".
 *
 * A variable parent has no prices of its own; its variations do. When the
 * option is on, the sellable edits of a variable parent are routed to every
 * variation of that parent, which are fetched (with a trimmed `_fields`) so
 * relative numeric ops and the sale < regular check see current values.
 */
import type { ProductField, ProductListItem } from '../types';
import { isVariableParent } from './field-value';
import { isSellableField } from './visibility';

export interface SaveTarget {
	item: ProductListItem;
	edits: Record< string, unknown >;
	/** True when the row was added for a selected variable parent rather than selected itself. */
	viaParent: boolean;
}

export interface SplitEdits {
	parent: Record< string, unknown >;
	sellable: Record< string, unknown >;
}

export function splitParentEdits( edits: Record< string, unknown >, fields: ProductField[] ): SplitEdits {
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );
	const parent: Record< string, unknown > = {};
	const sellable: Record< string, unknown > = {};

	for ( const [ id, value ] of Object.entries( edits ) ) {
		const field = byId.get( id );

		if ( isSellableField( field ?? id ) ) {
			sellable[ id ] = value;
		} else {
			parent[ id ] = value;
		}
	}

	return { parent, sellable };
}

/** The variation `_fields` needed to resolve the sellable edits: ids plus the fields edited and their price siblings. */
export function variationFetchFields( fields: ProductField[], sellableEdits: Record< string, unknown > ): string[] {
	const result = new Set< string >( [ 'id', 'parent_id', 'status', 'name', 'regular_price', 'sale_price', 'on_sale', 'date_on_sale_from', 'date_on_sale_to', 'manage_stock' ] );
	const byId = new Map( fields.map( ( field ) => [ field.id, field ] ) );

	for ( const id of Object.keys( sellableEdits ) ) {
		const field = byId.get( id );

		( field?.rest?.fields ?? [ id.split( '.' )[ 0 ] ?? id ] ).forEach( ( key ) => result.add( key ) );
		byId.get( id.replace( /sale_price$/, 'regular_price' ) )?.rest?.fields.forEach( ( key ) => result.add( key ) );
	}

	return Array.from( result );
}

export type FetchVariations = ( parentId: number, fields: string[] ) => Promise< ProductListItem[] >;

export const VARIATION_FETCH_CONCURRENCY = 4;

async function mapWithConcurrency< T, R >( inputs: T[], limit: number, fn: ( input: T ) => Promise< R > ): Promise< R[] > {
	const results: R[] = new Array( inputs.length );
	let next = 0;

	async function worker(): Promise< void > {
		while ( next < inputs.length ) {
			const index = next++;
			const input = inputs[ index ] as T;

			results[ index ] = await fn( input );
		}
	}

	await Promise.all( Array.from( { length: Math.min( limit, inputs.length ) }, worker ) );

	return results;
}

/**
 * Every row the save touches with the edits that apply to it. Variable
 * parents keep their non-sellable edits; with `applyToVariations` their
 * variations get the sellable ones. A variation selected directly and also
 * reached through its parent is saved once, with both sets merged.
 */
export async function resolveSaveTargets(
	items: ProductListItem[],
	edits: Record< string, unknown >,
	fields: ProductField[],
	options: { applyToVariations: boolean; fetchVariations: FetchVariations; carriersOnly?: ReadonlySet< number > }
): Promise< SaveTarget[] > {
	const rows = items.filter( ( item ) => ! item._placeholder );
	const { sellable } = splitParentEdits( edits, fields );
	const variableParents = rows.filter( isVariableParent );
	const byParent = new Map< number, ProductListItem[] >();

	if ( options.applyToVariations && variableParents.length > 0 && Object.keys( sellable ).length > 0 ) {
		const fetchFields = variationFetchFields( fields, sellable );
		const variationLists = await mapWithConcurrency( variableParents, VARIATION_FETCH_CONCURRENCY, ( parentItem ) => options.fetchVariations( parentItem.id, fetchFields ) );

		variableParents.forEach( ( parentItem, index ) => byParent.set( parentItem.id, variationLists[ index ] ?? [] ) );
	}

	return resolveSaveTargetsWith( items, edits, fields, { applyToVariations: options.applyToVariations, variationsByParent: byParent, carriersOnly: options.carriersOnly } );
}

/**
 * The same, with the variations already in hand (the modal fetches them
 * when the option is ticked, so the plan it shows before Save is exact).
 * A parent missing from `variationsByParent` contributes no variations.
 * A parent in `carriersOnly` only carries its variations (a retry of the
 * variations that failed): its own edits already saved and are not sent again.
 */
export function resolveSaveTargetsWith(
	items: ProductListItem[],
	edits: Record< string, unknown >,
	fields: ProductField[],
	options: { applyToVariations: boolean; variationsByParent?: ReadonlyMap< number, ProductListItem[] >; carriersOnly?: ReadonlySet< number > }
): SaveTarget[] {
	const rows = items.filter( ( item ) => ! item._placeholder );
	const { parent, sellable } = splitParentEdits( edits, fields );
	const targets = new Map< number, SaveTarget >();

	for ( const item of rows ) {
		if ( options.carriersOnly?.has( item.id ) ) {
			continue;
		}

		if ( isVariableParent( item ) ) {
			targets.set( item.id, { item, edits: parent, viaParent: false } );
		} else {
			targets.set( item.id, { item, edits, viaParent: false } );
		}
	}

	if ( options.applyToVariations && Object.keys( sellable ).length > 0 ) {
		for ( const item of rows.filter( isVariableParent ) ) {
			for ( const variation of options.variationsByParent?.get( item.id ) ?? [] ) {
				if ( variation._placeholder ) {
					continue;
				}

				const existing = targets.get( variation.id );

				if ( existing ) {
					existing.edits = { ...sellable, ...existing.edits };
				} else {
					targets.set( variation.id, { item: variation, edits: sellable, viaParent: true } );
				}
			}
		}
	}

	return Array.from( targets.values() );
}

/** Fetch all variations of a parent page by page (wc/v3 caps per_page at 100). */
export async function fetchAllVariations(
	parentId: number,
	fields: string[],
	getPage: ( parentId: number, page: number, fields: string[] ) => Promise< { items: ProductListItem[]; totalPages: number } >
): Promise< ProductListItem[] > {
	const first = await getPage( parentId, 1, fields );
	const all = [ ...first.items ];

	for ( let page = 2; page <= first.totalPages; page++ ) {
		const next = await getPage( parentId, page, fields );

		all.push( ...next.items );
	}

	return all;
}
