/**
 * The wp-scripts configuration with three changes: the entry is
 * resources/index.tsx (there is no src/ of JavaScript; src/ is PHP), the RTL
 * stylesheet is not generated, and that is all. DependencyExtractionWebpackPlugin
 * stays: it externalises react, react-dom and the wp-* packages to the handles
 * WordPress ships and bundles @wordpress/dataviews, ui and icons, which
 * WordPress does not.
 */
const path = require( 'path' );
const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );

const base = Array.isArray( defaultConfig ) ? defaultConfig[ 0 ] : defaultConfig;

module.exports = {
	...base,
	entry: {
		index: path.resolve( __dirname, 'resources/index.tsx' ),
	},
	output: {
		...base.output,
		path: path.resolve( __dirname, 'build' ),
	},
	plugins: base.plugins.filter(
		( plugin ) => plugin.constructor.name !== 'RtlCssPlugin'
	),
	performance: {
		hints: false,
	},
};
