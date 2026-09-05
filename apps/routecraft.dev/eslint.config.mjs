import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      // Build output, the generated route tree, and generated catalogues.
      '.output/**',
      '.nitro/**',
      '.tanstack/**',
      'app/routeTree.gen.ts',
      'app/lib/generated/**',
      'app/content/docs-next/**',
      // Fixtures the example typecheck generates from the fenced blocks.
      // Extracted verbatim, so many are fragments that do not parse alone.
      '.docs-typecheck/**',
      '.docs-typecheck-test/**',
      'public/**',
      'baseline/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,
      // The runtime injects the JSX factory, so components need no React import.
      'react/react-in-jsx-scope': 'off',
      // Types carry the contract; duplicating it as propTypes adds nothing.
      'react/prop-types': 'off',
    },
    settings: { react: { version: 'detect' } },
  },
]

export default config
