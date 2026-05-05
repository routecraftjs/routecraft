import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: ['.next/**', 'out/**', 'public/raw/**'],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
]

export default config
