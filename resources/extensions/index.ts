/**
 * The extension model: hook names, the `window.wcProductsList` api and its
 * registries, and the declarative (PHP) definitions → field/action
 * conversion. See docs/extension-api.md.
 */
export { ACTIONS, FILTERS, HOOK_NAMESPACE, hookNamespace } from './hooks';
export type { ActionName, FilterName } from './hooks';

export {
	addQueryParams,
	applyQueryParamCallbacks,
	createExtensionApi,
	getExtensionApi,
	getQueryParamCallbacks,
	getQuickEditTabs,
	getRegisteredActions,
	getRegisteredFields,
	getRegistryVersion,
	hasFilterMapping,
	normalizeRegisteredField,
	registerAction,
	registerField,
	registerQuickEditTab,
	resetRegistry,
	subscribeRegistry,
	useRegistryVersion,
} from './api';
export type { ExtensionApiDeps, ExtensionHooks, LooseProductField, ProductsListApi, QueryParamsCallback } from './api';

export {
	actionFromDeclarative,
	actionableIds,
	actionsFromSettings,
	currencyForField,
	defaultArgs,
	fieldFromDeclarative,
	fieldsFromSettings,
	filterFromDeclarative,
	formatMoney,
	getPath,
	isEmptyValue,
	parseDecimal,
	setPath,
} from './declarative';
export type {
	ActionResponse,
	ActionResult,
	ActionRunner,
	DeclarativeFieldExtras,
	DeclarativeFieldInput,
	DeclarativeProductField,
	FieldCurrency,
	ToParams,
} from './declarative';
