# The `@wordpress/dataviews` patch

`patches/@wordpress__dataviews@20.0.0.patch` (applied by pnpm on install through
`patchedDependencies` in `pnpm-workspace.yaml`) changes `build-wp/index.js`, the
bundle `resources/dataviews.ts` imports, in one respect: **a table row re-renders only
when its own props change**. Without it, every DataViews render (a checkbox toggle, a
patched row, a filter chip) re-rendered every row with its checkbox, actions menu and
cells: 200–840 ms per click on a 90-row page with the development React build, a frozen
tab for most of a minute on 2,500 rows. With it a toggle re-renders one row.

## What it changes

1. `useData` (non-infinite-scroll path) returned `data.map( item => ({ ...item, position:
   undefined }) )` on every render, giving every row a new `item` on every render (which
   also defeated the `memo` around every cell). It now clones through a `WeakMap` keyed by
   the source object and memoises the list on the input array, so an unchanged source row
   keeps its clone.
2. `TableRow` is `memo( TableRowBase, areTableRowPropsEqual )`: every prop is compared by
   identity except `selection` (compared as "is this row selected"), `onChangeSelection`
   and the per-row pointer handlers from `useSelectionProps` (`onMouseDown`,
   `onClickCapture`, `onClick`), which are recreated on every render by design. The row
   no longer reads `DataViewsContext` (its provider value is a new object on every
   render); `ViewTable` passes `totalItems` as a prop instead.
3. Handlers a memoised row keeps from an earlier render must not act on a stale
   selection, so the three places that read it do so through refs refreshed on every
   render: `DataViews`' `setSelectionWithChange` is a `useCallback` over a live ref;
   `DataViewsSelectionCheckbox` toggles through the functional form
   (`onChangeSelection( current => … )`); `useSelectionProps` reads `selection`,
   `onChangeSelection`, the ordered selectable ids and `hasRangeGesture` from a live ref
   inside its handlers (shift-click ranges and ctrl-click toggles stay right).

`tests/js/dataviews-row-memo.test.tsx` renders the patched bundle and asserts the row
render counts, the accumulating toggles and a shift-click range.

## What the app must keep doing

Everything handed to DataViews must be referentially stable between renders, or the memo
is void: `getItemId` and `isItemClickable` are module functions, `actions` and `fields`
are memoised, row objects are replaced (never mutated) when patched, `view` changes only
through `onChangeView`. A new inline arrow for any of these re-renders every row again.

## Upgrading `@wordpress/dataviews`

`pnpm patch @wordpress/dataviews@<new version>` opens the new bundle (with this patch
applied when it still fits); re-apply the four edits above by hand if it does not, run
`pnpm patch-commit <dir>`, then `pnpm test` (the row-memo test fails loudly when the
memo is lost) and `pnpm build`. Drop the patch the day upstream memoises its rows
(watch `src/components/dataviews-layouts/table/index.tsx` for a `memo(` around
`TableRow`).
