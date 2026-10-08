import { defineConfig } from 'vitest/config';

export default defineConfig( {
	test: {
		environment: 'jsdom',
		globals: true,
		include: [ 'tests/js/**/*.test.{ts,tsx}' ],
		setupFiles: [ 'tests/js/setup.ts' ],
		// Heavy suites (the editor renders, the numeric sweeps) run slow when tsc and eslint share the CPU: CI must not flake on a 5 s default.
		testTimeout: 20000,
	},
	resolve: {
		// The wp entry is what the bundle uses; tests see the same code.
		alias: {
			'@wordpress/dataviews/wp': '@wordpress/dataviews',
		},
	},
} );
