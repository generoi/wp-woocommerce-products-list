import { Suspense, lazy, useMemo } from '@wordpress/element';
import { getQueryArg } from '@wordpress/url';
import { useRegistryVersion } from './extensions/api';
import { createProductFields } from './fields/registry';
import { ProductsScreen } from './list/products-screen';
import { getSettings } from './settings';
import { ErrorBoundary, Spinner } from './ui';

// The History screen is its own chunk: most visits never open it.
const HistoryScreen = lazy( () => import( /* webpackChunkName: "history" */ './history/history-screen' ) );

/**
 * Builds the field list once per settings payload and registry version
 * (extensions have registered by now: `wcProductsList.ready` fired before
 * mount; a late `registerField` bumps the version) and picks the screen
 * from `?screen=`.
 */
export function App() {
	const settings = getSettings();
	const version = useRegistryVersion();
	// eslint-disable-next-line react-hooks/exhaustive-deps -- version is the registry's change counter
	const fields = useMemo( () => createProductFields( settings ), [ settings, version ] );
	const screen = getQueryArg( window.location.href, 'screen' );

	if ( screen === 'history' ) {
		return (
			<ErrorBoundary context="history">
				<Suspense fallback={ <div className="wc-products-list__placeholder"><Spinner /></div> }>
					<HistoryScreen fields={ fields } />
				</Suspense>
			</ErrorBoundary>
		);
	}

	return (
		<ErrorBoundary context="catalog">
			<ProductsScreen fields={ fields } settings={ settings } />
		</ErrorBoundary>
	);
}
