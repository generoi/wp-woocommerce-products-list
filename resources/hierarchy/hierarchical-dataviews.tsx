/**
 * DataViews 20 plus the hierarchy props of gutenberg#83316
 * (`getItemParentId`, `getItemHasChildren`, `expandedItemIds`,
 * `onChangeExpandedItemIds`). Published DataViews only knows `getItemLevel`
 * + `view.showLevels`, so this wrapper:
 *
 * - takes `data` already flattened by useHierarchy (parents, expanded
 *   children, placeholders), which is also what upstream expects once it
 *   hides collapsed descendants itself;
 * - wires `getItemLevel` from `_level` so `showLevels: true` works the day
 *   the chevron is dropped;
 * - keeps placeholder rows out of the selection (the header checkbox
 *   selects every row in `data`);
 * - disables DataViews' item click (a button inside the title link would be
 *   invalid HTML): the name field renders its own link;
 * - provides HierarchyViewContext for the name field's chevron;
 * - names a variation's checkbox after its parent too ("Aylla Chiri — 38",
 *   not just "38"), so a screen reader hears which product it selects;
 * - shift-click on a checkbox selects (or clears) the range from the last
 *   one clicked, as in WordPress's own lists.
 *
 * Quick and bulk edit are not part of the table: they open in the
 * slide-in panel beside it (edit/editor-panel.tsx).
 *
 * Migration: see docs/hierarchy-upstream.md.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from '@wordpress/element';
import { DataViews } from '../dataviews';
import type { DataViewsProps, Field } from '../dataviews';
import { isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import { HierarchyViewProvider } from './context';
import type { HierarchyViewValue } from './context';
import { getItemLevel as defaultGetItemLevel } from './use-hierarchy';

export type HierarchicalDataViewsProps = DataViewsProps< ProductListItem > & HierarchyViewValue;

const neverClickable = () => false;

/** Selection ids of placeholder rows look like "12:loading"; real ids are numeric. */
export function withoutPlaceholderIds( ids: string[] ): string[] {
	return ids.filter( ( id ) => ! id.includes( ':' ) );
}

/**
 * The title field with a variation's value prefixed by its parent's name.
 * DataViews reads the title field's `getValue` for the row checkbox's
 * accessible name; the cell itself has its own `render`.
 */
export function withVariationTitles< F extends Field< ProductListItem > >( fields: F[], titleFieldId: string | undefined ): F[] {
	return fields.map( ( field ) => {
		if ( field.id !== titleFieldId ) {
			return field;
		}

		const getValue = field.getValue;

		return {
			...field,
			getValue: ( args: { item: ProductListItem } ) => {
				const value = getValue ? getValue( args ) : ( args.item as Record< string, unknown > )[ field.id ];
				const parentName = args.item._level > 0 ? args.item._parentName : undefined;

				return parentName && typeof value === 'string' && value !== '' && ! value.startsWith( parentName ) ? `${ parentName } — ${ value }` : value;
			},
		};
	} );
}

/**
 * The selection after a shift-click: `next` toggled one row; the rows of
 * `data` between `anchor` and that row get the same state. Anything else
 * (no anchor, the header checkbox, a row no longer in `data`) is `next`.
 */
export function rangeSelection( data: ProductListItem[], getItemId: ( item: ProductListItem ) => string, previous: string[], next: string[], anchor: string | null ): string[] {
	const before = new Set( previous );
	const after = new Set( next );
	const added = next.filter( ( id ) => ! before.has( id ) );
	const removed = previous.filter( ( id ) => ! after.has( id ) );

	if ( ! anchor || added.length + removed.length !== 1 ) {
		return next;
	}

	const target = ( added[ 0 ] ?? removed[ 0 ] ) as string;
	const ids = data.filter( ( item ) => ! isPlaceholderRow( item ) ).map( getItemId );
	const from = ids.indexOf( anchor );
	const to = ids.indexOf( target );

	if ( from < 0 || to < 0 || from === to ) {
		return next;
	}

	const range = ids.slice( Math.min( from, to ), Math.max( from, to ) + 1 );

	if ( added.length ) {
		const out = next.slice();
		const have = new Set( out );

		for ( const id of range ) {
			if ( ! have.has( id ) ) {
				out.push( id );
			}
		}

		return out;
	}

	const drop = new Set( range );

	return next.filter( ( id ) => ! drop.has( id ) );
}

