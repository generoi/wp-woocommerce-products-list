import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
	{
		ignores: [ 'build/**', 'node_modules/**', 'vendor/**' ],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	reactHooks.configs.flat?.recommended ?? reactHooks.configs[ 'recommended-latest' ],
	{
		files: [ '**/*.{ts,tsx}' ],
		languageOptions: {
			globals: {
				window: 'readonly',
				document: 'readonly',
				console: 'readonly',
				sessionStorage: 'readonly',
				localStorage: 'readonly',
				AbortController: 'readonly',
				AbortSignal: 'readonly',
				crypto: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				URLSearchParams: 'readonly',
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/consistent-type-imports': 'error',
		},
	}
);
