import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      '.next/**',
      'out/**',
      // Vite / TanStack Start build output and generated route tree.
      '.output/**',
      '.nitro/**',
      '.tanstack/**',
      'app/routeTree.gen.ts',
      'public/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
]

export default config
