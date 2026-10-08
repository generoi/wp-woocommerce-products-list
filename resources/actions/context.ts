/**
 * What every action factory receives, and the helpers they share: ids of
 * real rows, the `_fields` for refreshed rows, result summaries.
 */
import { __ } from '@wordpress/i18n';
import type { ActionResponse } from '../api/client';
import type { View } from '../dataviews';
import type { Hierarchy } from '../hierarchy/use-hierarchy';
import { isVariation } from '../edit/field-value';
import type { ProductAction, ProductField, ProductListItem, Settings } from '../types';

export interface ProductActionsContext {
	fields: ProductField[];
	settings: Settings;
	view: View;
	tab: string;
	hierarchy: Hierarchy;
	/** DataViews selection ids; needed by "Select variations". */
	selection?: string[];
	onChangeSelection?( ids: string[] ): void;
}

export type ActionFactory = ( context: ProductActionsContext ) => ProductAction | null;

export function isRealRow( item: ProductListItem ): boolean {
	return ! item._placeholder && typeof item.id === 'number' && item.id > 0;
}

export function realRows( items: ProductListItem[] ): ProductListItem[] {
	return items.filter( isRealRow );
}

export function idsOf( items: ProductListItem[] ): number[] {
	return realRows( items ).map( ( item ) => item.id );
}

export function isVariationRow( item: ProductListItem ): boolean {
	return isVariation( item );
}

export function isProduct( item: ProductListItem ): boolean {
	return ! isVariation( item );
}

export function canEdit( item: ProductListItem ): boolean {
	return item.wc_products_list?.can_edit !== false;
}

export function canDelete( item: ProductListItem ): boolean {
	return item.wc_products_list?.can_delete !== false;
}

export function nameOf( item: ProductListItem ): string {
	return ( item as { name?: string } ).name ?? `#${ item.id }`;
}

/** The `_fields` for rows an action returns: everything the list may show. */
export function rowFields( fields: ProductField[] ): string[] {
	const keys = new Set< string >( [ 'id', 'type', 'status', 'parent_id', 'wc_products_list', 'name', 'permalink' ] );

	for ( const field of fields ) {
		for ( const key of field.rest?.fields ?? [] ) {
			keys.add( key );
		}
	}

	return Array.from( keys );
}

export interface ResultSummary {
	ok: number[];
	failed: Array< { id: number; message: string } >;
}

export function summarize( response: ActionResponse ): ResultSummary {
	const ok: number[] = [];
	const failed: Array< { id: number; message: string } > = [];

	for ( const result of response.results ) {
		if ( result.ok ) {
			ok.push( result.id );
		} else {
			failed.push( { id: result.id, message: result.message ?? __( 'The action failed.', 'wp-woocommerce-products-list' ) } );
		}
	}

	return { ok, failed };
}

export function errorMessage( error: unknown ): string {
	return error instanceof Error && error.message ? error.message : __( 'The request failed.', 'wp-woocommerce-products-list' );
}

/** Wrap `isEligible` so placeholder rows never get an action, and scope is honoured. */
export function withScope( action: ProductAction ): ProductAction {
	const inner = action.isEligible;
	const scope = action.scope ?? 'both';

	return {
		...action,
		isEligible: ( item ) => {
			if ( ! isRealRow( item ) ) {
				return false;
			}

			if ( scope === 'product' && ! isProduct( item ) ) {
				return false;
			}

			if ( scope === 'variation' && ! isVariationRow( item ) ) {
				return false;
			}

			return inner ? inner( item ) : true;
		},
	};
}
