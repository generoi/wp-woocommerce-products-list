/**
 * The expand/collapse control and the name cell that hosts it.
 *
 * Rendered by the `name` field inside DataViews, so it reads the
 * HierarchyViewContext that HierarchicalDataViews provides and nothing
 * else. Plain elements, no component library: the cell renders up to a
 * thousand times per page and must stay cheap.
 */
import { Icon, chevronRightSmall } from '@wordpress/icons';
import { __, _n, sprintf } from '@wordpress/i18n';
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { getItemId, isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import { useHierarchyView } from './context';
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
	const view = useHierarchyView();

	if ( ! view || ! view.getItemHasChildren( item ) ) {
		return <span className="wc-pl-chevron wc-pl-chevron--spacer" aria-hidden="true" />;
	}

	const expanded = view.expandedItemIds.includes( item.id );
	const state = view.childrenState?.get( item.id );
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
		set( view, item.id, ! expanded );
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLButtonElement > ) => {
		if ( event.key === 'ArrowRight' && ! expanded ) {
			stop( event );
			set( view, item.id, true );
		} else if ( event.key === 'ArrowLeft' && expanded ) {
			stop( event );
			set( view, item.id, false );
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
	const view = useHierarchyView();
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
							view.onRetryChildren?.( item._parentId as number );
						} }
					>
						{ __( 'Retry', 'wp-woocommerce-products-list' ) }
					</button>
				) }
			</div>
		);
	}

	return (
		<div id={ rowDomId( item ) } className={ `wc-pl-name wc-pl-name--level-${ level }` } style={ { '--wc-pl-level': level } as CSSProperties }>
			{ level === 0 ? <Chevron item={ item } /> : <span className="wc-pl-chevron wc-pl-chevron--spacer" aria-hidden="true" /> }
			<span className="wc-pl-name__content">{ children ?? item.name ?? '' }</span>
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
