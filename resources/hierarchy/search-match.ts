/**
 * A search by a variation's SKU or barcode lists its parent (the server
 * matches each token against the product's name and SKU and its variations'
 * SKUs). For a scan you want the variation itself, so the parents that can
 * only have matched through a variation are expanded and the matching
 * variation rows are marked and scrolled into view.
 */
import { decodeEntities } from '@wordpress/html-entities';
import { useEffect, useMemo, useRef } from '@wordpress/element';
import type { ProductListItem, ProductRow } from '../types/product';
import { rowDomId } from './chevron';

/** Parents expanded at most per search: a broad term should not turn into "Expand all". */
export const MAX_SEARCH_EXPANDS = 10;

export function searchTokens( search: string | undefined ): string[] {
	return ( search ?? '' )
		.toLowerCase()
		.split( /\s+/ )
		.map( ( token ) => token.trim() )
		.filter( Boolean );
}

function ownText( row: ProductListItem ): string {
	const name = typeof row.name === 'string' ? decodeEntities( row.name ) : '';
	const sku = typeof ( row as { sku?: unknown } ).sku === 'string' ? ( row as { sku: string } ).sku : '';

	return `${ name }\n${ sku }`.toLowerCase();
}

/** The tokens the row's own name and SKU do not contain. */
function unmatchedTokens( row: ProductListItem, tokens: string[] ): string[] {
	const text = ownText( row );

	return tokens.filter( ( token ) => ! text.includes( token ) );
}

/** Variable parents on the page that matched the search only through a variation's SKU. */
export function parentsMatchedByVariations( parents: ProductRow[], tokens: string[] ): number[] {
	if ( ! tokens.length ) {
		return [];
	}

	return parents.filter( ( parent ) => parent._hasChildren && ! parent._noLongerMatches && unmatchedTokens( parent, tokens ).length > 0 ).map( ( parent ) => parent.id );
}

/** Variation rows whose SKU contains a token their parent's own name and SKU do not. */
export function variationSearchMatches( rows: ProductListItem[], tokens: string[] ): Set< number > {
	const matches = new Set< number >();

	if ( ! tokens.length ) {
		return matches;
	}

	const parentTokens = new Map< number, string[] >();

	for ( const row of rows ) {
		if ( row._kind === 'product' ) {
			parentTokens.set( row.id, unmatchedTokens( row, tokens ) );
			continue;
		}

		if ( row._kind !== 'variation' || row._placeholder || row._parentId === null ) {
			continue;
		}

		const wanted = parentTokens.get( row._parentId ) ?? tokens;
		const sku = String( ( row as { sku?: unknown } ).sku ?? '' ).toLowerCase();

		if ( sku && wanted.some( ( token ) => sku.includes( token ) ) ) {
			matches.add( row.id );
		}
	}

	return matches;
}

interface RevealOptions {
	search: string | undefined;
	parents: ProductRow[];
	rows: ProductListItem[];
	isFetching: boolean;
	isExpanded( id: number ): boolean;
	expand( id: number ): Promise< void >;
	/** Defaults to the document's row element scrolled into view. */
	reveal?( row: ProductListItem ): void;
}

function scrollRowIntoView( row: ProductListItem ): void {
	const element = typeof document !== 'undefined' ? document.getElementById( rowDomId( row ) ) : null;
	element?.closest( 'tr' )?.scrollIntoView?.( { block: 'nearest' } );
}

/**
 * Expand the parents a search matched through a variation (once per search
 * and page, so a parent the user collapses stays collapsed), and return the
 * ids of the matching variation rows. The first match is scrolled into view
 * without moving focus, so a scanner can keep typing into the search box.
 */
export function useSearchReveal( { search, parents, rows, isFetching, isExpanded, expand, reveal = scrollRowIntoView }: RevealOptions ): ReadonlySet< number > {
	const tokens = useMemo( () => searchTokens( search ), [ search ] );
	const handledRef = useRef< string | null >( null );
	const pendingRevealRef = useRef( false );

	useEffect( () => {
		if ( isFetching || ! tokens.length ) {
			if ( ! tokens.length ) {
				handledRef.current = null;
			}

			return;
		}

		const candidates = parentsMatchedByVariations( parents, tokens ).slice( 0, MAX_SEARCH_EXPANDS );
		const key = `${ tokens.join( ' ' ) }|${ parents.map( ( parent ) => parent.id ).join( ',' ) }`;

		if ( handledRef.current === key ) {
			return;
		}

		handledRef.current = key;

		if ( ! candidates.length ) {
			return;
		}

		pendingRevealRef.current = true;

		for ( const id of candidates ) {
			if ( ! isExpanded( id ) ) {
				void expand( id ).catch( () => {} );
			}
		}
	}, [ tokens, parents, isFetching, isExpanded, expand ] );

	const matches = useMemo( () => variationSearchMatches( rows, tokens ), [ rows, tokens ] );

	useEffect( () => {
		if ( ! pendingRevealRef.current || ! matches.size ) {
			return;
		}

		const first = rows.find( ( row ) => matches.has( row.id ) && row._kind === 'variation' );

		if ( first ) {
			pendingRevealRef.current = false;
			reveal( first );
		}
	}, [ matches, rows, reveal ] );

	return matches;
}
