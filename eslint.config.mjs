// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '.kilo/**',
      '.claude/**',
      'coverage/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,

  // Node: the engine, the Electron main process, scripts and tests.
  {
    files: ['core/**/*.ts', 'app/src/main/**/*.ts', 'app/src/preload/**/*.ts', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },

  // The renderer: a browser page with React.
  {
    files: ['app/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // The extension: plain JS in the browser, with the chrome.* APIs.
  {
    files: ['extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    files: ['extension/**/*.test.js'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // TypeScript already resolves every identifier, including type-only
      // namespaces like React.ReactElement that this rule cannot see.
      'no-undef': 'off',
      // tsconfig has noUncheckedIndexedAccess, so `arr[i]` is `T | undefined`
      // even right after a bounds check; `arr[i]!` there is the intended
      // idiom, not a hole in the types.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    rules: {
      // `_`-prefixed parameters are deliberately unused (event signatures).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
