// Flat ESLint config for the three layers. Type-aware rules are left to `tsc --noEmit` (npm run typecheck).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'shots/**', 'frontend/mobile/**', 'frontend/payout-device/**', 'integrations/**', 'docs/**', '**/*.d.ts', '**/*.mjs', '**/*.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['backend/api/src/**/*.ts', 'shared/**/src/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['frontend/web/src/**/*.{ts,tsx}', 'frontend/admin/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    rules: {
      // Money-platform code deliberately passes loosely typed database rows around; strict typing is enforced by tsc.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': 'error',
    },
  },
);
