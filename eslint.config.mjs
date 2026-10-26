// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // legacy/ is upstream's parked tree: never linted, built or shipped (ADR-0005).
  { ignores: ['legacy/', '**/dist/', '**/coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Build and CI scripts run in Node.
    files: ['scripts/**', 'tools/**', '*.mjs', 'apps/*/scripts/**', 'packages/server/deploy/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests index into arrays they have just built; `!` there is noise, not risk.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      // The legacy harness deletes require.cache entries on purpose, so that
      // each \$ flavour gets a fresh jsparse instance.
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },
);
