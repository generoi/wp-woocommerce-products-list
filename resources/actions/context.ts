/**
 * What every action factory receives, and the helpers they share: ids of
 * real rows, the `_fields` for refreshed rows, result summaries.
 */
import { createElement, Fragment, useEffect, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import type { RenderModalProps } from '../dataviews';
import { notify } from './notices';
import type { ActionResponse } from '../api/client';
import type { View } from '../dataviews';
import type { Hierarchy } from '../hierarchy/use-hierarchy';
import { actionResultMessage } from '../edit/errors';
import { isVariation } from '../edit/field-value';
import { isRowPending } from '../store/save-activity';
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
	/** Open the inline editor on these rows: one row is a quick edit, several a bulk edit. */
	openEditor?( items: ProductListItem[] ): void;
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

/** Rows an action has processed leave the selection, so the next action cannot silently target them again. */
export function dropFromSelection( context: Pick< ProductActionsContext, 'selection' | 'onChangeSelection' >, ids: number[] ): void {
	if ( ! context.onChangeSelection || ! ids.length ) {
		return;
	}

	const done = new Set( ids.map( String ) );
	const current = context.selection ?? [];
	const kept = current.filter( ( id ) => ! done.has( id ) );

	if ( kept.length !== current.length ) {
		context.onChangeSelection( kept );
	}
}

export interface ResultSummary {
	ok: number[];
	failed: Array< { id: number; message: string; code?: string } >;
}

export function summarize( response: ActionResponse ): ResultSummary {
	const ok: number[] = [];
	const failed: Array< { id: number; message: string; code?: string } > = [];

	for ( const result of response.results ) {
		if ( result.ok ) {
			ok.push( result.id );
		} else {
			failed.push( { id: result.id, message: actionResultMessage( result.code, result.message ), ...( result.code ? { code: result.code } : {} ) } );
		}
	}

	return { ok, failed };
}

export function errorMessage( error: unknown ): string {
	return error instanceof Error && error.message ? error.message : __( 'The request failed.', 'wp-woocommerce-products-list' );
}

/**
 * Actions that only read or navigate: they stay available on rows a save in
 * flight has locked. Every other action (core, declarative or registered)
 * leaves locked rows alone.
 */
export const READ_ONLY_ACTIONS: ReadonlySet< string > = new Set( [ 'view', 'history', 'expand', 'select-variations', 'select-variations-outofstock' ] );

/** Whether a save in flight in this tab has locked the row (itself or its parent). */
export function isLockedRow( item: ProductListItem ): boolean {
	return isRowPending( item.id ) || isRowPending( item.parent_id );
}

/** The rows an action may act on now: the locked ones are left out with a notice. Null when none is left. */
export function withoutLockedRows( items: ProductListItem[] ): ProductListItem[] | null {
	const free = items.filter( ( item ) => ! isLockedRow( item ) );

	if ( free.length < items.length ) {
		notify.info(
			free.length
				? __( 'Some selected rows are still being updated; they were left out.', 'wp-woocommerce-products-list' )
				: __( 'These rows are still being updated. Try again once the update is done.', 'wp-woocommerce-products-list' )
		);
	}

	return free.length ? free : null;
}

/**
 * Keep an action off the rows a save in flight has locked (this tab's
 * guard; other tabs and users are stopped server-side). `isEligible` hides
 * it on such a row; the callback and modal also drop locked rows at call
 * time, since a memoised table row (and the footer's bulk actions, which
 * get the whole selection) may still offer it.
 */
function lockAware( action: ProductAction ): ProductAction {
	if ( READ_ONLY_ACTIONS.has( action.id ) ) {
		return action;
	}

	if ( 'RenderModal' in action && action.RenderModal ) {
		const Inner = action.RenderModal;
		const RenderModal = ( props: RenderModalProps< ProductListItem > ) => {
			// Checked once, when the modal opens.
			const [ items ] = useState( () => props.items.filter( ( item ) => ! isLockedRow( item ) ) );
			const none = items.length === 0;

			useEffect( () => {
				if ( items.length < props.items.length ) {
					withoutLockedRows( props.items );
				}

				if ( none ) {
					props.closeModal?.();
				}
				// Once per opening.
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [] );

			return none ? createElement( Fragment ) : createElement( Inner, { ...props, items } );
		};

		return { ...action, RenderModal };
	}

	if ( 'callback' in action && typeof action.callback === 'function' ) {
		const callback = action.callback;

		return {
			...action,
			callback: ( items, context ) => {
				const free = withoutLockedRows( items );

				if ( free ) {
					return callback( free, context );
				}

				return undefined;
			},
		};
	}

	return action;
}

/** Wrap `isEligible` so placeholder rows never get an action, rows a save has locked get only read-only ones, and scope is honoured. */
export function withScope( action: ProductAction ): ProductAction {
	const inner = action.isEligible;
	const scope = action.scope ?? 'both';
	const readOnly = READ_ONLY_ACTIONS.has( action.id );

	return {
		...lockAware( action ),
		isEligible: ( item ) => {
			if ( ! isRealRow( item ) ) {
				return false;
			}

			if ( ! readOnly && isLockedRow( item ) ) {
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
