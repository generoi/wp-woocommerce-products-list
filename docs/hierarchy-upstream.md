# Hierarchy: how we mirror gutenberg#83316 and how to switch to it

`@wordpress/dataviews` 20 has no expand/collapse. Upstream is tracking it in
[gutenberg#80360](https://github.com/WordPress/gutenberg/issues/80360) with draft PRs
[#83315](https://github.com/WordPress/gutenberg/pull/83315) (`getItemParentId`),
[#83316](https://github.com/WordPress/gutenberg/pull/83316) (`getItemHasChildren`,
`expandedItemIds`, `onChangeExpandedItemIds`) and
[#83320](https://github.com/WordPress/gutenberg/pull/83320) (per-level pagination).
`resources/hierarchy/` implements the same contract on top of what is published, so the
switch is a prop rename at most.

## What upstream (#83316) does

- `data` is one flat list; `getItemParentId( item )` nests rows under their parent.
- `getItemHasChildren( item )` decides who gets a disclosure control. `undefined` child
  state counts as expandable so children can be discovered lazily.
- `expandedItemIds` / `onChangeExpandedItemIds` are owned by the consumer ("so it can
  coordinate with lazy loading without persisting item ids in `view`"). DataViews hides
  the loaded descendants of collapsed rows.
- A disclosure per row, one in the table header for all loaded parents, keyboard
  reachable (Tab, Enter/Space). The disclosure, the checkbox and the content indent
  together in the primary column.
- Selection is per row; selecting a parent does not select its children.
- Fetching, loading/error states and "load more" per parent are explicitly out of scope
  and stay with the consumer.

## What we do today

| Concern | Ours (dataviews 20) | After upstream |
| --- | --- | --- |
| Props | `HierarchicalDataViews` takes the #83316 names plus `childrenState` and `onRetryChildren` | pass the same names to `DataViews`; drop the two extras |
| Nesting / hiding | `flattenHierarchy()` builds `rows` (parents + expanded children + placeholders) in `useHierarchy`; `data={ hierarchy.rows }` | keep passing `rows` (every child in it is under an expanded parent, so nothing changes) or pass parents + all loaded children and let DataViews hide them |
| Indent | `NameCell` sets `--wc-pl-level`; `getItemLevel` is wired from `_level` so `view.showLevels: true` works without code changes | let DataViews indent; delete the padding rule in `hierarchy/style.scss` |
| Disclosure | `Chevron` inside the name field (`aria-expanded`, `aria-controls`, Arrow keys) | delete `chevron.tsx`'s `Chevron`; `NameCell` keeps the link and placeholders |
| Header expand all | toolbar buttons calling `hierarchy.expandAll()` / `collapseAll()` (concurrency 6, confirm above `EXPAND_ALL_WARN_ROWS` = 600 rows, stops at `EXPAND_ALL_MAX_ROWS` = 1,500) | keep: the header disclosure only toggles *loaded* parents, ours also loads and bounds the page |
| Loading state | placeholder rows (`_placeholder: loading | error | more`) through the same `data` | keep: out of scope upstream |
| Selection | `HierarchicalDataViews` strips placeholder ids (`"12:loading"`) from `selection`/`onChangeSelection`; actions use `isEligible: ( item ) => ! item._placeholder` | keep the `isEligible`; the strip is only needed while placeholder rows exist |
| Persistence | `expandedItemIds` in `sessionStorage` (`wcProductsList.expanded`), bounded per page on load | unchanged (consumer-owned upstream too) |
| Row rendering | `patches/@wordpress__dataviews@20.0.0.patch` memoises table rows (docs/dataviews-patch.md) | drop the patch once upstream rows are memoised, or re-apply it to the new version |
| Per-level pagination (#83320) | `limits.maxChildrenPerParent` cap + a "N more variations are not shown" row | map to the per-level pagination props when they land |

## Switch checklist

1. Bump `@wordpress/dataviews` to the version that ships the props; run `pnpm test`.
2. In `list/products-screen.tsx` replace `HierarchicalDataViews` with `DataViews` from
   `resources/dataviews.ts`, keeping `getItemParentId`, `getItemHasChildren`,
   `expandedItemIds`, `onChangeExpandedItemIds`, `getItemLevel`, `data={ hierarchy.rows }`.
3. Set `showLevels: true` in `list/default-view.ts` if upstream indents only then.
4. Remove `Chevron` from the name field; keep `NameCell` for the link and placeholder
   rows (or render the placeholder message in the title field only).
5. Delete `hierarchical-dataviews.tsx`, `HierarchyViewContext` in `context.tsx`, the
   `.wc-pl-chevron*` rules. `flatten.ts`, `use-hierarchy.ts`, `normalize.ts` stay.
6. Re-run the a11y checks: the upstream disclosure must announce the count we show in the
   badge, otherwise keep the count badge in `NameCell`.
