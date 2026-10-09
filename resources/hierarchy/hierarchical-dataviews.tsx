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
 * - hosts the inline editor: for an editor row (edit/editor-rows.ts) the
 *   title field renders the editor cell and every other field nothing, so
 *   the editor spans the row (edit/editor-context.tsx widens its cell).
 *
 * Migration: see docs/hierarchy-upstream.md.
 */
import { useCallback, useMemo } from '@wordpress/element';
import { DataViews } from '../dataviews';
import type { DataViewRenderFieldProps, DataViewsProps, Field } from '../dataviews';
import { InlineEditorCell } from '../edit/editor-context';
import { isEditorRow, isPlaceholderRow } from '../types/product';
import type { ProductListItem } from '../types/product';
import { HierarchyViewProvider } from './context';
import type { HierarchyViewValue } from './context';
import { getItemLevel as defaultGetItemLevel } from './use-hierarchy';

export type HierarchicalDataViewsProps = DataViewsProps< ProductListItem > & HierarchyViewValue;

const neverClickable = () => false;

/** Selection ids of placeholder and editor rows look like "12:loading" / "editor:12"; real ids are numeric. */
export function withoutPlaceholderIds( ids: string[] ): string[] {
	return ids.filter( ( id ) => ! id.includes( ':' ) );
}

type RenderProps = DataViewRenderFieldProps< ProductListItem >;

/**
 * The same fields with their `render` aware of the editor row: the host
 * field (the view's title field) renders the editor cell into it, the
 * others nothing. Fields without a `render` are left alone (DataViews'
 * default renders the editor row's empty value). Memoised per `fields`
 * and host so DataViews' row memo keeps working.
 */
export function withEditorRenders< F extends Field< ProductListItem > >( fields: F[], hostFieldId: string | undefined ): F[] {
	return fields.map( ( field ) => {
		const Original = field.render;
		const isHost = field.id === hostFieldId;

		if ( ! Original && ! isHost ) {
			return field;
		}

		const render = ( props: RenderProps ) => {
			if ( isEditorRow( props.item ) ) {
				return isHost ? <InlineEditorCell item={ props.item } /> : null;
			}

			return Original ? <Original { ...props } /> : <>{ field.getValue?.( { item: props.item } ) as string }</>;
		};

		return { ...field, render };
	} );
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
		onChangeSelection,
		selection,
		getItemLevel = defaultGetItemLevel,
		isItemClickable = neverClickable,
		fields,
		...dataViewsProps
	} = props;

	const hostFieldId = props.view.titleField ?? props.view.fields?.[ 0 ];
	const editorFields = useMemo( () => withEditorRenders( fields, hostFieldId ), [ fields, hostFieldId ] );

	const viewValue = useMemo< HierarchyViewValue >(
		() => ( { getItemParentId, getItemHasChildren, expandedItemIds, onChangeExpandedItemIds, childrenState, onRetryChildren, searchMatchIds } ),
		[ getItemParentId, getItemHasChildren, expandedItemIds, onChangeExpandedItemIds, childrenState, onRetryChildren, searchMatchIds ]
	);

	const handleSelection = useCallback(
		( ids: string[] ) => {
			onChangeSelection?.( withoutPlaceholderIds( ids ) );
		},
		[ onChangeSelection ]
	);

	const cleanSelection = useMemo( () => ( selection ? withoutPlaceholderIds( selection ) : selection ), [ selection ] );

	return (
		<HierarchyViewProvider value={ viewValue }>
			<DataViews< ProductListItem >
				{ ...( dataViewsProps as DataViewsProps< ProductListItem > ) }
				fields={ editorFields }
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
	return ! isPlaceholderRow( item ) && ! isEditorRow( item );
}
