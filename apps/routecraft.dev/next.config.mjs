import withMarkdoc from '@markdoc/next.js'

import withDocsMarkdown from './src/markdoc/docs-markdown.mjs'
import withSearch from './src/markdoc/search.mjs'

const normalizePath = (value) => {
  if (!value) return ''
  if (value === '/') return ''
  return value.startsWith('/') ? value : `/${value}`
}

const basePath = normalizePath(process.env.NEXT_PUBLIC_BASE_PATH)
const assetPrefixEnv = normalizePath(process.env.NEXT_PUBLIC_ASSET_PREFIX)
const assetPrefix = assetPrefixEnv || basePath || undefined

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  assetPrefix,
  trailingSlash: true,
  pageExtensions: ['js', 'jsx', 'md', 'ts', 'tsx'],
  output: 'export',
  images: {
    unoptimized: true,
  },
}

export default withDocsMarkdown(
  withSearch(withMarkdoc({ schemaPath: './src/markdoc' })(nextConfig)),
)