/** Whether a click (about to toggle a row checkbox) held Shift. */
function isShiftCheckboxClick( event: MouseEvent ): boolean {
	const target = event.target as HTMLElement | null;

	return event.shiftKey && Boolean( target?.closest?.( '.dataviews-selection-checkbox' ) );
}

export function HierarchicalDataViews( props: HierarchicalDataViewsProps ) {
	const {
		getItemParentId,
		getItemHasChildren,
		expandedItemIds,
		onChangeExpandedItemIds,
		childrenState,
		onRetryChildren,
		searchMatchIds,
		variationFilterActive,
		onShowAllChildren,
		onShowMatchingChildren,
		onChangeSelection,
		selection,
		getItemLevel = defaultGetItemLevel,
		isItemClickable = neverClickable,
		fields,
		...dataViewsProps
	} = props;

	const titledFields = useMemo( () => withVariationTitles( fields, props.view.titleField ), [ fields, props.view.titleField ] );

	const viewValue = useMemo< HierarchyViewValue >(
		() => ( { getItemParentId, getItemHasChildren, expandedItemIds, onChangeExpandedItemIds, childrenState, onRetryChildren, searchMatchIds, variationFilterActive, onShowAllChildren, onShowMatchingChildren } ),
		[ getItemParentId, getItemHasChildren, expandedItemIds, onChangeExpandedItemIds, childrenState, onRetryChildren, searchMatchIds, variationFilterActive, onShowAllChildren, onShowMatchingChildren ]
	);

	const cleanSelection = useMemo( () => ( selection ? withoutPlaceholderIds( selection ) : selection ), [ selection ] );

	// Shift-click range selection: the modifier of the click that is about to
	// toggle a checkbox (a window capture listener runs before React's), and
	// the row toggled last.
	const shiftRef = useRef( false );
	const anchorRef = useRef< string | null >( null );
	const latestRef = useRef( { data: props.data, selection: cleanSelection ?? [], getItemId: props.getItemId } );
	useLayoutEffect( () => {
		latestRef.current = { data: props.data, selection: cleanSelection ?? [], getItemId: props.getItemId };
	} );

	useEffect( () => {
		const onClick = ( event: MouseEvent ) => {
			shiftRef.current = isShiftCheckboxClick( event );
		};

		window.addEventListener( 'click', onClick, true );

		return () => window.removeEventListener( 'click', onClick, true );
	}, [] );

	const handleSelection = useCallback(
		( ids: string[] ) => {
			const { data, selection: previous, getItemId } = latestRef.current;
			const next = withoutPlaceholderIds( ids );
			const shift = shiftRef.current;
			shiftRef.current = false;

			const before = new Set( previous );
			const after = new Set( next );
			const toggled = [ ...next.filter( ( id ) => ! before.has( id ) ), ...previous.filter( ( id ) => ! after.has( id ) ) ];
			const resolved = shift && getItemId ? rangeSelection( data, getItemId, previous, next, anchorRef.current ) : next;

			// One row toggled is the next range's anchor; a page-wide change resets it.
			anchorRef.current = toggled.length === 1 ? ( toggled[ 0 ] as string ) : null;
			onChangeSelection?.( resolved );
		},
		[ onChangeSelection ]
	);

	return (
		<HierarchyViewProvider value={ viewValue }>
			<DataViews< ProductListItem >
				{ ...( dataViewsProps as DataViewsProps< ProductListItem > ) }
				fields={ titledFields }
				getItemLevel={ getItemLevel }
				isItemClickable={ isItemClickable }
				selection={ cleanSelection }
				onChangeSelection={ onChangeSelection ? handleSelection : undefined }
			/>
		</HierarchyViewProvider>
	);
}

/** True for rows DataViews should not offer actions on. */
export function isActionableRow( item: ProductListItem ): boolean {
	return ! isPlaceholderRow( item );
}
