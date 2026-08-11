import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import { remarkDocsHeadings } from './app/lib/mdx-plugins'

const appDirectory = fileURLToPath(new URL('./app', import.meta.url))

/**
 * Every authored page below a content root, as a trailing-slash URL.
 *
 * The prerender list is derived from the content tree rather than crawled, so a
 * page nothing links to is still published and a page that cannot render fails
 * the build instead of disappearing. Deep links are pinned outside this
 * repository, so the trailing-slash form is part of the contract.
 */
function contentRoutes(directory: string, prefix: string): string[] {
  const routes: string[] = []

  function walk(current: string, urlPath: string): void {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name), `${urlPath}/${entry.name}`)
      } else if (entry.name === 'index.mdx') {
        routes.push(`${urlPath}/`)
      }
    }
  }

  walk(join(appDirectory, 'content', directory), prefix)
  return routes
}

export default defineConfig({
  resolve: {
    alias: {
      '@': appDirectory,
    },
  },
  plugins: [
    tanstackStart({
      srcDirectory: 'app',
      prerender: { enabled: true, crawlLinks: false },
      pages: [
        '/',
        ...contentRoutes('docs', '/docs'),
        ...contentRoutes('docs-next', '/docs/next'),
      ].map((path) => ({ path })),
    }),
    viteReact(),
    nitro({ preset: 'bun' }),
    tailwindcss(),
    {
      enforce: 'pre',
      ...mdx({
        providerImportSource: '@mdx-js/react',
        remarkPlugins: [
          remarkFrontmatter,
          [remarkMdxFrontmatter, { name: 'frontmatter' }],
          remarkDocsHeadings,
        ],
      }),
    },
  ],
})
