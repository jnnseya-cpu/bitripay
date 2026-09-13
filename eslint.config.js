// Flat ESLint config for every layer. Type-aware rules are left to `tsc --noEmit` (npm run typecheck).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const reactNativeGlobals = {
  __DEV__: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  navigator: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
  require: 'readonly',
  globalThis: 'readonly',
  AbortController: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  Blob: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  crypto: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  WebSocket: 'readonly',
  Intl: 'readonly',
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.expo/**', 'shots/**', 'integrations/**', 'docs/**', '**/*.d.ts', 'frontend/*/android/**', 'frontend/*/ios/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['backend/api/src/**/*.ts', 'shared/**/src/**/*.ts', '*.js', '*.mjs', 'frontend/*/*.js', 'frontend/*/*.cjs', 'frontend/*/*.mjs', 'frontend/*/modules/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright flows: Node scripts whose page.evaluate callbacks run in the browser.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['frontend/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['frontend/web/src/**/*.{ts,tsx}', 'frontend/admin/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['frontend/mobile/**/*.{ts,tsx}', 'frontend/payout-device/**/*.{ts,tsx}'],
    languageOptions: { globals: reactNativeGlobals },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    rules: {
      // Money-platform code deliberately passes loosely typed database rows around; strict typing is enforced by tsc.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'error',
    },
  },
);
