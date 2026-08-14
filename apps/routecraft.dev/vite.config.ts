import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
// Extension included deliberately: Vite's native config loader does not resolve
// extensionless relative imports, and warns that it will become the default. On
// a runner it does not fall back the way it does locally, and the config fails
// to load with a bare resolver error that names nothing.
import {
  remarkDocsHeadings,
  remarkUnwrapImages,
} from './app/lib/mdx-plugins.ts'

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
    // Unreadable is fatal rather than empty: swallowing it publishes a build
    // that succeeded with a whole channel missing from the prerender list.
    const entries = readdirSync(current, { withFileTypes: true })

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

/**
 * The MDX plugin, taught to leave `?raw` imports alone.
 *
 * It runs before Vite's own handling, so without this it also claims imports
 * that asked for the file's text: the blog metadata, the search index and the
 * copy-page markdown all read their sources raw and would receive a compiled
 * module instead of a string.
 */
function rawAwareMdx(): Plugin {
  const plugin = mdx({
    providerImportSource: '@mdx-js/react',
    remarkPlugins: [
      remarkFrontmatter,
      // Markdoc parsed GFM natively; MDX does not, so without this every table
      // in the reference docs renders as paragraphs of pipes.
      remarkGfm,
      [remarkMdxFrontmatter, { name: 'frontmatter' }],
      remarkDocsHeadings,
      remarkUnwrapImages,
    ],
  })

  const transform = plugin.transform as unknown as
    | ((code: string, id: string) => unknown)
    | { handler: (code: string, id: string) => unknown }
    | undefined

  return {
    ...plugin,
    enforce: 'pre',
    transform(this: unknown, code: string, id: string) {
      if (id.includes('?raw')) return null
      const handler =
        typeof transform === 'function' ? transform : transform?.handler
      return handler?.call(this, code, id)
    },
  } as Plugin
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
        '/blog/',
        '/changelog/',
        '/cheat-sheet/',
        ...contentRoutes('docs', '/docs'),
        ...contentRoutes('docs-next', '/docs/next'),
        ...contentRoutes('blog', '/blog'),
      ].map((path) => ({ path })),
    }),
    viteReact(),
    nitro({ preset: 'bun' }),
    tailwindcss(),
    rawAwareMdx(),
  ],
})
