/**
 * The expand/collapse control and the name cell that hosts it.
 *
 * Rendered by the `name` field inside DataViews, so it reads the
 * hierarchy view that HierarchicalDataViews provides and nothing else,
 * through per-row subscriptions (`useHierarchyRowView`): expanding one
 * parent re-renders that parent's cell, not every name cell of the page. Plain elements, no component library: the cell renders up to a
 * thousand times per page and must stay cheap.
 */
import { Icon, chevronRightSmall } from '@wordpress/icons';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { getItemId, isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import { useHierarchyRowView, useHierarchyViewGetter } from './context';
import type { HierarchyViewValue } from './context';
import type { ChildrenState } from './flatten';

export const ROW_ID_PREFIX = 'wc-pl-row-';

/** The DOM id of a row's name cell, what a parent's chevron `aria-controls`. */
export function rowDomId( item: ProductListItem ): string {
	return ROW_ID_PREFIX + getItemId( item ).replace( ':', '-' );
}

function stop( event: MouseEvent | KeyboardEvent ): void {
	event.preventDefault();
	event.stopPropagation();
}

export function Chevron( { item }: { item: ProductListItem } ) {
	const { view, expanded, state } = useHierarchyRowView( item.id );
	const current = useHierarchyViewGetter();

	if ( ! view || ! view.getItemHasChildren( item ) ) {
		return <span className="wc-pl-chevron wc-pl-chevron--spacer" aria-hidden="true" />;
	}

	const loading = expanded && ( ! state || state.status === 'idle' || state.status === 'loading' );
	const count = state?.status === 'loaded' ? Math.max( state.total, state.items.length ) : item._childCount;
	const label = expanded
		? sprintf(
				/* translators: %d: number of variations */
				_n( 'Collapse %d variation', 'Collapse %d variations', count, 'wp-woocommerce-products-list' ),
				count
		  )
		: sprintf(
				/* translators: %d: number of variations */
				_n( 'Expand %d variation', 'Expand %d variations', count, 'wp-woocommerce-products-list' ),
				count
		  );

	const toggle = ( event: MouseEvent | KeyboardEvent ) => {
		stop( event );
		set( current() ?? view, item.id, ! expanded );
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLButtonElement > ) => {
		if ( event.key === 'ArrowRight' && ! expanded ) {
			stop( event );
			set( current() ?? view, item.id, true );
		} else if ( event.key === 'ArrowLeft' && expanded ) {
			stop( event );
			set( current() ?? view, item.id, false );
		}
	};

	return (
		<button
			type="button"
			className={ 'wc-pl-chevron' + ( expanded ? ' is-expanded' : '' ) + ( loading ? ' is-loading' : '' ) }
			aria-expanded={ expanded }
			aria-controls={ expanded ? controlledIds( item, state ) : undefined }
			aria-label={ label }
			title={ label }
			onClick={ toggle }
			onKeyDown={ onKeyDown }
			onMouseDown={ ( event ) => event.stopPropagation() }
		>
			<Icon icon={ chevronRightSmall } size={ 24 } />
			{ count > 0 && (
				<span className="wc-pl-chevron__count" aria-hidden="true">
					{ count }
				</span>
			) }
		</button>
	);
}

function set( view: HierarchyViewValue, id: number, expanded: boolean ): void {
	const current = view.expandedItemIds;

	view.onChangeExpandedItemIds( expanded ? ( current.includes( id ) ? current : [ ...current, id ] ) : current.filter( ( other ) => other !== id ) );
}

/** An IDREF list of what the button controls: the loaded rows, else the one placeholder row of the current state. */
function controlledIds( parent: ProductListItem, state: ChildrenState | undefined ): string | undefined {
	if ( state?.status === 'loaded' && state.items.length ) {
		return state.items.map( rowDomId ).join( ' ' );
	}

	if ( state?.status === 'error' ) {
		return `${ ROW_ID_PREFIX }${ parent.id }-error`;
	}

	return `${ ROW_ID_PREFIX }${ parent.id }-loading`;
}

export interface NameCellProps {
	item: ProductListItem;
	/** The name content (a link, the name, extra badges); defaults to the item's name. */
	children?: ReactNode;
}

/**
 * The name field renders `<NameCell item={ item }>{ link }</NameCell>`:
 * indentation by level, the chevron (or a spacer) for level 0, the
 * placeholder content for loading/error/"more" rows.
 */
export function NameCell( { item, children }: NameCellProps ) {
	const { view, expanded, state, searchMatch, variationFilterActive } = useHierarchyRowView( item.id );
	// Handlers read the value at click time: the cell re-renders only when its own row changes.
	const current = useHierarchyViewGetter();
	const latest = () => current() ?? view;
	const level = item._level ?? 0;

	if ( isPlaceholderRow( item ) ) {
		return (
			<div id={ rowDomId( item ) } className={ `wc-pl-name wc-pl-name--placeholder is-${ item._placeholder }` } style={ { '--wc-pl-level': level } as CSSProperties }>
				<span className="wc-pl-chevron wc-pl-chevron--spacer" aria-hidden="true" />
				<span className="wc-pl-name__placeholder" role={ item._placeholder === 'error' ? 'alert' : 'status' }>
					{ item._placeholder === 'loading' && <span className="wc-pl-spinner" aria-hidden="true" /> }
					{ item._placeholderMessage }
				</span>
				{ item._placeholder === 'error' && view?.onRetryChildren && item._parentId !== null && (
					<button
						type="button"
						className="wc-pl-name__retry"
						onClick={ ( event ) => {
							stop( event );
							latest()?.onRetryChildren?.( item._parentId as number );
						} }
					>
						{ __( 'Retry', 'wp-woocommerce-products-list' ) }
					</button>
				) }
			</div>
		);
	}

	const isSearchMatch = level > 0 && searchMatch;

	return (
		<div id={ rowDomId( item ) } className={ `wc-pl-name wc-pl-name--level-${ level }` + ( isSearchMatch ? ' is-search-match' : '' ) } style={ { '--wc-pl-level': level } as CSSProperties }>
			{ level === 0 ? <Chevron item={ item } /> : <span className="wc-pl-chevron wc-pl-chevron--spacer" aria-hidden="true" /> }
			<span className="wc-pl-name__content">{ children ?? item.name ?? '' }</span>
			{ isSearchMatch && (
				<span className="wc-pl-name__match">
					{ __( 'Matches search', 'wp-woocommerce-products-list' ) }
				</span>
			) }
			{ level === 0 && view && variationFilterActive && expanded && state?.status === 'loaded' && <FilteredChildrenNote item={ item } view={ view } state={ state } latest={ latest } /> }
			{ item._noLongerMatches && (
				<span className="wc-pl-name__stale" title={ __( 'Edited here; it no longer matches the filters and leaves the list when the view changes.', 'wp-woocommerce-products-list' ) }>
					{ __( 'No longer matches', 'wp-woocommerce-products-list' ) }
				</span>
			) }
			{ level > 0 && item._parentName && (
				<span className="screen-reader-text">
					{ sprintf(
						/* translators: %s: the parent product's name */
						__( '(variation of %s)', 'wp-woocommerce-products-list' ),
						item._parentName
					) }
				</span>
			) }
		</div>
	);
}

/**
 * On an expanded parent while a variation-level filter is on: "3 of 15
 * variations match · Show all", or, once opened up, "All 15 variations ·
 * Only matching".
 */
function FilteredChildrenNote( { item, view, state, latest }: { item: ProductListItem; view: HierarchyViewValue; state: ChildrenState; latest: () => HierarchyViewValue | null } ) {
	const all = Math.max( item._childCount, state.filtered ? 0 : state.total );

	if ( state.filtered ) {
		const matching = Math.max( state.total, state.items.length );

		return (
			<span className="wc-pl-name__filtered">
				{ all > 0
					? sprintf(
							/* translators: 1: variations matching the filters, 2: variations of the product */
							_n( '%1$d of %2$d variation matches', '%1$d of %2$d variations match', all, 'wp-woocommerce-products-list' ),
							matching,
							all
					  )
					: sprintf(
							/* translators: %d: variations matching the filters */
							_n( '%d variation matches', '%d variations match', matching, 'wp-woocommerce-products-list' ),
							matching
					  ) }
				{ view.onShowAllChildren && (
					<button
						type="button"
						className="wc-pl-name__filtered-toggle"
						onClick={ ( event ) => {
							stop( event );
							latest()?.onShowAllChildren?.( item.id );
						} }
					>
						{ __( 'Show all', 'wp-woocommerce-products-list' ) }
					</button>
				) }
			</span>
		);
	}

	return (
		<span className="wc-pl-name__filtered">
			{ sprintf(
				/* translators: %d: variations of the product */
				_n( 'All %d variation', 'All %d variations', all, 'wp-woocommerce-products-list' ),
				all
			) }
			{ view.onShowMatchingChildren && (
				<button
					type="button"
					className="wc-pl-name__filtered-toggle"
					onClick={ ( event ) => {
						stop( event );
						latest()?.onShowMatchingChildren?.( item.id );
					} }
				>
					{ __( 'Only matching', 'wp-woocommerce-products-list' ) }
				</button>
			) }
		</span>
	);
}
