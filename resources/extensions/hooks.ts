/**
 * wp.hooks names. Filters receive and return the value named; actions get
 * the payload named. See docs/contracts.md §8 and docs/extension-api.md.
 */
export const HOOK_NAMESPACE = 'wcProductsList';

export const FILTERS = {
	/** ( fields: ProductField[], settings: Settings ) => ProductField[] */
	fields: 'wcProductsList.fields',
	/** ( actions: ProductAction[], settings: Settings ) => ProductAction[] */
	actions: 'wcProductsList.actions',
	/** ( params: QueryParams, context: QueryContext ) => QueryParams — the wc/v3 products list request */
	query: 'wcProductsList.query',
	/** ( params: QueryParams, context: { parentId: number; page: number } ) => QueryParams */
	variationsQuery: 'wcProductsList.variationsQuery',
	/** ( item: ProductListItem ) => ProductListItem — every row after fetch, before cache */
	item: 'wcProductsList.item',
	/** ( payload: Record<string, unknown>, item: ProductListItem, edits: Record<string, unknown> ) => payload */
	savePayload: 'wcProductsList.savePayload',
	/** ( view: View, settings: Settings ) => View */
	defaultView: 'wcProductsList.defaultView',
	/** ( tabs: StatusTab[], counts: Counts ) => StatusTab[] */
	statusTabs: 'wcProductsList.statusTabs',
	/** ( tabs: QuickEditTab[], items: ProductListItem[] ) => QuickEditTab[] */
	quickEditTabs: 'wcProductsList.quickEdit.tabs',
	/** ( layout: Form, tab: QuickEditTab, items: ProductListItem[] ) => Form */
	quickEditLayout: 'wcProductsList.quickEdit.layout',
	/** ( fieldIds: string[] ) => string[] — fields that get the set/increase/decrease control */
	bulkNumericFields: 'wcProductsList.bulkNumericFields',
} as const;

export const ACTIONS = {
	/** ( api: ExtensionApi ) — window.wcProductsList exists, before mount */
	ready: 'wcProductsList.ready',
	/** ( items: ProductListItem[], context: { tab: string; view: View; total: number } ) */
	loaded: 'wcProductsList.loaded',
	/** ( result: BatchResult, context: { source: string } ) */
	saved: 'wcProductsList.saved',
	/** ( ids: number[], context: { action: 'trash' | 'delete'; batchId: string } ) */
	deleted: 'wcProductsList.deleted',
} as const;

export type FilterName = ( typeof FILTERS )[ keyof typeof FILTERS ];

export type ActionName = ( typeof ACTIONS )[ keyof typeof ACTIONS ];

/**
 * The namespace an extension should pass as the third argument of
 * `addFilter`/`addAction` when it has no better one: `hookNamespace( 'gds-woo-i18n' )`
 * → `gds-woo-i18n/wc-products-list`.
 */
export function hookNamespace( extensionId: string ): string {
	return `${ extensionId }/wc-products-list`;
}
