// IMPORTANT: package.json `dev` and `build` scripts pass `--webpack`. The
// markdoc loader pipeline below (withMarkdoc + withSearch + withDocsMarkdown)
// hooks `nextConfig.webpack(...)` and is webpack-only. Turbopack (the Next 16+
// default) silently skips these hooks, which produces a "successful" build
// where every `.md` page renders empty. Do not drop `--webpack` until the
// markdoc pipeline (or a Turbopack equivalent) supports both.
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

// nextjsExports: [] disables the auto-emitted `metadata` / `revalidate`
// re-exports from `@markdoc/next.js`. No page sets `nextjs:` frontmatter,
// so they were always `undefined`, and Next 16 rejects exporting `metadata`
// from any module its RSC graph classifies as client (which the markdoc
// schema imports trigger via tags like `<CodeTabs>` and `<Callout>`).
export default withDocsMarkdown(
  withSearch(
    withMarkdoc({ schemaPath: './src/markdoc', nextjsExports: [] })(nextConfig),
  ),
)
