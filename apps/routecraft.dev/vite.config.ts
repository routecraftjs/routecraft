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
import { prerenderPages } from './scripts/prerender-pages.ts'

const appDirectory = fileURLToPath(new URL('./app', import.meta.url))

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
      // failOnError, because the default is to log a page that would not render
      // and carry on. Inside the release image every request was refused, the
      // prerenderer wrote nothing, and the build still exited 0 and shipped a
      // container with no page HTML in it.
      prerender: { enabled: true, crawlLinks: false, failOnError: true },
      pages: prerenderPages(appDirectory).map((path) => ({ path })),
    }),
    viteReact(),
    nitro({ preset: 'bun' }),
    tailwindcss(),
    rawAwareMdx(),
  ],
})
