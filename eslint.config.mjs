// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // node:test's describe/it return promises that the runner itself awaits.
      // Callers are meant to drop them, so they aren't floating in the usual sense.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
    },
  },
  {
    // Test doubles are `async` to satisfy a promise-returning interface, not
    // because they await anything.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'eslint.config.js'],
  }
)
