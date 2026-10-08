import { defineConfig } from 'vitest/config';

export default defineConfig( {
	test: {
		environment: 'jsdom',
		globals: true,
		include: [ 'tests/js/**/*.test.{ts,tsx}' ],
		setupFiles: [ 'tests/js/setup.ts' ],
	},
	resolve: {
		// The wp entry is what the bundle uses; tests see the same code.
		alias: {
			'@wordpress/dataviews/wp': '@wordpress/dataviews',
		},
	},
} );
